// Admin match invalidation (INVALIDATE_MATCH_PLAN): a super-admin invalidates a
// wrongly-settled match and every settled match after it is replayed from its
// STORED score so the running ratings stay correct and zero-sum.
//
// Module-level tests drive invalidateMatch directly (the replay math); the HTTP
// block mounts the admin router to cover the super-admin gate and the matches
// list, the way routes.admin.test.js does.

import { test, expect, beforeEach, afterAll } from 'bun:test';

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');

process.env.DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'coffee-invalidate-test-'));
process.env.JWT_SECRET = 'test-secret';

const db = require('./db');
require('./migrate')(db);

const { settleMatch, invalidateMatch, MAX_INVALIDATE_DEPTH } = require('./competitions');
const { BASE_RATING, K_BY_MODE, settleFfa, marginScaleFor } = require('./competition-core');

const app = express();
app.use(express.json());
app.use('/api/admin', require('./routes/admin'));
app.use((err, req, res, _next) => res.status(500).json({ error: err.message }));
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
afterAll(() => server.close());

const DAY = 86400000;

beforeEach(() => {
  db.exec(`
    DELETE FROM match_participants;
    DELETE FROM matches;
    DELETE FROM group_members;
    DELETE FROM competition_groups;
    DELETE FROM user_ratings;
    DELETE FROM coffee_entries;
    DELETE FROM notifications;
    DELETE FROM users;
  `);
});

