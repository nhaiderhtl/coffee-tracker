// HTTP-level tests for the competitions surface: routes/groups.js and
// routes/competitions.js.
//
// competitions.test.js covers the scheduler and settlement by calling the
// module directly. This file covers the layer above it — validation, access
// control and the join/leave state machine — because none of that is reachable
// from a function call, and it is the layer where a mistake leaks a private
// group or lets someone into another group's match.
//
// No supertest: a router mounted on a real express server and driven with
// fetch needs no dependency at all (rule 5 — Bun everywhere, nothing extra).

import { test, expect, beforeEach, afterAll } from 'bun:test';

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');

process.env.DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'coffee-routes-test-'));
process.env.JWT_SECRET = 'test-secret';

const db = require('./db');
require('./migrate')(db);

const app = express();
app.use(express.json());
app.use('/api/groups', require('./routes/groups'));
app.use('/api/competitions', require('./routes/competitions'));
// Mounted for the auto-join preference only — those two flags are the sole way
// a player lands on a recurring roster without pressing join.
app.use('/api/auth', require('./routes/auth'));
// Mirrors the production handler: a throw must surface as a 500, not a hang.
app.use((err, req, res, _next) => res.status(500).json({ error: err.message }));

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

afterAll(() => server.close());

beforeEach(() => {
  db.exec(`
    DELETE FROM match_participants;
    DELETE FROM matches;
    DELETE FROM group_members;
    DELETE FROM competition_groups;
    DELETE FROM user_ratings;
    DELETE FROM coffee_entries;
    DELETE FROM users;
  `);
});

function makeUser(username) {
  const id = randomUUID();
  db.prepare('INSERT INTO users (id, username, password_hash, created_at, timezone) VALUES (?, ?, ?, ?, ?)')
    .run(id, username, 'x', Date.now(), 'UTC');
  return { id, username, token: jwt.sign({ id, username }, process.env.JWT_SECRET, { expiresIn: '1h' }) };
}

