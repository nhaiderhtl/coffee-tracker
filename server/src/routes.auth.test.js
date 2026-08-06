import { test, expect, beforeEach, afterAll, describe } from 'bun:test';

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

process.env.DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'coffee-auth-test-'));
process.env.JWT_SECRET = 'test-secret';

const db = require('./db');
require('./migrate')(db);

const app = express();
app.use(express.json());
app.use('/api/auth', require('./routes/auth'));
app.use((err, req, res, _next) => res.status(500).json({ error: err.message }));

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

afterAll(() => server.close());

beforeEach(() => {
  db.exec('DELETE FROM user_combos; DELETE FROM user_streaks; DELETE FROM coffee_entries; DELETE FROM users;');
});

// routes/auth.js is the front door — register, login, JWT issuance, password
// rotation and account deletion — and had no test of its own. What existed
// touched only PATCH /me/photo (routes.images.test.js) and the auto-join prefs
// (routes.competitions.test.js).
//
// NOTE ON THE RATE LIMITER: authLimiter is 30 requests / 15 min / IP, created
// at module scope. Every request here comes from 127.0.0.1, so the budget is
// shared across this whole file. Register/login calls are kept well under 30;
// the limiter's own test re-requires the router to get a fresh instance rather
// than spending the shared budget. Add calls here with that in mind.