function makeUser(username, { tier } = {}) {
  const id = randomUUID();
  const isAdmin = tier === 'super' || tier === 'admin' ? 1 : 0;
  const isSuper = tier === 'super' ? 1 : 0;
  db.prepare('INSERT INTO users (id, username, password_hash, created_at, timezone, is_admin, is_super_admin) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, username, 'x', Date.now(), 'UTC', isAdmin, isSuper);
  return { id, username, token: jwt.sign({ id, username }, process.env.JWT_SECRET, { expiresIn: '1h' }) };
}

function makeGroup(userIds) {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO competition_groups (id, name, description, owner_id, timezone, is_public, join_code, created_at)
    VALUES (?, ?, NULL, ?, 'UTC', 1, ?, ?)
  `).run(id, `g-${id.slice(0, 8)}`, userIds[0] ?? null, id.slice(0, 6).toUpperCase(), Date.now());
  for (const u of userIds) {
    db.prepare('INSERT INTO group_members (id, group_id, user_id, joined_at) VALUES (?, ?, ?, ?)')
      .run(randomUUID(), id, u, Date.now());
  }
  return db.prepare('SELECT * FROM competition_groups WHERE id = ?').get(id);
}

function logCoffee(userId, at, mg, coffeeId = 'espresso') {
  db.prepare(`
    INSERT INTO coffee_entries (id, user_id, coffee_id, caffeine_mg, logged_at, created_at, is_public)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `).run(randomUUID(), userId, coffeeId, mg, at, at);
}

// Open a pending match over a past window, log each player's caffeine so the
// scores differ, and settle it at `settledAt`. Returns the settled row.
function runMatch(group, scores, settledAt, mode = 'ondemand') {
  const start = settledAt - DAY;
  const end = settledAt - 1;
  const id = randomUUID();
  db.prepare(`
    INSERT INTO matches (id, group_id, mode, period_key, title, creator_id,
                         scope_start, scope_end, state, k_factor, team_size, created_at)
    VALUES (?, ?, ?, NULL, ?, NULL, ?, ?, 'pending', ?, NULL, ?)
  `).run(id, group.id, mode, `match ${settledAt}`, start, end, K_BY_MODE[mode], start);
  Object.keys(scores).forEach((u, i) => {
    db.prepare('INSERT INTO match_participants (id, match_id, user_id, side, joined_at) VALUES (?, ?, ?, NULL, ?)')
      .run(randomUUID(), id, u, start + i);
    logCoffee(u, start + 1000, scores[u]);
  });
  settleMatch(db.prepare('SELECT * FROM matches WHERE id = ?').get(id), settledAt);
  return db.prepare('SELECT * FROM matches WHERE id = ?').get(id);
}

const matchById = (id) => db.prepare('SELECT * FROM matches WHERE id = ?').get(id);
const parts = (id) => db.prepare('SELECT * FROM match_participants WHERE match_id = ?').all(id);
const ratingSum = () => db.prepare('SELECT COALESCE(SUM(rating), 0) AS s FROM user_ratings').get().s;
const recomputedFor = (userId) =>
  db.prepare("SELECT * FROM notifications WHERE user_id = ? AND type = 'match_recomputed'").all(userId)
    .map((r) => ({ ...r, payload: JSON.parse(r.payload) }));

// A fresh group of two whose three matches (t1<t2<t3) are all settled, so t1 has
// two settled matches after it. Returns everything a test needs to assert on.
function threeSettled() {
  const a = makeUser('a');
  const b = makeUser('b');
  const group = makeGroup([a.id, b.id]);
  const t1 = Date.parse('2026-07-26T10:00:00Z');
  const m1 = runMatch(group, { [a.id]: 200, [b.id]: 20 }, t1);
  const m2 = runMatch(group, { [a.id]: 30, [b.id]: 180 }, t1 + DAY);
  const m3 = runMatch(group, { [a.id]: 150, [b.id]: 90 }, t1 + 2 * DAY);
  return { a, b, group, m1, m2, m3 };
}

// ── replay correctness ────────────────────────────────────────────────────────

test('invalidation keeps every user_ratings row zero-sum', () => {
  const { a, b, m1 } = threeSettled();
  expect(ratingSum()).toBe(2 * BASE_RATING); // zero-sum before

  invalidateMatch(m1.id, Date.now());

  expect(ratingSum()).toBe(2 * BASE_RATING); // …and after
  // Both players' final rating is a whole number that still traces to a settlement.
  for (const u of [a.id, b.id]) {
    expect(Number.isInteger(db.prepare('SELECT rating FROM user_ratings WHERE user_id = ?').get(u).rating)).toBe(true);
  }
});

test('the invalidated match moves no rating — all its deltas are zero', () => {
  const { m1 } = threeSettled();
  invalidateMatch(m1.id, Date.now());

  expect(matchById(m1.id).state).toBe('invalidated');
  for (const p of parts(m1.id)) {
    expect(p.delta).toBe(0);
    expect(p.rating_after).toBe(p.rating_before); // row kept for audit, rating unchanged
  }
});

test('a later match sharing no player with the target is a no-op — not stamped, not notified', () => {
  // Group 1 owns the target; group 2's match settles after it but shares no
  // player, so the replay reproduces its identical ledger. It must not be marked
  // recomputed and its players must get no "your rating changed" notification.
  const a = makeUser('a');
  const b = makeUser('b');
  const c = makeUser('c');
  const d = makeUser('d');
  const g1 = makeGroup([a.id, b.id]);
  const g2 = makeGroup([c.id, d.id]);
  const t0 = Date.parse('2026-07-26T10:00:00Z');
  const target = runMatch(g1, { [a.id]: 200, [b.id]: 20 }, t0);
  const other = runMatch(g2, { [c.id]: 150, [d.id]: 90 }, t0 + DAY);

  const otherBefore = parts(other.id).map((p) => ({ user_id: p.user_id, delta: p.delta, rating_after: p.rating_after }));

  const summary = invalidateMatch(target.id, 999);

  // The unrelated match is untouched: same ledger, no recompute stamp.
  const otherRow = matchById(other.id);
  expect(otherRow.state).toBe('settled');
  expect(otherRow.recomputed_at).toBeNull();
  for (const p of parts(other.id)) {
    const was = otherBefore.find((o) => o.user_id === p.user_id);
    expect(p.delta).toBe(was.delta);
    expect(p.rating_after).toBe(was.rating_after);
  }
  // Its players hear nothing; only the target's roster is notified.
  expect(recomputedFor(c.id).length).toBe(0);
  expect(recomputedFor(d.id).length).toBe(0);
  expect(recomputedFor(a.id).length).toBe(1);
  // Summary counts only matches actually rewritten (none here after the target).
  expect(summary.matches_recomputed).toBe(0);
  expect(summary.participants_notified).toBe(2); // a + b, the target roster
});

test('matches after the target are re-settled from their stored score, stamped recomputed', () => {
  const { m1, m2, m3 } = threeSettled();

  // The stored scores the replay must reuse (never re-derived from entries).
  const scoresBefore = new Map(parts(m2.id).map((p) => [p.user_id, p.score]));

  invalidateMatch(m1.id, 999);

  for (const id of [m2.id, m3.id]) {
    const row = matchById(id);
    expect(row.state).toBe('settled');           // recomputed matches stay settled
    expect(row.recomputed_at).toBe(999);
    expect(row.recompute_reason).toBe('a match was invalidated');
    // deltas still zero-sum and whole after the rewrite
    const ps = parts(id);
    expect(ps.reduce((s, p) => s + p.delta, 0)).toBe(0);
    for (const p of ps) expect(Number.isInteger(p.delta)).toBe(true);
  }
  // Stored scores are untouched by the replay.
  for (const p of parts(m2.id)) expect(p.score).toBe(scoresBefore.get(p.user_id));

  // m2 now starts from the base rating (m1 no longer moves anyone) and its deltas
  // match settleFfa run on the STORED scores at base — the definition of "reuse
  // the stored score, never re-read coffee_entries".
  const m2parts = parts(m2.id);
  const players = m2parts
    .slice()
    .sort((x, y) => x.joined_at - y.joined_at)
    .map((p) => ({ userId: p.user_id, rating: BASE_RATING, score: p.score }));
  const expected = settleFfa(players, matchById(m2.id).k_factor, marginScaleFor(m2.scope_start, m2.scope_end));
  for (const e of expected) {
    expect(m2parts.find((p) => p.user_id === e.userId).delta).toBe(e.delta);
    expect(m2parts.find((p) => p.user_id === e.userId).rating_before).toBe(BASE_RATING);
  }
});

test('replay ignores coffee_entries entirely — wiping them changes nothing', () => {
  const { m1, m2 } = threeSettled();
  const deltasBefore = parts(m2.id).map((p) => p.delta);
  expect(deltasBefore.some((d) => d !== 0)).toBe(true); // the scores really differ

  db.exec('DELETE FROM coffee_entries;'); // if the replay re-scored, m2 would flatten to 0-0

  invalidateMatch(m1.id, Date.now());

  const after = parts(m2.id);
  expect(after.reduce((s, p) => s + p.delta, 0)).toBe(0);
  expect(after.some((p) => p.delta !== 0)).toBe(true); // still graded on the stored scores
});

test('a pending match is untouched by the replay and settles later on the corrected rating', () => {
  const { a, b, group, m1 } = threeSettled();

  // A future pending match the two are on — no rating written yet.
  const start = Date.parse('2026-08-01T00:00:00Z');
  const end = start + DAY - 1;
  const pendingId = randomUUID();
  db.prepare(`
    INSERT INTO matches (id, group_id, mode, period_key, title, creator_id,
                         scope_start, scope_end, state, k_factor, team_size, created_at)
    VALUES (?, ?, 'ondemand', NULL, NULL, NULL, ?, ?, 'pending', ?, NULL, ?)
  `).run(pendingId, group.id, start, end, K_BY_MODE.ondemand, start);
  for (const [i, u] of [a.id, b.id].entries()) {
    db.prepare('INSERT INTO match_participants (id, match_id, user_id, side, joined_at) VALUES (?, ?, ?, NULL, ?)')
      .run(randomUUID(), pendingId, u, start + i);
  }

  invalidateMatch(m1.id, Date.now());
  // The pending match was not written to by the replay: no ratings on its rows.
  for (const p of parts(pendingId)) expect(p.rating_before).toBeNull();

  // When it settles it picks up the CORRECTED running rating.
  const corrected = db.prepare('SELECT rating FROM user_ratings WHERE user_id = ?').get(a.id).rating;
  logCoffee(a.id, start + 1000, 150);
  settleMatch(matchById(pendingId), end + 1);
  const aRow = parts(pendingId).find((p) => p.user_id === a.id);
  expect(aRow.rating_before).toBe(corrected);
});

test('the MATCH_RECOMPUTED payload carries old vs new rating and delta', () => {
  const { a, m1, m2 } = threeSettled();

  const oldM2 = parts(m2.id).find((p) => p.user_id === a.id);
  invalidateMatch(m1.id, Date.now());
  const newM2 = parts(m2.id).find((p) => p.user_id === a.id);

  const notes = recomputedFor(a.id);
  // One per match the replay touched: the invalidated m1 + m2 + m3.
  expect(notes.length).toBe(3);

  const p2 = notes.find((n) => n.payload.match_id === m2.id).payload;
  expect(p2.invalidated).toBe(false);
  expect(p2.invalidated_match_id).toBe(m1.id);
  expect(p2.old_rating).toBe(oldM2.rating_after);
  expect(p2.new_rating).toBe(newM2.rating_after);
  expect(p2.old_delta).toBe(oldM2.delta);
  expect(p2.new_delta).toBe(newM2.delta);
  expect(p2.group_name).toBeTruthy(); // self-contained: name embedded, not just id

  const p1 = notes.find((n) => n.payload.match_id === m1.id).payload;
  expect(p1.invalidated).toBe(true);
  expect(p1.new_delta).toBe(0); // the invalidated match moved nothing
});

// ── depth cap ─────────────────────────────────────────────────────────────────

test('the target is rejected when more than the cap of settled matches follow it', () => {
  const a = makeUser('a');
  const b = makeUser('b');
  const group = makeGroup([a.id, b.id]);
  const t0 = Date.parse('2026-07-26T10:00:00Z');
  // Five settled matches: m[0] has four after it (> cap of 3).
  const ms = [];
  for (let i = 0; i < MAX_INVALIDATE_DEPTH + 2; i++) {
    ms.push(runMatch(group, { [a.id]: 200 - i * 10, [b.id]: 20 + i * 10 }, t0 + i * DAY));
  }
  expect(() => invalidateMatch(ms[0].id, Date.now())).toThrow(/settled after this one/);
  // Nothing changed — still all settled.
  for (const m of ms) expect(matchById(m.id).state).toBe('settled');
});

test('the target is accepted at exactly the cap of settled matches after it', () => {
  const a = makeUser('a');
  const b = makeUser('b');
  const group = makeGroup([a.id, b.id]);
  const t0 = Date.parse('2026-07-26T10:00:00Z');
  const ms = [];
  for (let i = 0; i < MAX_INVALIDATE_DEPTH + 2; i++) {
    ms.push(runMatch(group, { [a.id]: 200 - i * 10, [b.id]: 20 + i * 10 }, t0 + i * DAY));
  }
  // ms[1] has exactly MAX_INVALIDATE_DEPTH matches after it.
  expect(() => invalidateMatch(ms[1].id, Date.now())).not.toThrow();
  expect(matchById(ms[1].id).state).toBe('invalidated');
  expect(ratingSum()).toBe(2 * BASE_RATING);
});

test('only a settled match can be invalidated', () => {
  const a = makeUser('a');
  const b = makeUser('b');
  const group = makeGroup([a.id, b.id]);
  const m1 = runMatch(group, { [a.id]: 200, [b.id]: 20 }, Date.parse('2026-07-26T10:00:00Z'));
  invalidateMatch(m1.id, Date.now());
  // Re-invalidating an already-invalidated match is out of scope (one-way).
  expect(() => invalidateMatch(m1.id, Date.now())).toThrow(/settled/);
  expect(() => invalidateMatch(randomUUID(), Date.now())).toThrow(/not found/);
});

// ── HTTP: super-admin gate + matches list ─────────────────────────────────────

function http(method, pathname, token, body) {
  return fetch(`${base}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('a regular admin (not super) is forbidden from invalidating', async () => {
  const admin = makeUser('admin', { tier: 'admin' });
  const a = makeUser('a');
  const b = makeUser('b');
  const group = makeGroup([a.id, b.id]);
  const m1 = runMatch(group, { [a.id]: 200, [b.id]: 20 }, Date.parse('2026-07-26T10:00:00Z'));

  const res = await http('POST', `/api/admin/matches/${m1.id}/invalidate`, admin.token);
  expect(res.status).toBe(403);
  expect(matchById(m1.id).state).toBe('settled'); // untouched
});

test('a super-admin can invalidate over HTTP and gets a replay summary', async () => {
  const boss = makeUser('boss', { tier: 'super' });
  const { m1, m2, m3 } = threeSettled();

  const res = await http('POST', `/api/admin/matches/${m1.id}/invalidate`, boss.token);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.invalidated).toBe(m1.id);
  expect(body.matches_recomputed).toBe(2); // m2 + m3
  expect(body.participants_notified).toBe(6); // 2 players × 3 matches
  expect(matchById(m2.id).recomputed_at).not.toBeNull();
  expect(matchById(m3.id).recomputed_at).not.toBeNull();
});

test('GET /admin/matches lists finished matches with an invalidatable flag', async () => {
  const boss = makeUser('boss', { tier: 'super' });
  const a = makeUser('a');
  const b = makeUser('b');
  const group = makeGroup([a.id, b.id]);
  const t0 = Date.parse('2026-07-26T10:00:00Z');
  const ms = [];
  for (let i = 0; i < MAX_INVALIDATE_DEPTH + 2; i++) {
    ms.push(runMatch(group, { [a.id]: 200 - i * 10, [b.id]: 20 + i * 10 }, t0 + i * DAY));
  }

  const res = await http('GET', '/api/admin/matches', boss.token);
  expect(res.status).toBe(200);
  const { matches, max_depth } = await res.json();
  expect(max_depth).toBe(MAX_INVALIDATE_DEPTH);
  expect(matches.length).toBe(ms.length);
  // Newest-ending first.
  for (let i = 1; i < matches.length; i++) {
    expect(matches[i - 1].scope_end).toBeGreaterThanOrEqual(matches[i].scope_end);
  }
  const byId = new Map(matches.map((m) => [m.id, m]));
  expect(byId.get(ms[0].id).invalidatable).toBe(false); // 4 settled after → over cap
  expect(byId.get(ms[1].id).invalidatable).toBe(true);  // exactly the cap
  expect(byId.get(ms.at(-1).id).invalidatable).toBe(true); // newest → 0 after
});