// One request. Returns { status, body } so every assertion can check both.
async function call(user, method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(user ? { authorization: `Bearer ${user.token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() };
}

const get = (u, url) => call(u, 'GET', url);
const post = (u, url, body) => call(u, 'POST', url, body ?? {});
const patch = (u, url, body) => call(u, 'PATCH', url, body);

// Create a group as `user` and return the created group object.
async function createGroup(user, over = {}) {
  const res = await post(user, '/api/groups', { name: `G-${randomUUID().slice(0, 8)}`, ...over });
  expect(res.status).toBe(201);
  return res.body.group;
}

const HOUR = 3600000;

/* ── auth ──────────────────────────────────────────────────────────────────── */

test('every competitions endpoint refuses an unauthenticated caller', async () => {
  for (const [method, url] of [
    ['GET', '/api/groups'], ['GET', '/api/groups/mine'], ['POST', '/api/groups'],
    ['POST', '/api/groups/join'], ['POST', '/api/groups/leave'],
    ['GET', '/api/competitions'], ['GET', '/api/competitions/leaderboard'],
    ['GET', '/api/competitions/history'], ['POST', '/api/competitions'],
  ]) {
    const res = await call(null, method, url, method === 'GET' ? undefined : {});
    expect({ url, status: res.status }).toEqual({ url, status: 401 });
  }
});

/* ── group creation and validation ─────────────────────────────────────────── */

test('a group is created with the caller as owner and only member', async () => {
  const a = makeUser('a');
  const res = await post(a, '/api/groups', { name: 'Bean Team' });
  expect(res.status).toBe(201);
  expect(res.body.group.name).toBe('Bean Team');
  expect(res.body.group.owner_id).toBe(a.id);
  expect(res.body.group.member_count).toBe(1);
  expect(res.body.members.map((m) => m.id)).toEqual([a.id]);
});

test('group creation rejects a bad name, an oversized description and a bogus zone', async () => {
  const a = makeUser('a');
  expect((await post(a, '/api/groups', { name: 'x' })).status).toBe(400);
  expect((await post(a, '/api/groups', { name: '  ' })).status).toBe(400);
  expect((await post(a, '/api/groups', { name: 42 })).status).toBe(400);
  expect((await post(a, '/api/groups', { name: 'Fine', description: 'x'.repeat(201) })).status).toBe(400);
  expect((await post(a, '/api/groups', { name: 'Fine', timezone: 'Mars/Olympus' })).status).toBe(400);
  expect((await post(a, '/api/groups', { name: 'Fine', timezone: 'CEST' })).status).toBe(400);
});

test('a group with no timezone inherits the creator\'s', async () => {
  const a = makeUser('a');
  db.prepare('UPDATE users SET timezone = ? WHERE id = ?').run('Europe/Vienna', a.id);
  const group = await createGroup(a);
  expect(group.timezone).toBe('Europe/Vienna');
});

test('a duplicate group name is a 409', async () => {
  const a = makeUser('a');
  const b = makeUser('b');
  await post(a, '/api/groups', { name: 'Taken' });
  const res = await post(b, '/api/groups', { name: 'Taken' });
  expect(res.status).toBe(409);
});

test('creating a second group leaves the first', async () => {
  const a = makeUser('a');
  const first = await createGroup(a);
  const second = await createGroup(a);
  const mine = await get(a, '/api/groups/mine');
  expect(mine.body.group.id).toBe(second.id);
  // The first is gone entirely — empty, and with no settled match to preserve.
  expect(db.prepare('SELECT COUNT(*) AS c FROM competition_groups WHERE id = ?').get(first.id).c).toBe(0);
});

/* ── the join code is a secret ─────────────────────────────────────────────── */

test('the join code is returned to members and withheld from everyone else', async () => {
  const a = makeUser('a');
  const b = makeUser('b');
  const group = await createGroup(a, { is_public: true });
  expect(group.join_code).toMatch(/^[A-Z2-9]{6}$/);

  // The public directory must not hand out the key to any group.
  const dir = await get(b, '/api/groups');
  expect(dir.body.groups.some((g) => g.id === group.id)).toBe(true);
  for (const g of dir.body.groups) expect(g.join_code).toBeUndefined();

  // Nor does the detail endpoint, for a non-member.
  const detail = await get(b, `/api/groups/${group.id}`);
  expect(detail.status).toBe(200);
  expect(detail.body.is_member).toBe(false);
  expect(detail.body.group.join_code).toBeUndefined();

  // A member gets it.
  await post(b, '/api/groups/join', { group_id: group.id });
  const asMember = await get(b, `/api/groups/${group.id}`);
  expect(asMember.body.group.join_code).toBe(group.join_code);
});

test('a private group is invisible in the directory and unreachable by id', async () => {
  const a = makeUser('a');
  const b = makeUser('b');
  const group = await createGroup(a, { is_public: false });

  const dir = await get(b, '/api/groups');
  expect(dir.body.groups.some((g) => g.id === group.id)).toBe(false);

  // Knowing the id is not an invitation — both reading and joining 404.
  expect((await get(b, `/api/groups/${group.id}`)).status).toBe(404);
  expect((await post(b, '/api/groups/join', { group_id: group.id })).status).toBe(404);

  // The code is the only way in.
  expect((await post(b, '/api/groups/join', { code: group.join_code })).status).toBe(200);
  expect((await get(b, `/api/groups/${group.id}`)).body.is_member).toBe(true);
});

test('a join code is accepted case-insensitively and a wrong one is a 404', async () => {
  const a = makeUser('a');
  const b = makeUser('b');
  const group = await createGroup(a, { is_public: false });
  expect((await post(b, '/api/groups/join', { code: 'ZZZZZZ' })).status).toBe(404);
  expect((await post(b, '/api/groups/join', { code: group.join_code.toLowerCase() })).status).toBe(200);
});

test('joining with neither an id nor a code is a 400, and rejoining is a 409', async () => {
  const a = makeUser('a');
  const group = await createGroup(a);
  expect((await post(a, '/api/groups/join', {})).status).toBe(400);
  expect((await post(a, '/api/groups/join', { group_id: group.id })).status).toBe(409);
});

/* ── ownership and settings ────────────────────────────────────────────────── */

test('only the owner can PATCH a group', async () => {
  const a = makeUser('a');
  const b = makeUser('b');
  const group = await createGroup(a);
  await post(b, '/api/groups/join', { group_id: group.id });

  const asMember = await patch(b, `/api/groups/${group.id}`, { name: 'Hijacked' });
  expect(asMember.status).toBe(403);

  const asOwner = await patch(a, `/api/groups/${group.id}`, { name: 'Renamed', is_public: false });
  expect(asOwner.status).toBe(200);
  expect(asOwner.body.group.name).toBe('Renamed');
  expect(asOwner.body.group.is_public).toBe(0);
});

test('PATCH validates the same rules as create', async () => {
  const a = makeUser('a');
  const group = await createGroup(a);
  expect((await patch(a, `/api/groups/${group.id}`, { name: 'x' })).status).toBe(400);
  expect((await patch(a, `/api/groups/${group.id}`, { timezone: 'Nope/Nope' })).status).toBe(400);
  expect((await patch(a, `/api/groups/${group.id}`, { description: 'x'.repeat(201) })).status).toBe(400);
  // A no-op PATCH keeps every field as it was.
  const same = await patch(a, `/api/groups/${group.id}`, {});
  expect(same.body.group.name).toBe(group.name);
  expect(same.body.group.timezone).toBe(group.timezone);
});

test('ownership passes to the longest-standing member when the owner leaves', async () => {
  const a = makeUser('a');
  const b = makeUser('b');
  const c = makeUser('c');
  const group = await createGroup(a);
  await post(b, '/api/groups/join', { group_id: group.id });
  await post(c, '/api/groups/join', { group_id: group.id });

  expect((await post(a, '/api/groups/leave')).status).toBe(200);
  const after = await get(b, `/api/groups/${group.id}`);
  expect(after.body.group.owner_id).toBe(b.id);
  expect(after.body.group.member_count).toBe(2);
  // And the new owner can actually administer it.
  expect((await patch(b, `/api/groups/${group.id}`, { name: 'B is boss' })).status).toBe(200);
});

test('an emptied group with no settled match is deleted, not left as unadministrable litter', async () => {
  const a = makeUser('a');
  const group = await createGroup(a);
  await post(a, '/api/groups/leave');

  expect(db.prepare('SELECT COUNT(*) AS c FROM competition_groups WHERE id = ?').get(group.id).c).toBe(0);
  // The name is free again, and the directory is not showing a 0-member shell.
  expect((await post(a, '/api/groups', { name: group.name })).status).toBe(201);
});

test('an emptied group that holds a settled match survives, but stays out of the directory', async () => {
  const a = makeUser('a');
  const b = makeUser('b');
  const group = await createGroup(a);

  const matchId = randomUUID();
  db.prepare(`
    INSERT INTO matches (id, group_id, mode, period_key, title, creator_id,
                         scope_start, scope_end, state, k_factor, team_size, created_at)
    VALUES (?, ?, 'daily', '2026-07-27', NULL, NULL, 0, 1, 'settled', 8, NULL, 0)
  `).run(matchId, group.id);

  await post(a, '/api/groups/leave');
  // The row survives: it is the ledger those ratings were derived from.
  expect(db.prepare('SELECT COUNT(*) AS c FROM competition_groups WHERE id = ?').get(group.id).c).toBe(1);
  // But nobody is offered an empty group to join.
  const dir = await get(b, '/api/groups');
  expect(dir.body.groups.some((g) => g.id === group.id)).toBe(false);
});

test('leaving when not in a group is a 404', async () => {
  const a = makeUser('a');
  expect((await post(a, '/api/groups/leave')).status).toBe(404);
});

/* ── creating matches ──────────────────────────────────────────────────────── */

test('a match cannot be created without a group', async () => {
  const a = makeUser('a');
  const res = await post(a, '/api/competitions', {
    mode: '1v1', scope_start: Date.now() + HOUR, scope_end: Date.now() + 2 * HOUR,
  });
  expect(res.status).toBe(400);
});

test('match creation validates mode and window', async () => {
  const a = makeUser('a');
  await createGroup(a);
  const start = Date.now() + HOUR;
  const bad = (over) => post(a, '/api/competitions', {
    mode: '1v1', scope_start: start, scope_end: start + HOUR, ...over,
  });

  // daily/weekly belong to the ticker and are not user-creatable.
  expect((await bad({ mode: 'daily' })).status).toBe(400);
  expect((await bad({ mode: 'weekly' })).status).toBe(400);
  expect((await bad({ mode: 'nonsense' })).status).toBe(400);
  // A match starting in the past could never be joined by anyone else.
  expect((await bad({ scope_start: Date.now() - HOUR })).status).toBe(400);
  expect((await bad({ scope_start: 'soon' })).status).toBe(400);
  // Windows outside [1 minute, 90 days].
  expect((await bad({ scope_end: start + 1000 })).status).toBe(400);
  expect((await bad({ scope_end: start + 91 * 86400000 })).status).toBe(400);
  expect((await bad({ title: 'x'.repeat(61) })).status).toBe(400);
  // Team mode is gone (rating v2): it is now just another unknown mode, and the
  // team fields are ignored rather than validated.
  expect((await bad({ mode: 'team', team_size: 2, side: 'A' })).status).toBe(400);
});

test('the creator is rostered on the match they create, with no side', async () => {
  const a = makeUser('a');
  await createGroup(a);
  const start = Date.now() + HOUR;
  const res = await post(a, '/api/competitions', {
    mode: 'ondemand', scope_start: start, scope_end: start + HOUR,
  });
  expect(res.status).toBe(201);
  expect(res.body.match.participants).toHaveLength(1);
  expect(res.body.match.participants[0].user_id).toBe(a.id);
  // Sides went with team mode; the column stays for settled team matches only.
  expect(db.prepare('SELECT side, team_size FROM match_participants p JOIN matches m ON m.id = p.match_id WHERE m.id = ?')
    .get(res.body.match.id)).toEqual({ side: null, team_size: null });
});

/* ── joining and leaving a match ───────────────────────────────────────────── */

async function lobbyIn(user, over = {}) {
  const start = Date.now() + HOUR;
  const res = await post(user, '/api/competitions', {
    mode: 'ondemand', scope_start: start, scope_end: start + HOUR, ...over,
  });
  expect(res.status).toBe(201);
  return res.body.match;
}

test('a match belongs to its group — an outsider can neither read nor join it', async () => {
  const a = makeUser('a');
  const outsider = makeUser('outsider');
  await createGroup(a);
  await createGroup(outsider); // in a group, just not this one
  const match = await lobbyIn(a);

  expect((await get(outsider, `/api/competitions/${match.id}`)).status).toBe(403);
  expect((await post(outsider, `/api/competitions/${match.id}/join`)).status).toBe(403);
  // A groupless caller is refused too.
  const drifter = makeUser('drifter');
  expect((await get(drifter, `/api/competitions/${match.id}`)).status).toBe(403);
});

test('joining twice is a 409 and a 1v1 refuses a third player', async () => {
  const a = makeUser('a');
  const b = makeUser('b');
  const c = makeUser('c');
  const group = await createGroup(a);
  await post(b, '/api/groups/join', { group_id: group.id });
  await post(c, '/api/groups/join', { group_id: group.id });

  const match = await lobbyIn(a, { mode: '1v1' });
  expect((await post(a, `/api/competitions/${match.id}/join`)).status).toBe(409);
  expect((await post(b, `/api/competitions/${match.id}/join`)).status).toBe(200);
  expect((await post(c, `/api/competitions/${match.id}/join`)).status).toBe(409);
});

test('an ondemand lobby takes any number of players and ignores a side', async () => {
  const a = makeUser('a');
  const b = makeUser('b');
  const c = makeUser('c');
  const group = await createGroup(a);
  for (const u of [b, c] ) await post(u, '/api/groups/join', { group_id: group.id });

  const match = await lobbyIn(a);
  // A `side` in the body is a leftover from team mode; it is not read, and it
  // certainly does not gate the join.
  expect((await post(b, `/api/competitions/${match.id}/join`, { side: 'A' })).status).toBe(200);
  expect((await post(c, `/api/competitions/${match.id}/join`, {})).status).toBe(200);

  const rows = db.prepare('SELECT side FROM match_participants WHERE match_id = ?').all(match.id);
  expect(rows).toHaveLength(3);
  for (const r of rows) expect(r.side).toBeNull();
});

test('a weekly can still be joined on its first day, after it has started (issue #44)', async () => {
  const a = makeUser('a');
  const b = makeUser('b');
  const group = await createGroup(a); // creator's zone is UTC (see makeUser)
  await post(b, '/api/groups/join', { group_id: group.id });

  // A weekly whose window opened at the start of today (UTC): it is already
  // running, but still inside its first day, so it must stay joinable.
  const today = new Date().toISOString().slice(0, 10);
  const start = Date.parse(`${today}T00:00:00Z`);
  const id = randomUUID();
  db.prepare(`
    INSERT INTO matches (id, group_id, mode, period_key, title, creator_id,
                         scope_start, scope_end, state, k_factor, team_size, created_at)
    VALUES (?, ?, 'weekly', ?, NULL, NULL, ?, ?, 'open', 20, NULL, ?)
  `).run(id, group.id, today, start, start + 7 * 86400000 - 1, Date.now());

  // scope_start is in the past, but the first-day window keeps it open.
  expect((await post(b, `/api/competitions/${id}/join`)).status).toBe(200);
  expect(db.prepare('SELECT COUNT(*) AS c FROM match_participants WHERE match_id = ?').get(id).c).toBe(1);
});

test('a running match can be neither joined nor left', async () => {
  const a = makeUser('a');
  const b = makeUser('b');
  const group = await createGroup(a);
  await post(b, '/api/groups/join', { group_id: group.id });
  const match = await lobbyIn(a);

  // What the ticker does when the start instant arrives.
  db.prepare("UPDATE matches SET state = 'pending' WHERE id = ?").run(match.id);

  expect((await post(b, `/api/competitions/${match.id}/join`)).status).toBe(409);
  // This is what stops a player dodging a bad day.
  expect((await post(a, `/api/competitions/${match.id}/leave`)).status).toBe(409);
});

test('a lobby whose start instant has passed refuses joins even before the ticker runs', async () => {
  const a = makeUser('a');
  const b = makeUser('b');
  const group = await createGroup(a);
  await post(b, '/api/groups/join', { group_id: group.id });
  const match = await lobbyIn(a);

  db.prepare('UPDATE matches SET scope_start = ? WHERE id = ?').run(Date.now() - 1000, match.id);
  expect((await post(b, `/api/competitions/${match.id}/join`)).status).toBe(409);
});

test('leaving a match you are not in is a 404', async () => {
  const a = makeUser('a');
  const b = makeUser('b');
  const group = await createGroup(a);
  await post(b, '/api/groups/join', { group_id: group.id });
  const match = await lobbyIn(a);
  expect((await post(b, `/api/competitions/${match.id}/leave`)).status).toBe(404);
});

test('the last player out cancels a user-created lobby but never a recurring one', async () => {
  const a = makeUser('a');
  const b = makeUser('b');
  const group = await createGroup(a);
  await post(b, '/api/groups/join', { group_id: group.id });

  const userMatch = await lobbyIn(a);
  expect((await post(a, `/api/competitions/${userMatch.id}/leave`)).status).toBe(200);
  expect(db.prepare('SELECT state FROM matches WHERE id = ?').get(userMatch.id).state).toBe('cancelled');

  // The recurring daily belongs to the group, not to whoever joined first:
  // emptying it must not deny the rest of the group their match.
  const daily = db.prepare("SELECT * FROM matches WHERE group_id = ? AND mode = 'daily'").get(group.id);
  expect(daily.state).toBe('open');
  await post(a, `/api/competitions/${daily.id}/join`);
  expect((await post(a, `/api/competitions/${daily.id}/leave`)).status).toBe(200);
  expect(db.prepare('SELECT state FROM matches WHERE id = ?').get(daily.id).state).toBe('open');
});

test('a 404 for a match id that does not exist', async () => {
  const a = makeUser('a');
  await createGroup(a);
  expect((await get(a, `/api/competitions/${randomUUID()}`)).status).toBe(404);
  expect((await post(a, `/api/competitions/${randomUUID()}/join`)).status).toBe(404);
});

/* ── global (cross-group) matches (issue #35) ──────────────────────────────── */

async function globalLobby(user, over = {}) {
  const start = Date.now() + HOUR;
  const res = await post(user, '/api/competitions', {
    mode: 'ondemand', global: true, scope_start: start, scope_end: start + HOUR, ...over,
  });
  expect(res.status).toBe(201);
  return res.body.match;
}

test('a global match needs no group, carries a null group_id, and rosters its creator', async () => {
  const a = makeUser('a'); // deliberately in no group
  const match = await globalLobby(a);
  expect(match.group_id).toBeNull();
  expect(match.participants.map((p) => p.user_id)).toEqual([a.id]);
});

test('global matches are private by default — require a code to join (issue #36)', async () => {
  const a = makeUser('a');
  const drifter = makeUser('drifter');   // no group at all
  const outsider = makeUser('outsider');
  await createGroup(outsider);           // in an unrelated group

  const match = await globalLobby(a);
  // Anyone can still READ the match by ID.
  expect((await get(drifter, `/api/competitions/${match.id}`)).status).toBe(200);
  // Joining without the code is rejected.
  expect((await post(drifter, `/api/competitions/${match.id}/join`)).status).toBe(403);
  // Joining with the wrong code is also rejected.
  expect((await post(drifter, `/api/competitions/${match.id}/join`, { code: 'WRONG1' })).status).toBe(403);
  // The creator's response includes the join_code; joining with it succeeds.
  const code = match.join_code;
  expect(typeof code).toBe('string');
  expect((await post(drifter, `/api/competitions/${match.id}/join`, { code })).status).toBe(200);
  expect((await post(outsider, `/api/competitions/${match.id}/join`, { code })).status).toBe(200);
});

test('join-by-code looks up a private match and joins it', async () => {
  const a = makeUser('a');
  const b = makeUser('b');
  const match = await globalLobby(a);
  const code = match.join_code;

  expect((await post(b, '/api/competitions/join-by-code', { code })).status).toBe(200);
  // Using a bad code returns 404.
  const c = makeUser('c');
  expect((await post(c, '/api/competitions/join-by-code', { code: 'NOCODE' })).status).toBe(404);
});

test('private global matches are hidden from non-creators in the open bucket', async () => {
  const a = makeUser('a');
  const drifter = makeUser('drifter');
  const match = await globalLobby(a);

  // A non-creator cannot see the private lobby in the open bucket.
  const seen = await get(drifter, '/api/competitions');
  expect(seen.body.global.open.map((m) => m.id)).not.toContain(match.id);
  // The creator does see it.
  const mine = await get(a, '/api/competitions');
  expect(mine.body.global.open.map((m) => m.id)).toContain(match.id);

  // Once joined via code and running, it shows in the live bucket of everyone on the roster.
  await post(drifter, `/api/competitions/${match.id}/join`, { code: match.join_code });
  db.prepare("UPDATE matches SET state = 'pending' WHERE id = ?").run(match.id);
  expect((await get(drifter, '/api/competitions')).body.global.live.map((m) => m.id)).toContain(match.id);
  expect((await get(a, '/api/competitions')).body.global.live.map((m) => m.id)).toContain(match.id);
});

test('the last player out cancels a global lobby', async () => {
  const a = makeUser('a');
  const match = await globalLobby(a);
  expect((await post(a, `/api/competitions/${match.id}/leave`)).status).toBe(200);
  expect(db.prepare('SELECT state FROM matches WHERE id = ?').get(match.id).state).toBe('cancelled');
});

/* ── listings ──────────────────────────────────────────────────────────────── */

test('the match list buckets by state and a groupless caller gets empty buckets', async () => {
  const drifter = makeUser('drifter');
  const empty = await get(drifter, '/api/competitions');
  expect(empty.body).toMatchObject({
    group: null, open: [], live: [], settled: [], my_rating: 1000, my_matches: 0,
  });

  const a = makeUser('a');
  const b = makeUser('b');
  const group = await createGroup(a);
  await post(b, '/api/groups/join', { group_id: group.id });
  const match = await lobbyIn(a);

  const open = await get(a, '/api/competitions');
  expect(open.body.open.map((m) => m.id)).toContain(match.id);
  expect(open.body.group.id).toBe(group.id);

  db.prepare("UPDATE matches SET state = 'pending' WHERE id = ?").run(match.id);
  expect((await get(a, '/api/competitions')).body.live.map((m) => m.id)).toContain(match.id);

  // Cancelled matches share the settled bucket — both are history.
  db.prepare("UPDATE matches SET state = 'cancelled' WHERE id = ?").run(match.id);
  expect((await get(a, '/api/competitions')).body.settled.map((m) => m.id)).toContain(match.id);
});

test('the leaderboard sorts unrated players last, whatever their default rating', async () => {
  const a = makeUser('active');
  const b = makeUser('idle');
  const group = await createGroup(a);
  await post(b, '/api/groups/join', { group_id: group.id });

  // `a` has settled a match and sits BELOW the 1000 default; `b` has played
  // nothing. Raw rating order would put the player who has done nothing first.
  db.prepare('INSERT INTO user_ratings (user_id, rating, matches, updated_at) VALUES (?, ?, ?, ?)')
    .run(a.id, 980, 3, Date.now());

  const res = await get(a, '/api/competitions/leaderboard?scope=global');
  expect(res.body.leaderboard.map((r) => r.username)).toEqual(['active', 'idle']);
  expect(res.body.leaderboard[0]).toMatchObject({ rank: 1, rating: 980, matches: 3 });
  expect(res.body.leaderboard[1]).toMatchObject({ rank: 2, rating: 1000, matches: 0 });
});

// Issue #53. The group scope is a FILTER over the global board, not a second
// ranking: a member's number is where they stand among everyone, so a small
// group does not read 1..n. Getting this wrong is invisible in a one-group test
// database, which is why the outsiders here rate ABOVE the members.
test('the group scope filters the global board without re-ranking it', async () => {
  const top = makeUser('top');
  const second = makeUser('second');
  const member = makeUser('member');
  const mate = makeUser('mate');

  const group = await createGroup(member);
  await post(mate, '/api/groups/join', { group_id: group.id });

  const rate = (u, rating) => db
    .prepare('INSERT INTO user_ratings (user_id, rating, matches, updated_at) VALUES (?, ?, ?, ?)')
    .run(u.id, rating, 5, Date.now());
  rate(top, 1300);
  rate(second, 1200);
  rate(member, 1100);
  rate(mate, 1000);

  const global = await get(member, '/api/competitions/leaderboard?scope=global');
  expect(global.body.scope).toBe('global');
  expect(global.body.group).toBeNull();
  expect(global.body.leaderboard.map((r) => r.username)).toEqual(['top', 'second', 'member', 'mate']);

  const scoped = await get(member, '/api/competitions/leaderboard?scope=group');
  expect(scoped.body.scope).toBe('group');
  expect(scoped.body.group.id).toBe(group.id);
  expect(scoped.body.leaderboard.map((r) => r.username)).toEqual(['member', 'mate']);
  // The whole point: 3 and 4, never 1 and 2.
  expect(scoped.body.leaderboard.map((r) => r.rank)).toEqual([3, 4]);
});

test('the leaderboard always reports the caller their own global standing', async () => {
  const a = makeUser('a');
  const b = makeUser('b');
  db.prepare('INSERT INTO user_ratings (user_id, rating, matches, updated_at) VALUES (?, ?, ?, ?)')
    .run(b.id, 1400, 2, Date.now());

  // `a` is in no group at all, so the group scope lists nobody — but `me` is
  // what the UI pins when the caller is not in the visible rows, so it has to
  // survive an empty board.
  const scoped = await get(a, '/api/competitions/leaderboard?scope=group');
  expect(scoped.status).toBe(200);
  expect(scoped.body.group).toBeNull();
  expect(scoped.body.leaderboard).toEqual([]);
  expect(scoped.body.me).toMatchObject({ id: a.id, rank: 2, matches: 0 });

  expect((await get(b, '/api/competitions/leaderboard?scope=global')).body.me)
    .toMatchObject({ id: b.id, rank: 1, rating: 1400 });
});

test('an unrecognised leaderboard scope falls back to the global board', async () => {
  const a = makeUser('a');
  await createGroup(a);

  for (const q of ['', '?scope=', '?scope=GROUP', '?scope=nonsense', "?scope=group' OR 1=1--"]) {
    const res = await get(a, `/api/competitions/leaderboard${q}`);
    expect({ q, status: res.status, scope: res.body.scope })
      .toEqual({ q, status: 200, scope: 'global' });
  }
});

test('a live match reports scores from the window so far, a settled one the stored values', async () => {
  const a = makeUser('a');
  const b = makeUser('b');
  const group = await createGroup(a);
  await post(b, '/api/groups/join', { group_id: group.id });
  const match = await lobbyIn(a);
  await post(b, `/api/competitions/${match.id}/join`);

  // Open the window backwards so "now" sits inside it, and log inside it.
  const start = Date.now() - HOUR;
  db.prepare("UPDATE matches SET scope_start = ?, scope_end = ?, state = 'pending' WHERE id = ?")
    .run(start, start + 2 * HOUR, match.id);
  db.prepare('INSERT INTO coffee_entries (id, user_id, coffee_id, caffeine_mg, logged_at, is_public) VALUES (?, ?, ?, ?, ?, 1)')
    .run(randomUUID(), a.id, 'espresso', 200, start + 60000);
  // Private, and inside the same window: it must not move the live score.
  db.prepare('INSERT INTO coffee_entries (id, user_id, coffee_id, caffeine_mg, logged_at, is_public) VALUES (?, ?, ?, ?, ?, 0)')
    .run(randomUUID(), b.id, 'espresso', 500, start + 60000);

  const live = await get(a, `/api/competitions/${match.id}`);
  const byName = Object.fromEntries(live.body.match.participants.map((p) => [p.username, p]));
  // 200mg + 1 cup + 1 kind, raw and uncapped — no 0..1000 transform.
  expect(byName.a.points).toBe(230);
  expect(byName.b.points).toBe(0);
  // Standings are ordered best-first, and nothing has settled so no delta yet.
  expect(live.body.match.participants[0].username).toBe('a');
  expect(byName.a.delta).toBeNull();
  expect(byName.a.current_rating).toBe(1000);

  // Once settled the payload reports the stored ledger, not a fresh count.
  db.prepare("UPDATE matches SET state = 'settled' WHERE id = ?").run(match.id);
  db.prepare('UPDATE match_participants SET score = ?, rating_before = 1000, rating_after = ?, delta = ? WHERE match_id = ? AND user_id = ?')
    .run(742, 1016, 16, match.id, a.id);
  const settled = await get(a, `/api/competitions/${match.id}`);
  const sa = settled.body.match.participants.find((p) => p.username === 'a');
  expect(sa.delta).toBe(16);
  expect(sa.current_rating).toBe(1016);
  // Straight from the stored score, not recomputed — that row is the immutable
  // record of what the window was worth when it settled.
  expect(sa.points).toBe(742);
});

/* ── match history (issue #34) ─────────────────────────────────────────────── */

// A settled match with its ledger already written, so the history endpoint has
// something to read without driving a whole match through the scheduler.
// `parts` is [{ user, before, after, delta }].
function settledMatch({ group_id = null, mode = 'ondemand', title = null, settled_at, parts }) {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO matches (id, group_id, mode, period_key, title, creator_id,
                         scope_start, scope_end, state, k_factor, team_size, created_at, settled_at)
    VALUES (?, ?, ?, NULL, ?, NULL, ?, ?, 'settled', 32, NULL, ?, ?)
  `).run(id, group_id, mode, title, settled_at - HOUR, settled_at, settled_at - HOUR, settled_at);
  for (const p of parts) {
    db.prepare(`
      INSERT INTO match_participants
        (id, match_id, user_id, side, joined_at, score, contribution_share, rating_before, rating_after, delta)
      VALUES (?, ?, ?, NULL, ?, 0.5, NULL, ?, ?, ?)
    `).run(randomUUID(), id, p.user.id, settled_at - HOUR, p.before, p.after, p.delta);
  }
  return id;
}

test('history lists the caller\'s settled matches newest first, with the elo deltas', async () => {
  const a = makeUser('a');
  const b = makeUser('b');
  const now = Date.now();
  settledMatch({ settled_at: now - 2 * HOUR, parts: [
    { user: a, before: 1000, after: 1016, delta: 16 },
    { user: b, before: 1000, after: 984, delta: -16 },
  ] });
  settledMatch({ settled_at: now - HOUR, parts: [{ user: a, before: 1016, after: 1010, delta: -6 }] });

  const res = await get(a, '/api/competitions/history');
  expect(res.status).toBe(200);
  // Newest first; only the caller's own rows, not the opponent's.
  expect(res.body.personal.map((e) => e.delta)).toEqual([-6, 16]);
  expect(res.body.personal[0].rating_after).toBe(1010);
});

test('history excludes cancelled matches — they moved no rating', async () => {
  const a = makeUser('a');
  const id = randomUUID();
  db.prepare(`
    INSERT INTO matches (id, group_id, mode, period_key, title, creator_id,
                         scope_start, scope_end, state, k_factor, team_size, created_at, settled_at)
    VALUES (?, NULL, 'ondemand', NULL, NULL, NULL, 0, 1, 'cancelled', 32, NULL, 0, ?)
  `).run(id, Date.now());
  db.prepare('INSERT INTO match_participants (id, match_id, user_id, side, joined_at) VALUES (?, ?, ?, NULL, ?)')
    .run(randomUUID(), id, a.id, Date.now());

  expect((await get(a, '/api/competitions/history')).body.personal).toEqual([]);
});

test('personal history spans global matches too, but group_history is only the group\'s', async () => {
  const a = makeUser('a');
  const b = makeUser('b');
  const group = await createGroup(a);
  await post(b, '/api/groups/join', { group_id: group.id });
  const now = Date.now();

  const grp = settledMatch({ group_id: group.id, settled_at: now - 2 * HOUR, parts: [
    { user: a, before: 1000, after: 1010, delta: 10 },
    { user: b, before: 1000, after: 990, delta: -10 },
  ] });
  const glob = settledMatch({ group_id: null, settled_at: now - HOUR, parts: [
    { user: a, before: 1010, after: 1004, delta: -6 },
  ] });

  const res = await get(a, '/api/competitions/history');
  // The rating is one global number, so both matches are in the personal ledger.
  expect(res.body.personal.map((e) => e.match_id)).toEqual([glob, grp]);
  // The public pill is the group's own finished matches — the global one is not.
  expect(res.body.group_history.map((m) => m.id)).toEqual([grp]);
  expect(res.body.group_history[0].participants).toHaveLength(2);
});

test('group_history is empty for a caller in no group', async () => {
  const drifter = makeUser('drifter');
  const res = await get(drifter, '/api/competitions/history');
  expect(res.body.group).toBeNull();
  expect(res.body.group_history).toEqual([]);
});

/* ── the auto-join preference ──────────────────────────────────────────────── */

test('auto-join defaults to off and toggles through PATCH /auth/me', async () => {
  const a = makeUser('a');
  const before = db.prepare('SELECT auto_join_daily, auto_join_weekly FROM users WHERE id = ?').get(a.id);
  expect(before).toEqual({ auto_join_daily: 0, auto_join_weekly: 0 });

  const res = await patch(a, '/api/auth/me', { auto_join_daily: true });
  expect(res.status).toBe(200);
  expect(res.body.auto_join_daily).toBe(1);
  expect(res.body.auto_join_weekly).toBe(0); // untouched keys stay put

  expect((await patch(a, '/api/auth/me', { auto_join_daily: false })).body.auto_join_daily).toBe(0);
});

test('auto-join refuses a non-boolean rather than coercing it', async () => {
  const a = makeUser('a');
  // Coercion here is the difference between every daily match and none of them,
  // so a truthy string must not silently opt someone in.
  for (const value of ['true', 1, 0, null, {}]) {
    const res = await patch(a, '/api/auth/me', { auto_join_daily: value });
    expect({ value, status: res.status }).toEqual({ value, status: 400 });
  }
  expect(db.prepare('SELECT auto_join_daily FROM users WHERE id = ?').get(a.id).auto_join_daily).toBe(0);
});

test('a PATCH rejected on another field does not opt the user in anyway', async () => {
  const a = makeUser('a');
  const b = makeUser('taken');

  // The username collision is a 409 — the whole request is refused, so the
  // auto-join flag alongside it must not have landed.
  const res = await patch(a, '/api/auth/me', { auto_join_daily: true, username: b.username });
  expect(res.status).toBe(409);
  expect(db.prepare('SELECT auto_join_daily FROM users WHERE id = ?').get(a.id).auto_join_daily).toBe(0);

  // Same for a rejected password rotation (403).
  const pw = await patch(a, '/api/auth/me', { auto_join_weekly: true, password: 'new', currentPassword: 'wrong' });
  expect(pw.status).toBe(403);
  expect(db.prepare('SELECT auto_join_weekly FROM users WHERE id = ?').get(a.id).auto_join_weekly).toBe(0);
});

test('an auto-join member is rostered into the next recurring lobby, a plain member is not', async () => {
  const a = makeUser('auto');
  const b = makeUser('manual');
  const group = await createGroup(a);
  await patch(a, '/api/auth/me', { auto_join_daily: true });
  await post(b, '/api/groups/join', { group_id: group.id });

  const daily = db.prepare("SELECT * FROM matches WHERE group_id = ? AND mode = 'daily'").get(group.id);
  const roster = db.prepare('SELECT user_id FROM match_participants WHERE match_id = ?')
    .all(daily.id).map((r) => r.user_id);
  expect(roster).toEqual([a.id]);
});

test('a group holding a running match survives being emptied, so nobody dodges it', async () => {
  const a = makeUser('a');
  const b = makeUser('b');
  const group = await createGroup(a);
  await post(b, '/api/groups/join', { group_id: group.id });

  const match = await lobbyIn(a);
  await post(b, `/api/competitions/${match.id}/join`);
  // The ticker locks the roster when the start instant arrives.
  db.prepare("UPDATE matches SET state = 'pending' WHERE id = ?").run(match.id);

  // Both walk out mid-match. The group must not be swept away with the match
  // still on it — that would be the dodge the frozen roster exists to prevent.
  await post(a, '/api/groups/leave');
  await post(b, '/api/groups/leave');

  expect(db.prepare('SELECT COUNT(*) AS c FROM competition_groups WHERE id = ?').get(group.id).c).toBe(1);
  expect(db.prepare('SELECT state FROM matches WHERE id = ?').get(match.id).state).toBe('pending');
  expect(db.prepare('SELECT COUNT(*) AS c FROM match_participants WHERE match_id = ?').get(match.id).c).toBe(2);

  // And it still settles, with both of them on it.
  const { settleDueMatches } = require('./competitions');
  db.prepare('UPDATE matches SET scope_end = ? WHERE id = ?').run(Date.now() - 1000, match.id);
  settleDueMatches(Date.now());
  expect(db.prepare('SELECT state FROM matches WHERE id = ?').get(match.id).state).toBe('settled');
  expect(db.prepare('SELECT COUNT(*) AS c FROM user_ratings WHERE user_id IN (?, ?)').get(a.id, b.id).c).toBe(2);
});