async function post(url, body, token) {
  const res = await fetch(base + url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function patch(url, body, token) {
  const res = await fetch(base + url, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function get(url, token) {
  const res = await fetch(base + url, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function del(url, token) {
  const res = await fetch(base + url, {
    method: 'DELETE',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** Seed a user straight into the DB — no HTTP, so it costs no rate-limit budget. */
function seedUser(username, password, extra = {}) {
  const id = require('crypto').randomUUID();
  db.prepare('INSERT INTO users (id, username, password_hash, timezone, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, username, bcrypt.hashSync(password, 4), extra.timezone ?? 'UTC', Date.now());
  db.prepare('INSERT INTO user_streaks (user_id) VALUES (?)').run(id);
  db.prepare('INSERT INTO user_combos (user_id) VALUES (?)').run(id);
  return { id, username, token: jwt.sign({ id, username }, process.env.JWT_SECRET, { expiresIn: '1h' }) };
}

describe('POST /register', () => {
  test('creates the user and returns a usable token', async () => {
    const { status, body } = await post('/api/auth/register', { username: 'barista', password: 'hunter2' });
    expect(status).toBe(200);
    expect(body.user).toMatchObject({ username: 'barista' });
    expect(typeof body.token).toBe('string');

    const decoded = jwt.verify(body.token, process.env.JWT_SECRET);
    expect(decoded).toMatchObject({ id: body.user.id, username: 'barista' });
  });

  test('seeds the streak and combo rows the rest of the app assumes exist', async () => {
    const { body } = await post('/api/auth/register', { username: 'seeded', password: 'p' });
    expect(db.prepare('SELECT 1 FROM user_streaks WHERE user_id = ?').get(body.user.id)).toBeTruthy();
    expect(db.prepare('SELECT 1 FROM user_combos WHERE user_id = ?').get(body.user.id)).toBeTruthy();
  });

  test('never returns the password hash, and stores it hashed', async () => {
    const { body } = await post('/api/auth/register', { username: 'secretive', password: 'plaintext' });
    expect(body.user.password_hash).toBeUndefined();

    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(body.user.id);
    expect(row.password_hash).not.toBe('plaintext');
    expect(bcrypt.compareSync('plaintext', row.password_hash)).toBe(true);
  });

  test('rejects a duplicate username', async () => {
    seedUser('taken', 'x');
    const { status, body } = await post('/api/auth/register', { username: 'taken', password: 'y' });
    expect(status).toBe(409);
    expect(body.error).toBe('Username already taken');
  });

  test('rejects missing fields and bad usernames', async () => {
    // Grouped into one test on purpose — each of these is a rate-limited call.
    for (const payload of [
      {},
      { username: 'nopass' },
      { password: 'nouser' },
      { username: 'a', password: 'p' },                    // too short
      { username: 'a'.repeat(21), password: 'p' },          // too long
      { username: 'has space', password: 'p' },             // illegal char
      { username: 'yes!', password: 'p' },
    ]) {
      const { status } = await post('/api/auth/register', payload);
      expect(status).toBe(400);
    }
  });

  test('rejects a password over 72 characters or of the wrong type', async () => {
    // bcrypt silently ignores everything past 72 bytes, so accepting a longer
    // one would mean two different passwords opening the same account.
    expect((await post('/api/auth/register', { username: 'longpw', password: 'x'.repeat(73) })).status).toBe(400);
    expect((await post('/api/auth/register', { username: 'numpw', password: 12345 })).status).toBe(400);
  });

  test('accepts a valid IANA timezone and falls back to UTC otherwise', async () => {
    const ok = await post('/api/auth/register', { username: 'traveller', password: 'p', timezone: 'Asia/Kathmandu' });
    expect(ok.body.user.timezone).toBe('Asia/Kathmandu');

    // An abbreviation is not a zone — it must not reach storage.
    const bad = await post('/api/auth/register', { username: 'confused', password: 'p', timezone: 'CEST' });
    expect(bad.body.user.timezone).toBe('UTC');
  });
});

describe('POST /login', () => {
  test('accepts the right password and issues a token', async () => {
    seedUser('regular', 'correct-horse');
    const { status, body } = await post('/api/auth/login', { username: 'regular', password: 'correct-horse' });
    expect(status).toBe(200);
    expect(body.user.username).toBe('regular');
    expect(jwt.verify(body.token, process.env.JWT_SECRET).username).toBe('regular');
  });

  test('never leaks the hash', async () => {
    seedUser('regular', 'pw');
    const { body } = await post('/api/auth/login', { username: 'regular', password: 'pw' });
    expect(body.user.password_hash).toBeUndefined();
  });

  test('rejects a wrong password and an unknown user identically', async () => {
    seedUser('regular', 'pw');
    const wrong = await post('/api/auth/login', { username: 'regular', password: 'nope' });
    const missing = await post('/api/auth/login', { username: 'ghost', password: 'nope' });

    expect(wrong.status).toBe(401);
    expect(missing.status).toBe(401);
    // Same message either way — a different one would confirm which usernames
    // exist.
    expect(wrong.body.error).toBe(missing.body.error);
  });

  test('rejects missing or non-string credentials', async () => {
    for (const payload of [{}, { username: 'a' }, { password: 'b' }, { username: 1, password: 2 }]) {
      expect((await post('/api/auth/login', payload)).status).toBe(400);
    }
  });

  test('refreshes the stored timezone when the client sends a new valid one', async () => {
    const u = seedUser('mover', 'pw', { timezone: 'Europe/Vienna' });
    const { body } = await post('/api/auth/login', {
      username: 'mover', password: 'pw', timezone: 'America/New_York',
    });
    expect(body.user.timezone).toBe('America/New_York');
    expect(db.prepare('SELECT timezone FROM users WHERE id = ?').get(u.id).timezone).toBe('America/New_York');
  });

  test('ignores a garbage timezone rather than overwriting a good one', async () => {
    const u = seedUser('mover', 'pw', { timezone: 'Europe/Vienna' });
    const { body } = await post('/api/auth/login', { username: 'mover', password: 'pw', timezone: 'CET' });
    expect(body.user.timezone).toBe('Europe/Vienna');
    expect(db.prepare('SELECT timezone FROM users WHERE id = ?').get(u.id).timezone).toBe('Europe/Vienna');
  });
});

describe('GET /me', () => {
  test('returns the caller', async () => {
    const u = seedUser('me-user', 'pw');
    const { status, body } = await get('/api/auth/me', u.token);
    expect(status).toBe(200);
    expect(body).toMatchObject({ id: u.id, username: 'me-user' });
    expect(body.password_hash).toBeUndefined();
  });

  test('401s without a usable Authorization header', async () => {
    expect((await get('/api/auth/me')).status).toBe(401);
    const res = await fetch(base + '/api/auth/me', { headers: { authorization: 'Basic abc' } });
    expect(res.status).toBe(401);
    const bare = await fetch(base + '/api/auth/me', { headers: { authorization: 'Bearer   ' } });
    expect(bare.status).toBe(401);
  });

  test('401s on a token signed with the wrong secret', async () => {
    const forged = jwt.sign({ id: 'x', username: 'x' }, 'not-the-secret');
    expect((await get('/api/auth/me', forged)).status).toBe(401);
  });

  test('401s on an expired token', async () => {
    const u = seedUser('expired', 'pw');
    const stale = jwt.sign({ id: u.id, username: u.username }, process.env.JWT_SECRET, { expiresIn: -10 });
    expect((await get('/api/auth/me', stale)).status).toBe(401);
  });

  test('401s on an alg:none token', async () => {
    // requireAuth pins algorithms to HS256 precisely so this downgrade fails.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ id: 'x', username: 'x' })).toString('base64url');
    expect((await get('/api/auth/me', `${header}.${payload}.`)).status).toBe(401);
  });

  test('a valid token whose user is gone is a dead session, not a 404', async () => {
    const u = seedUser('vanishing', 'pw');
    db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
    const { status } = await get('/api/auth/me', u.token);
    expect(status).toBe(401); // so the client logs out instead of retrying
  });
});

describe('PATCH /me', () => {
  test('renames the user', async () => {
    const u = seedUser('oldname', 'pw');
    const { status, body } = await patch('/api/auth/me', { username: 'newname' }, u.token);
    expect(status).toBe(200);
    expect(body.username).toBe('newname');
  });

  test('rejects an invalid username and a taken one', async () => {
    const u = seedUser('mine', 'pw');
    seedUser('theirs', 'pw');
    expect((await patch('/api/auth/me', { username: 'no spaces' }, u.token)).status).toBe(400);
    expect((await patch('/api/auth/me', { username: 'theirs' }, u.token)).status).toBe(409);
  });

  test('rejects an oversized avatar', async () => {
    const u = seedUser('avatar-user', 'pw');
    expect((await patch('/api/auth/me', { avatar: 'x'.repeat(17) }, u.token)).status).toBe(400);
    expect((await patch('/api/auth/me', { avatar: '☕' }, u.token)).status).toBe(200);
  });

  test('auto-join flags must be real booleans', async () => {
    // A silent coercion is the difference between being entered into every
    // daily match and none of them.
    const u = seedUser('joiner', 'pw');
    expect((await patch('/api/auth/me', { auto_join_daily: 'yes' }, u.token)).status).toBe(400);
    expect((await patch('/api/auth/me', { auto_join_weekly: 1 }, u.token)).status).toBe(400);

    const ok = await patch('/api/auth/me', { auto_join_daily: true }, u.token);
    expect(ok.body.auto_join_daily).toBe(1);
  });

  test('a rejected request does not half-apply the auto-join flags', async () => {
    // The handler validates auto-join early but writes it last, precisely so a
    // later 409 cannot leave the user opted in on a request that failed.
    const u = seedUser('atomic', 'pw');
    seedUser('collide', 'pw');

    const { status } = await patch('/api/auth/me', {
      auto_join_daily: true, username: 'collide',
    }, u.token);

    expect(status).toBe(409);
    expect(db.prepare('SELECT auto_join_daily FROM users WHERE id = ?').get(u.id).auto_join_daily).toBe(0);
  });

  test('caffeine half-life: null clears, numbers clamp, junk is rejected', async () => {
    const u = seedUser('buzz', 'pw');

    // Out of range is clamped rather than rejected — the client offers a free
    // text box and a typo should give a sane curve, not an error.
    const high = await patch('/api/auth/me', { caffeine_half_life_h: 9999 }, u.token);
    expect(high.status).toBe(200);
    expect(high.body.caffeine_half_life_h).toBeLessThan(9999);
    expect(high.body.caffeine_half_life_h).toBeGreaterThan(0);

    const cleared = await patch('/api/auth/me', { caffeine_half_life_h: null }, u.token);
    expect(cleared.body.caffeine_half_life_h).toBeNull();

    for (const junk of ['five', true, [], {}]) {
      expect((await patch('/api/auth/me', { caffeine_half_life_h: junk }, u.token)).status).toBe(400);
    }
  });

  test('a NaN half-life arrives as null and clears the value', async () => {
    // Not a gap in the handler: JSON has no NaN, so JSON.stringify turns it
    // into null before it leaves the client. The `Number.isFinite` half of the
    // guard is therefore unreachable over HTTP and only defends direct callers.
    const u = seedUser('nan-user', 'pw');
    await patch('/api/auth/me', { caffeine_half_life_h: 5 }, u.token);
    const { status, body } = await patch('/api/auth/me', { caffeine_half_life_h: NaN }, u.token);
    expect(status).toBe(200);
    expect(body.caffeine_half_life_h).toBeNull();
  });

  test('timezone: a valid zone is applied, junk is silently ignored', async () => {
    const u = seedUser('tz-user', 'pw', { timezone: 'Europe/Vienna' });
    expect((await patch('/api/auth/me', { timezone: 'Asia/Kolkata' }, u.token)).body.timezone).toBe('Asia/Kolkata');
    // Silently ignored, not a 400: a stale client value must not be able to
    // clobber a good one, but it is not worth failing the whole request over.
    expect((await patch('/api/auth/me', { timezone: 'Mars/Olympus' }, u.token)).body.timezone).toBe('Asia/Kolkata');
  });

  describe('password rotation', () => {
    test('requires the current password — a stolen token is not enough', async () => {
      const u = seedUser('rotator', 'original');
      const { status, body } = await patch('/api/auth/me', { password: 'brand-new' }, u.token);
      expect(status).toBe(403);
      expect(body.error).toBe('Current password is incorrect');

      // Unchanged.
      const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(u.id);
      expect(bcrypt.compareSync('original', row.password_hash)).toBe(true);
    });

    test('rejects a wrong current password', async () => {
      const u = seedUser('rotator', 'original');
      const { status } = await patch('/api/auth/me', {
        password: 'brand-new', currentPassword: 'guess',
      }, u.token);
      expect(status).toBe(403);
    });

    test('rotates the hash when the current password is right', async () => {
      const u = seedUser('rotator', 'original');
      const { status } = await patch('/api/auth/me', {
        password: 'brand-new', currentPassword: 'original',
      }, u.token);
      expect(status).toBe(200);

      const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(u.id);
      expect(bcrypt.compareSync('brand-new', row.password_hash)).toBe(true);
      expect(bcrypt.compareSync('original', row.password_hash)).toBe(false);
    });

    test('validates the new password before checking the current one', async () => {
      const u = seedUser('rotator', 'original');
      for (const bad of ['', 'x'.repeat(73), 42, null]) {
        const { status } = await patch('/api/auth/me', {
          password: bad, currentPassword: 'original',
        }, u.token);
        // '' and null are falsy but `password !== undefined` still enters the
        // branch, so these are 400s from isValidPassword, not silent no-ops.
        expect(status).toBe(400);
      }
    });
  });
});

describe('DELETE /me', () => {
  test('removes the account and invalidates the session', async () => {
    const u = seedUser('doomed', 'pw');
    const res = await fetch(base + '/api/auth/me', {
      method: 'DELETE', headers: { authorization: `Bearer ${u.token}` },
    });
    expect(res.status).toBe(204);

    // bun:sqlite's .get() yields null (not undefined) when nothing matches.
    expect(db.prepare('SELECT 1 FROM users WHERE id = ?').get(u.id)).toBeNull();
    // The token is still cryptographically valid, but the user is gone.
    expect((await get('/api/auth/me', u.token)).status).toBe(401);
  });

  test('cascades the user rows', async () => {
    const u = seedUser('cascade', 'pw');
    await del('/api/auth/me', u.token);
    expect(db.prepare('SELECT 1 FROM user_streaks WHERE user_id = ?').get(u.id)).toBeNull();
    expect(db.prepare('SELECT 1 FROM user_combos WHERE user_id = ?').get(u.id)).toBeNull();
  });

  test('requires auth', async () => {
    expect((await del('/api/auth/me')).status).toBe(401);
  });
});

describe('rate limiting', () => {
  // authLimiter is module-scoped, so this gets its own router instance via the
  // require cache rather than spending the budget shared by every other test
  // in this file.
  test('locks out after 30 attempts from one IP', async () => {
    delete require.cache[require.resolve('./routes/auth')];
    const freshApp = express();
    freshApp.use(express.json());
    freshApp.use('/api/auth', require('./routes/auth'));
    const freshServer = freshApp.listen(0);
    const freshBase = `http://127.0.0.1:${freshServer.address().port}`;

    try {
      // An unknown username short-circuits before bcrypt, so 30 of these are
      // cheap.
      const attempt = () => fetch(`${freshBase}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'nobody', password: 'nope' }),
      });

      let last = 0;
      for (let i = 0; i < 30; i++) last = (await attempt()).status;
      expect(last).toBe(401); // still answering normally at the limit

      const blocked = await attempt();
      expect(blocked.status).toBe(429);
      expect((await blocked.json()).error).toBe('Too many attempts — try again later');
    } finally {
      freshServer.close();
      // Restore the shared instance for anything that runs after this file.
      delete require.cache[require.resolve('./routes/auth')];
    }
  });
});
