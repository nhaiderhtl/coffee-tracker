import { test, expect, beforeEach } from 'bun:test';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

// Point the DB at a throwaway directory BEFORE ./db is first required, so this
// suite never touches the repo's real database.
process.env.DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'coffee-comp-test-'));

const db = require('./db');
require('./migrate')(db);

const {
  mondayOf, dailyWindow, weeklyWindow, groupOf, metricsFor, scoreFor, scoresForMany, ratingOf,
  ensureRecurringMatch, ensureRecurringMatches, rosterIsLegal,
  lockDueLobbies, settleMatch, settleDueMatches, tick,
  dayIsOff, offRangesForMatch, wholeWeekOff,
} = require('./competitions');
const { BASE_RATING, K_BY_MODE, points } = require('./competition-core');
// The migration replays history through the FROZEN v1 math, so its expectations
// come from there too — competition-core has moved on to v2.
const { settleFfa: settleFfaV1 } = require('./migrations/lib/settle-v1');

const DAY = 86400000;

beforeEach(() => {
  // Order matters only for readability — the FK cascades would handle it.
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

const notificationsFor = (userId) =>
  db.prepare("SELECT * FROM notifications WHERE user_id = ? AND type = 'match_end'").all(userId)
    .map((r) => ({ ...r, payload: JSON.parse(r.payload) }));

function makeUser(username, timezone = 'UTC') {
  const id = randomUUID();
  db.prepare('INSERT INTO users (id, username, password_hash, created_at, timezone) VALUES (?, ?, ?, ?, ?)')
    .run(id, username, 'x', Date.now(), timezone);
  return id;
}

function makeGroup(timezone = 'UTC', userIds = []) {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO competition_groups (id, name, description, owner_id, timezone, is_public, join_code, created_at)
    VALUES (?, ?, NULL, ?, ?, 1, ?, ?)
  `).run(id, `g-${id.slice(0, 8)}`, userIds[0] || null, timezone, id.slice(0, 6).toUpperCase(), Date.now());
  for (const userId of userIds) {
    db.prepare('INSERT INTO group_members (id, group_id, user_id, joined_at) VALUES (?, ?, ?, ?)')
      .run(randomUUID(), id, userId, Date.now());
  }
  return db.prepare('SELECT * FROM competition_groups WHERE id = ?').get(id);
}

// Defaults to a PUBLIC entry, because that is the only kind a competition can
// see (value 7 of docs/competitions-rating-v2.md). Pass `isPublic: 0` for the
// tests that are about the filter itself.
function logCoffee(userId, at, { coffeeId = 'espresso', mg = 80, isPublic = 1, createdAt = at } = {}) {
  db.prepare(`
    INSERT INTO coffee_entries (id, user_id, coffee_id, caffeine_mg, logged_at, created_at, is_public)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), userId, coffeeId, mg, at, createdAt, isPublic);
}

function openMatch({ group, mode, start, end, teamSize = null, state = 'open', roster = [], periodKey = null }) {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO matches (id, group_id, mode, period_key, title, creator_id,
                         scope_start, scope_end, state, k_factor, team_size, created_at)
    VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)
  `).run(id, group.id, mode, periodKey, start, end, state, K_BY_MODE[mode], teamSize, Date.now());
  for (const { userId, side = null } of roster) {
    db.prepare('INSERT INTO match_participants (id, match_id, user_id, side, joined_at) VALUES (?, ?, ?, ?, ?)')
      .run(randomUUID(), id, userId, side, Date.now());
  }
  return db.prepare('SELECT * FROM matches WHERE id = ?').get(id);
}

// What POST /competitions/:id/join does to the database. Recurring lobbies open
// empty now, so every settlement test has to put its players on the roster the
// same way a real player would.
function joinMatch(matchId, userIds, side = null) {
  for (const userId of [].concat(userIds)) {
    db.prepare('INSERT INTO match_participants (id, match_id, user_id, side, joined_at) VALUES (?, ?, ?, ?, ?)')
      .run(randomUUID(), matchId, userId, side, Date.now());
  }
}

const matchById = (id) => db.prepare('SELECT * FROM matches WHERE id = ?').get(id);
const participants = (id) => db.prepare('SELECT * FROM match_participants WHERE match_id = ?').all(id);

// ── windows ──────────────────────────────────────────────────────────────────

test('mondayOf lands on the Monday of that week and is a fixed point on Mondays', () => {
  expect(mondayOf('2026-07-26')).toBe('2026-07-20'); // a Sunday -> previous Monday
  expect(mondayOf('2026-07-20')).toBe('2026-07-20');
  expect(mondayOf('2026-07-21')).toBe('2026-07-20');
  expect(mondayOf('2026-01-01')).toBe('2025-12-29'); // across a year boundary
});

test('the daily window follows the GROUP zone, not the process zone', () => {
  // 2026-07-26T01:00Z is still 2026-07-25 in New York and already the 26th in
  // Vienna, so the two groups must be measuring different days at that instant.
  const at = Date.parse('2026-07-26T01:00:00Z');
  const vienna = dailyWindow({ timezone: 'Europe/Vienna' }, at);
  const newYork = dailyWindow({ timezone: 'America/New_York' }, at);

  expect(vienna.periodKey).toBe('2026-07-26');
  expect(newYork.periodKey).toBe('2026-07-25');
  expect(at).toBeGreaterThanOrEqual(vienna.start);
  expect(at).toBeLessThanOrEqual(vienna.end);
  expect(at).toBeGreaterThanOrEqual(newYork.start);
  expect(at).toBeLessThanOrEqual(newYork.end);
});

test('a daily window is exactly one day long and abuts the next one', () => {
  const at = Date.parse('2026-07-26T09:00:00Z');
  const w = dailyWindow({ timezone: 'Europe/Vienna' }, at);
  expect(w.end - w.start).toBe(DAY - 1);
  const next = dailyWindow({ timezone: 'Europe/Vienna' }, w.end + 1);
  expect(next.start).toBe(w.end + 1);
});

test('a spring-forward day is 23 hours, not 24 — the zone does the work', () => {
  // Europe/Vienna springs forward on 2026-03-29.
  const at = Date.parse('2026-03-29T12:00:00Z');
  const w = dailyWindow({ timezone: 'Europe/Vienna' }, at);
  expect(w.periodKey).toBe('2026-03-29');
  expect(w.end - w.start).toBe(23 * 3600000 - 1);
});

test('the weekly window covers seven local days from Monday', () => {
  const at = Date.parse('2026-07-23T12:00:00Z'); // a Thursday
  const w = weeklyWindow({ timezone: 'Europe/Vienna' }, at);
  expect(w.periodKey).toBe('2026-07-20');
  expect(w.end - w.start).toBe(7 * DAY - 1);
  expect(at).toBeGreaterThan(w.start);
  expect(at).toBeLessThan(w.end);
});

test('an invalid group zone falls back to UTC instead of throwing', () => {
  const w = dailyWindow({ timezone: 'Not/AZone' }, Date.parse('2026-07-26T01:00:00Z'));
  expect(w.periodKey).toBe('2026-07-26');
});

// ── scoring ──────────────────────────────────────────────────────────────────

test('score counts only entries inside the window, and both bounds are inclusive', () => {
  const user = makeUser('scorer');
  const start = Date.parse('2026-07-26T00:00:00Z');
  const end = start + DAY - 1;

  logCoffee(user, start - 1);          // just before
  logCoffee(user, end + 1);            // just after
  expect(scoreFor(user, start, end)).toBe(0);

  // Neither drink carries a score_caffeine override, so both score at their
  // stored mg and this stays a test about the window, not about scoring
  // overrides. Both sit exactly ON a bound, which is what pins the inclusivity.
  logCoffee(user, start, { mg: 200, coffeeId: 'espresso' });
  logCoffee(user, end, { mg: 100, coffeeId: 'lungo' });
  expect(scoreFor(user, start, end)).toBe(points({ caffeine: 300, cups: 2, variety: 2 }));
  expect(scoreFor(user, start, end)).toBe(360); // 300mg + 2 cups + 2 kinds, at 1/15/15
});

test('logged_at decides window membership, not created_at', () => {
  const user = makeUser('backdater');
  const start = Date.parse('2026-07-26T00:00:00Z');
  const end = start + DAY - 1;

  // Logged inside the window but entered hours after it closed — the user-stated
  // drinking time is the one that counts.
  logCoffee(user, start + 3600000, { mg: 90, createdAt: end + 10 * 3600000 });
  expect(scoreFor(user, start, end)).toBe(points({ caffeine: 90, cups: 1, variety: 1 }));
});

test('a private entry contributes nothing to caffeine, cups or variety', () => {
  const user = makeUser('lurker');
  const start = Date.parse('2026-07-26T00:00:00Z');
  const end = start + DAY - 1;

  logCoffee(user, start + 1000, { mg: 200, coffeeId: 'espresso', isPublic: 0 });
  logCoffee(user, start + 2000, { mg: 150, coffeeId: 'lungo', isPublic: 0 });
  expect(metricsFor(user, start, end)).toMatchObject({ caffeine: 0, cups: 0, variety: 0 });
  expect(scoreFor(user, start, end)).toBe(0);

  // One public entry alongside them scores on its own, as if the others were
  // not there at all.
  logCoffee(user, start + 3000, { mg: 80, coffeeId: 'ristretto' });
  expect(metricsFor(user, start, end)).toMatchObject({ caffeine: 80, cups: 1, variety: 1 });
  expect(scoreFor(user, start, end)).toBe(points({ caffeine: 80, cups: 1, variety: 1 }));
});

test('the public filter is competition-only — every other surface still counts a private entry', () => {
  const user = makeUser('mixed');
  const start = Date.parse('2026-07-26T00:00:00Z');
  const end = start + DAY - 1;
  logCoffee(user, start + 1000, { mg: 200, isPublic: 0 });
  logCoffee(user, start + 2000, { mg: 100, isPublic: 1 });

  // What Buzz, stats, streaks, achievements, casualties, the rankings page's
  // caffeine total and community challenges all read: every entry, no filter.
  const total = db.prepare(
    'SELECT COALESCE(SUM(caffeine_mg), 0) AS mg, COUNT(*) AS cups FROM coffee_entries WHERE user_id = ?'
  ).get(user);
  expect(total).toMatchObject({ mg: 300, cups: 2 });
  // The competition sees only the public half.
  expect(metricsFor(user, start, end)).toMatchObject({ caffeine: 100, cups: 1 });
});

test('an overridden drink scores its score_caffeine value, not its stored mg', () => {
  const user = makeUser('latte-drinker');
  const start = Date.parse('2026-07-26T00:00:00Z');
  const end = start + DAY - 1;

  // Stored at the catalog's displayed 63mg; both lattes must score as 25.
  logCoffee(user, start, { mg: 63, coffeeId: 'latte' });
  logCoffee(user, start + 3600000, { mg: 63, coffeeId: 'latte_macchiato' });
  expect(scoreFor(user, start, end)).toBe(points({ caffeine: 50, cups: 2, variety: 2 }));
});

test('scoresForMany and scoreFor agree for the same roster and window', () => {
  const a = makeUser('roster-a');
  const b = makeUser('roster-b');
  const c = makeUser('roster-c'); // logs nothing: absent from the batch result
  const start = Date.parse('2026-07-26T00:00:00Z');
  const end = start + DAY - 1;

  logCoffee(a, start + 1000, { mg: 180, coffeeId: 'espresso' });
  logCoffee(a, start + 2000, { mg: 63, coffeeId: 'latte' });        // overridden to 25
  logCoffee(a, start + 3000, { mg: 90, coffeeId: 'lungo', isPublic: 0 }); // ignored
  logCoffee(b, start + 1000, { mg: 120, coffeeId: 'ristretto' });

  const batch = scoresForMany([a, b, c], start, end);
  for (const user of [a, b, c]) {
    expect(batch.get(user) ?? 0).toBe(scoreFor(user, start, end));
  }
  expect(batch.get(a)).toBe(points({ caffeine: 205, cups: 2, variety: 2 }));
  expect(batch.has(c)).toBe(false); // read with `?? 0`
});

test('points are linear and uncapped over a real window', () => {
  const user = makeUser('heavy');
  const start = Date.parse('2026-07-26T00:00:00Z');
  const end = start + DAY - 1;
  for (let i = 0; i < 12; i++) logCoffee(user, start + i * 60000, { mg: 63, coffeeId: 'espresso' });
  // 756 mg + 12 cups + 1 kind. Nothing saturates and there is no 1000 ceiling.
  expect(scoreFor(user, start, end)).toBe(951);
});

test('a user with no entries at all scores zero, not NaN', () => {
  const user = makeUser('empty');
  expect(scoreFor(user, 0, Date.now())).toBe(0);
});

// ── recurring match creation ─────────────────────────────────────────────────

test('recurring matches open EMPTY — being in a group never enters you in one', () => {
  const a = makeUser('a');
  const b = makeUser('b');
  const group = makeGroup('UTC', [a, b]);
  const now = Date.parse('2026-07-26T10:00:00Z');

  ensureRecurringMatches(now);
  ensureRecurringMatches(now); // second pass must not duplicate

  const rows = db.prepare('SELECT * FROM matches WHERE group_id = ?').all(group.id);
  expect(rows.length).toBe(2);
  expect(rows.map((m) => m.mode).sort()).toEqual(['daily', 'weekly']);
  for (const m of rows) {
    expect(m.state).toBe('open');            // a lobby, not a running match
    expect(participants(m.id).length).toBe(0); // nobody was placed on it
  }
  expect(rows.find((m) => m.mode === 'daily').k_factor).toBe(K_BY_MODE.daily);
  expect(rows.find((m) => m.mode === 'weekly').k_factor).toBe(K_BY_MODE.weekly);
});

test('the daily that opens is TOMORROW\'s, and it starts in the future', () => {
  const a = makeUser('a');
  const b = makeUser('b');
  const group = makeGroup('UTC', [a, b]);
  const now = Date.parse('2026-07-26T10:00:00Z');

  ensureRecurringMatch(group, 'daily', now);
  const daily = db.prepare("SELECT * FROM matches WHERE group_id = ? AND mode = 'daily'").get(group.id);

  expect(daily.period_key).toBe('2026-07-27');
  expect(daily.scope_start).toBeGreaterThan(now); // joinable for the rest of today
  expect(daily.scope_start).toBe(Date.parse('2026-07-27T00:00:00Z'));
});

test('the weekly opens exactly two days before it starts, not earlier', () => {
  const a = makeUser('a');
  const b = makeUser('b');
  const group = makeGroup('UTC', [a, b]);

  // Week of Mon 2026-07-27. The two-day lead only crosses a week boundary on
  // Sat/Sun; Mon-Fri it resolves to the week already under way, which is not a
  // match anyone can be opened into.
  ensureRecurringMatch(group, 'weekly', Date.parse('2026-07-24T10:00:00Z')); // Fri
  expect(db.prepare("SELECT period_key FROM matches WHERE group_id = ? AND mode = 'weekly'")
    .all(group.id).map((r) => r.period_key)).toEqual([]);

  ensureRecurringMatch(group, 'weekly', Date.parse('2026-07-25T10:00:00Z')); // Sat
  const keys = db.prepare("SELECT period_key FROM matches WHERE group_id = ? AND mode = 'weekly' ORDER BY period_key")
    .all(group.id).map((r) => r.period_key);
  expect(keys).toEqual(['2026-07-27']);

  const next = db.prepare("SELECT * FROM matches WHERE group_id = ? AND period_key = ?").get(group.id, '2026-07-27');
  expect(next.scope_start - Date.parse('2026-07-25T10:00:00Z')).toBeGreaterThan(DAY);
});

test('a group that reaches two members mid-week gets no weekly for the week already running', () => {
  const a = makeUser('a');
  const b = makeUser('b');
  const group = makeGroup('UTC', [a, b]);
  const wed = Date.parse('2026-07-29T12:00:00Z');

  // Before the guard this opened the week of 2026-07-27 — a window that started
  // two days before the group existed. Empty it was cancelled on the next tick;
  // with auto-join members on the roster it went live and settled over days
  // nobody had been in the group for.
  ensureRecurringMatches(wed);
  expect(db.prepare("SELECT COUNT(*) AS c FROM matches WHERE group_id = ? AND mode = 'weekly'")
    .get(group.id).c).toBe(0);

  // The daily is unaffected: its one-day lead always lands on tomorrow.
  const daily = db.prepare("SELECT * FROM matches WHERE group_id = ? AND mode = 'daily'").get(group.id);
  expect(daily.period_key).toBe('2026-07-30');
  expect(daily.scope_start).toBeGreaterThan(wed);
});

test('auto-join members never get rostered into a window that already started', () => {
  const a = makeUser('a');
  const b = makeUser('b');
  db.prepare('UPDATE users SET auto_join_weekly = 1 WHERE id IN (?, ?)').run(a, b);
  const group = makeGroup('UTC', [a, b]);
  const wed = Date.parse('2026-07-29T12:00:00Z');

  tick(wed);
  expect(db.prepare("SELECT COUNT(*) AS c FROM matches WHERE group_id = ? AND mode = 'weekly'")
    .get(group.id).c).toBe(0);
  // Nothing settled, so no rating moved for a week they were not in the group for.
  expect(ratingOf(a)).toBe(BASE_RATING);
  expect(ratingOf(b)).toBe(BASE_RATING);
});

test('a solo group gets no match at all', () => {
  const a = makeUser('solo');
  const group = makeGroup('UTC', [a]);
  ensureRecurringMatches(Date.now());
  expect(db.prepare('SELECT COUNT(*) AS c FROM matches WHERE group_id = ?').get(group.id).c).toBe(0);
});

test('each day opens its own daily without touching the previous one', () => {
  const a = makeUser('a');
  const b = makeUser('b');
  const group = makeGroup('UTC', [a, b]);

  ensureRecurringMatch(group, 'daily', Date.parse('2026-07-26T10:00:00Z'));
  ensureRecurringMatch(group, 'daily', Date.parse('2026-07-27T10:00:00Z'));

  const keys = db.prepare("SELECT period_key FROM matches WHERE group_id = ? AND mode = 'daily' ORDER BY period_key")
    .all(group.id).map((r) => r.period_key);
  expect(keys).toEqual(['2026-07-27', '2026-07-28']);
});

test('only members who opted in are auto-joined, and only for that mode', () => {
  const optIn = makeUser('optin');
  const optOut = makeUser('optout');
  const weeklyOnly = makeUser('weeklyonly');
  const group = makeGroup('UTC', [optIn, optOut, weeklyOnly]);
  db.prepare('UPDATE users SET auto_join_daily = 1, auto_join_weekly = 1 WHERE id = ?').run(optIn);
  db.prepare('UPDATE users SET auto_join_weekly = 1 WHERE id = ?').run(weeklyOnly);

  const now = Date.parse('2026-07-25T10:00:00Z'); // Saturday: both modes open
  ensureRecurringMatches(now);

  const daily = db.prepare("SELECT * FROM matches WHERE group_id = ? AND mode = 'daily'").get(group.id);
  const weekly = db.prepare("SELECT * FROM matches WHERE group_id = ? AND mode = 'weekly'").get(group.id);

  expect(participants(daily.id).map((p) => p.user_id)).toEqual([optIn]);
  expect(participants(weekly.id).map((p) => p.user_id).sort()).toEqual([optIn, weeklyOnly].sort());
});

test('auto-join defaults to off for a brand-new user', () => {
  const u = makeUser('fresh');
  const row = db.prepare('SELECT auto_join_daily, auto_join_weekly FROM users WHERE id = ?').get(u);
  expect(row.auto_join_daily).toBe(0);
  expect(row.auto_join_weekly).toBe(0);
});

test('joining a lobby is what puts you on a roster', () => {
  const a = makeUser('a');
  const b = makeUser('b');
  const group = makeGroup('UTC', [a, b]);
  const now = Date.parse('2026-07-26T10:00:00Z');
  ensureRecurringMatches(now);

  const daily = db.prepare("SELECT * FROM matches WHERE group_id = ? AND mode = 'daily'").get(group.id);
  expect(participants(daily.id).length).toBe(0);

  db.prepare('INSERT INTO match_participants (id, match_id, user_id, side, joined_at) VALUES (?, ?, ?, NULL, ?)')
    .run(randomUUID(), daily.id, a, now);
  expect(participants(daily.id).map((p) => p.user_id)).toEqual([a]);

  // One player is not a match: the lobby is cancelled at its start instant and
  // nobody's rating moves.
  lockDueLobbies(daily.scope_start);
  expect(matchById(daily.id).state).toBe('cancelled');
  expect(db.prepare('SELECT COUNT(*) AS c FROM user_ratings').get().c).toBe(0);
});

// ── lobbies ──────────────────────────────────────────────────────────────────

test('rosterIsLegal enforces each mode\'s shape', () => {
  // 1v1 is exactly two; every other surviving mode is a free-for-all needing
  // any two players. Team mode is gone, so there is no side to validate.
  expect(rosterIsLegal({ mode: '1v1' }, [{}, {}])).toBe(true);
  expect(rosterIsLegal({ mode: '1v1' }, [{}])).toBe(false);
  expect(rosterIsLegal({ mode: '1v1' }, [{}, {}, {}])).toBe(false);
  for (const mode of ['ondemand', 'daily', 'weekly']) {
    expect(rosterIsLegal({ mode }, [{}, {}, {}])).toBe(true);
    expect(rosterIsLegal({ mode }, [{}, {}])).toBe(true);
    expect(rosterIsLegal({ mode }, [{}])).toBe(false);
    expect(rosterIsLegal({ mode }, [])).toBe(false);
  }
});

test('a lobby that filled goes live, one that did not is cancelled with no rating moved', () => {
  const a = makeUser('a');
  const b = makeUser('b');
  const group = makeGroup('UTC', [a, b]);
  const start = Date.now() - 1000;

  const filled = openMatch({ group, mode: '1v1', start, end: start + DAY, roster: [{ userId: a }, { userId: b }] });
  const empty = openMatch({ group, mode: '1v1', start, end: start + DAY, roster: [{ userId: a }] });

  lockDueLobbies(Date.now());

  expect(matchById(filled.id).state).toBe('pending');
  expect(matchById(empty.id).state).toBe('cancelled');
  expect(db.prepare('SELECT COUNT(*) AS c FROM user_ratings').get().c).toBe(0);
});

test('a weekly stays open through its first day, then locks like anything else (issue #44)', () => {
  const a = makeUser('a');
  const b = makeUser('b');
  const group = makeGroup('UTC', [a, b]);
  // Monday 2026-07-20 UTC; window runs Mon 00:00 → Sun 23:59:59.999.
  const monday = Date.parse('2026-07-20T00:00:00Z');
  const weekly = openMatch({
    group, mode: 'weekly', periodKey: '2026-07-20',
    start: monday, end: monday + 7 * DAY - 1,
    roster: [{ userId: a }, { userId: b }],
  });

  // Midday on the first day: the window is running, but the lobby is NOT locked
  // — nobody joins a weekly at 00:00 Monday, so day one stays joinable.
  lockDueLobbies(monday + 12 * 3600000);
  expect(matchById(weekly.id).state).toBe('open');

  // A second before the first day ends it is still open...
  lockDueLobbies(Date.parse('2026-07-21T00:00:00Z') - 1);
  expect(matchById(weekly.id).state).toBe('open');

  // ...and at the next local midnight it locks like any other match.
  lockDueLobbies(Date.parse('2026-07-21T00:00:00Z'));
  expect(matchById(weekly.id).state).toBe('pending');
});

test('a daily still locks at its start instant, not a day later', () => {
  const a = makeUser('a');
  const b = makeUser('b');
  const group = makeGroup('UTC', [a, b]);
  const monday = Date.parse('2026-07-20T00:00:00Z');
  const daily = openMatch({
    group, mode: 'daily', periodKey: '2026-07-20',
    start: monday, end: monday + DAY - 1,
    roster: [{ userId: a }, { userId: b }],
  });
  // A minute in, the daily is already locked — the first-day grace is weekly-only.
  lockDueLobbies(monday + 60000);
  expect(matchById(daily.id).state).toBe('pending');
});

test('period_key is what tells a recurring match from a user-created one', () => {
  // The leave route keys off exactly this to decide whether an emptied lobby
  // gets cancelled: a user-created one does, a group's daily does not (it
  // belongs to the group, so one player leaving must not deny everyone else
  // the match). That branch itself is HTTP-level and is covered by driving the
  // API, not here — this pins the invariant it depends on.
  const a = makeUser('a');
  const b = makeUser('b');
  const group = makeGroup('UTC', [a, b]);
  ensureRecurringMatches(Date.parse('2026-07-26T10:00:00Z'));

  const daily = db.prepare("SELECT * FROM matches WHERE group_id = ? AND mode = 'daily'").get(group.id);
  expect(daily.period_key).not.toBeNull();

  const adhoc = openMatch({ group, mode: '1v1', start: Date.now() + DAY, end: Date.now() + 2 * DAY });
  expect(adhoc.period_key).toBeNull();
});

test('a lobby whose start is still ahead stays open', () => {
  const a = makeUser('a');
  const b = makeUser('b');
  const group = makeGroup('UTC', [a, b]);
  const start = Date.now() + DAY;
  const m = openMatch({ group, mode: '1v1', start, end: start + DAY, roster: [{ userId: a }, { userId: b }] });
  lockDueLobbies(Date.now());
  expect(matchById(m.id).state).toBe('open');
});

// ── settlement ───────────────────────────────────────────────────────────────

test('settling a daily match moves rating from the idle player to the active one', () => {
  const a = makeUser('active');
  const b = makeUser('idle');
  const group = makeGroup('UTC', [a, b]);
  const now = Date.parse('2026-07-26T10:00:00Z');
  ensureRecurringMatches(now);

  const daily = db.prepare("SELECT * FROM matches WHERE group_id = ? AND mode = 'daily'").get(group.id);
  joinMatch(daily.id, [a, b]);
  logCoffee(a, daily.scope_start + 3600000, { mg: 150 });

  settleMatch(daily, daily.scope_end + 1);

  const rows = participants(daily.id);
  const active = rows.find((r) => r.user_id === a);
  const idle = rows.find((r) => r.user_id === b);

  expect(matchById(daily.id).state).toBe('settled');
  expect(active.delta).toBeGreaterThan(0);
  expect(idle.delta).toBeLessThan(0);
  expect(active.delta + idle.delta).toBe(0);
  expect(active.rating_before).toBe(BASE_RATING);
  expect(active.rating_after).toBe(BASE_RATING + active.delta);
  expect(idle.score).toBe(0);

  // Whole points survive the round-trip through SQLite's REAL columns (#49).
  for (const r of rows) expect(Number.isInteger(r.delta)).toBe(true);
  expect(Number.isInteger(ratingOf(a))).toBe(true);

  expect(ratingOf(a)).toBe(active.rating_after);
  expect(ratingOf(b)).toBe(idle.rating_after);
  expect(db.prepare('SELECT matches FROM user_ratings WHERE user_id = ?').get(a).matches).toBe(1);
});

test('a settled match is never settled twice', () => {
  const a = makeUser('a');
  const b = makeUser('b');
  const group = makeGroup('UTC', [a, b]);
  // Mid-week on purpose: on a Sunday the daily and weekly windows close at the
  // same instant, which would make the "only one match was due" check vacuous.
  const now = Date.parse('2026-07-22T10:00:00Z');
  ensureRecurringMatches(now);
  const daily = db.prepare("SELECT * FROM matches WHERE group_id = ? AND mode = 'daily'").get(group.id);
  joinMatch(daily.id, [a, b]);
  logCoffee(a, daily.scope_start + 1000, { mg: 150 });
  lockDueLobbies(daily.scope_start); // the lobby goes live before it can settle

  const after = daily.scope_end + 1;
  // Only the daily window has closed — the weekly one still has days to run.
  expect(settleDueMatches(after)).toBe(1);
  const ratingAfterFirst = ratingOf(a);

  expect(settleDueMatches(after + 1000)).toBe(0);
  expect(ratingOf(a)).toBe(ratingAfterFirst);
  expect(db.prepare('SELECT matches FROM user_ratings WHERE user_id = ?').get(a).matches).toBe(1);
});

test('the whole ticker pass is safe to run repeatedly', () => {
  const a = makeUser('a');
  const b = makeUser('b');
  makeGroup('UTC', [a, b]);
  tick();
  tick();
  tick();
  const counts = db.prepare('SELECT mode, COUNT(*) AS c FROM matches GROUP BY mode').all();
  for (const row of counts) expect(row.c).toBe(1);
});

test('a settled match stores the raw points, and grades on the margin between them', () => {
  const [lead, near, far] = ['lead', 'near', 'far'].map((n) => makeUser(n));
  const group = makeGroup('UTC', [lead, near, far]);
  const start = Date.now() - DAY;
  const end = Date.now() - 1000;

  const match = openMatch({
    group, mode: 'ondemand', start, end, state: 'pending',
    roster: [{ userId: lead }, { userId: near }, { userId: far }],
  });

  // 300 / 250 / 60 points — `near` finishes just behind the lead and well clear
  // of `far`, which under v1's rank-only settlement would have paid the same as
  // finishing last. Two cups and two kinds are worth 60 of each of the first
  // two totals; one cup and one kind are worth 30 of the last.
  logCoffee(lead, start + 1000, { mg: 240, coffeeId: 'espresso' });
  logCoffee(lead, start + 2000, { mg: 0, coffeeId: 'decaf' });
  logCoffee(near, start + 1000, { mg: 190, coffeeId: 'espresso' });
  logCoffee(near, start + 2000, { mg: 0, coffeeId: 'decaf' });
  logCoffee(far, start + 1000, { mg: 30, coffeeId: 'espresso' });

  settleMatch(match, end + 1);

  const rows = participants(match.id);
  const byUser = new Map(rows.map((r) => [r.user_id, r]));
  expect(matchById(match.id).state).toBe('settled');

  // The stored score is the raw point total — no 0..1000 transform anywhere.
  expect(byUser.get(lead).score).toBe(300);
  expect(byUser.get(near).score).toBe(250);
  expect(byUser.get(far).score).toBe(60);

  expect(rows.reduce((s, r) => s + r.delta, 0)).toBe(0);
  for (const r of rows) expect(Number.isInteger(r.delta)).toBe(true);
  // Second place, 50 points off the lead and 190 clear of last, GAINS rating.
  expect(byUser.get(near).delta).toBeGreaterThan(0);
  expect(byUser.get(lead).delta).toBeGreaterThan(byUser.get(near).delta);
  expect(byUser.get(far).delta).toBeLessThan(0);

  // Team mode is gone: nothing writes a side or a contribution share any more.
  for (const r of rows) {
    expect(r.side).toBeNull();
    expect(r.contribution_share).toBeNull();
  }
});

test('a pending match that lost all but one player is cancelled rather than settled', () => {
  const users = ['solo', 'gone'].map((n) => makeUser(n));
  const group = makeGroup('UTC', users);
  const start = Date.now() - DAY;
  const end = Date.now() - 1000;
  const match = openMatch({
    group, mode: 'ondemand', start, end, state: 'pending',
    roster: [{ userId: users[0] }],
  });

  settleMatch(match, end + 1);
  expect(matchById(match.id).state).toBe('cancelled');
  expect(db.prepare('SELECT COUNT(*) AS c FROM user_ratings').get().c).toBe(0);
});

test('private logging can lose a match that public logging would have won', () => {
  // The accepted consequence, made explicit: this is a rule change with real
  // standings impact, not a tidy-up.
  const [quiet, loud] = ['quiet', 'loud'].map((n) => makeUser(n));
  const group = makeGroup('UTC', [quiet, loud]);
  const start = Date.now() - DAY;
  const end = Date.now() - 1000;
  const match = openMatch({
    group, mode: '1v1', start, end, state: 'pending',
    roster: [{ userId: quiet }, { userId: loud }],
  });

  // `quiet` drank far more, but kept almost all of it private.
  for (let i = 0; i < 6; i++) {
    logCoffee(quiet, start + i * 60000, { mg: 120, coffeeId: 'espresso', isPublic: 0 });
  }
  logCoffee(quiet, start + 7 * 60000, { mg: 30, coffeeId: 'lungo' });
  logCoffee(loud, start + 1000, { mg: 150, coffeeId: 'espresso' });

  settleMatch(match, end + 1);

  const byUser = new Map(participants(match.id).map((r) => [r.user_id, r]));
  expect(byUser.get(quiet).score).toBe(points({ caffeine: 30, cups: 1, variety: 1 }));
  expect(byUser.get(loud).score).toBe(points({ caffeine: 150, cups: 1, variety: 1 }));
  expect(byUser.get(quiet).delta).toBeLessThan(0);
  expect(byUser.get(loud).delta).toBeGreaterThan(0);
});

test('ratings compound across matches — the second match starts from the first result', () => {
  const a = makeUser('a');
  const b = makeUser('b');
  const group = makeGroup('UTC', [a, b]);

  const runDay = (dayInstant) => {
    ensureRecurringMatch(group, 'daily', dayInstant);
    const m = db.prepare("SELECT * FROM matches WHERE group_id = ? AND mode = 'daily' AND state = 'open' ORDER BY scope_start DESC")
      .get(group.id);
    joinMatch(m.id, [a, b]);
    logCoffee(a, m.scope_start + 1000, { mg: 150 });
    settleMatch(m, m.scope_end + 1);
    return m;
  };

  const first = runDay(Date.parse('2026-07-26T10:00:00Z'));
  const second = runDay(Date.parse('2026-07-27T10:00:00Z'));

  const p1 = participants(first.id).find((p) => p.user_id === a);
  const p2 = participants(second.id).find((p) => p.user_id === a);
  expect(p2.rating_before).toBe(p1.rating_after);
  expect(db.prepare('SELECT matches FROM user_ratings WHERE user_id = ?').get(a).matches).toBe(2);
});

test('groupOf returns the one group a user is in', () => {
  const a = makeUser('a');
  expect(groupOf(a)).toBeNull(); // bun:sqlite .get() misses as null, not undefined
  const group = makeGroup('UTC', [a]);
  expect(groupOf(a).id).toBe(group.id);
});

// ── migration 015: re-evaluate history into whole points (#49) ───────────────

const resettle = require('./migrations/015_resettle_whole_point_elo');

// The K these historical matches were CREATED with, which is what the migration
// replays them at. Hard-coded to v1's table rather than read from K_BY_MODE: a
// settled match keeps the k_factor stored on its row forever, so retuning the
// live table must not move this test's expectations.
const K_V1_DAILY = 8;
const K_V1_TEAM = 24;

// A match already in the 'settled' state carrying a deliberately fractional
// ledger, the way pre-#49 data looks. Scores are what settlement reads back;
// the rating_* / delta / share values are junk the migration must overwrite.
//
// These rows are v1 history: 0..1 scores, team mode, the old K. v2 never
// produces anything like them, and never rewrites them either.
function seedSettledMatch({ group, mode = 'daily', settledAt, parts }) {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO matches (id, group_id, mode, period_key, title, creator_id,
                         scope_start, scope_end, state, k_factor, team_size, created_at, settled_at)
    VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, 'settled', ?, ?, ?, ?)
  `).run(id, group.id, mode, settledAt - DAY, settledAt - 1,
    mode === 'team' ? K_V1_TEAM : K_V1_DAILY,
    mode === 'team' ? 2 : null, settledAt - DAY, settledAt);
  let joinedAt = settledAt - DAY;
  for (const p of parts) {
    db.prepare(`
      INSERT INTO match_participants
        (id, match_id, user_id, side, joined_at, score, contribution_share, rating_before, rating_after, delta)
      VALUES (?, ?, ?, ?, ?, ?, 0.123, 1000.5, 1007.7, 7.2)
    `).run(randomUUID(), id, p.userId, p.side ?? null, joinedAt++, p.score);
  }
  return id;
}

test('migration 015 re-evaluates settled matches into whole, zero-sum, compounding deltas', () => {
  const a = makeUser('a');
  const b = makeUser('b');
  const group = makeGroup('UTC', [a, b]);
  const t1 = Date.parse('2026-07-26T10:00:00Z');
  const t2 = Date.parse('2026-07-27T10:00:00Z');

  const m1 = seedSettledMatch({ group, settledAt: t1, parts: [{ userId: a, score: 0.4 }, { userId: b, score: 0 }] });
  const m2 = seedSettledMatch({ group, settledAt: t2, parts: [{ userId: a, score: 0.1 }, { userId: b, score: 0.6 }] });

  resettle.up(db);

  const p1 = participants(m1);
  const p2 = participants(m2);
  for (const r of [...p1, ...p2]) expect(Number.isInteger(r.delta)).toBe(true);
  expect(p1.reduce((s, r) => s + r.delta, 0)).toBe(0);
  expect(p2.reduce((s, r) => s + r.delta, 0)).toBe(0);

  // The re-evaluated deltas are exactly what the v1 settlement produces — the
  // one this migration was written against, at the K the match was created with.
  const fresh = settleFfaV1(
    [{ userId: a, rating: BASE_RATING, score: 0.4 }, { userId: b, rating: BASE_RATING, score: 0 }],
    K_V1_DAILY,
  );
  const a1 = p1.find((r) => r.user_id === a);
  expect(a1.delta).toBe(fresh.find((r) => r.userId === a).delta);

  // First match settles from the base rating; the second compounds off the first.
  for (const r of p1) expect(r.rating_before).toBe(BASE_RATING);
  const a2 = p2.find((r) => r.user_id === a);
  expect(a2.rating_before).toBe(a1.rating_after);

  // The derived cache is rebuilt whole, counts both matches, and stamps the last settle.
  const ra = db.prepare('SELECT * FROM user_ratings WHERE user_id = ?').get(a);
  expect(Number.isInteger(ra.rating)).toBe(true);
  expect(ra.rating).toBe(a2.rating_after);
  expect(ra.matches).toBe(2);
  expect(ra.updated_at).toBe(t2);
});

test('migration 015 leaves a team match zero-sum with whole deltas and a fresh share', () => {
  const users = ['a1', 'a2', 'b1', 'b2'].map((n) => makeUser(n));
  const group = makeGroup('UTC', users);
  const m = seedSettledMatch({
    group, mode: 'team', settledAt: Date.parse('2026-07-26T10:00:00Z'),
    parts: [
      { userId: users[0], side: 'A', score: 0.7 }, { userId: users[1], side: 'A', score: 0.2 },
      { userId: users[2], side: 'B', score: 0.3 }, { userId: users[3], side: 'B', score: 0.1 },
    ],
  });

  resettle.up(db);

  const rows = participants(m);
  for (const r of rows) expect(Number.isInteger(r.delta)).toBe(true);
  expect(rows.reduce((s, r) => s + r.delta, 0)).toBe(0);
  for (const r of rows) expect(r.contribution_share).toBeGreaterThan(0);
  expect(rows.filter((r) => r.side === 'A').reduce((s, r) => s + r.delta, 0))
    .toBe(-rows.filter((r) => r.side === 'B').reduce((s, r) => s + r.delta, 0));
});

test('migration 015 is a no-op on a match-less database', () => {
  expect(() => resettle.up(db)).not.toThrow();
  expect(db.prepare('SELECT COUNT(*) AS c FROM user_ratings').get().c).toBe(0);
});

test('migration 015 is idempotent — a second pass reproduces the same ledger', () => {
  const a = makeUser('a');
  const b = makeUser('b');
  const group = makeGroup('UTC', [a, b]);
  const m = seedSettledMatch({ group, settledAt: Date.parse('2026-07-26T10:00:00Z'), parts: [{ userId: a, score: 0.5 }, { userId: b, score: 0.1 }] });

  resettle.up(db);
  const first = participants(m).map((r) => r.delta).sort((x, y) => x - y);
  resettle.up(db);
  const second = participants(m).map((r) => r.delta).sort((x, y) => x - y);
  expect(second).toEqual(first);
});

// ── match_end notifications (issue #32) ────────────────────────────────────────

test('settlement writes one match_end notification per participant, ranked by score', () => {
  const [lead, near, far] = ['lead', 'near', 'far'].map((n) => makeUser(n));
  const group = makeGroup('UTC', [lead, near, far]);
  const start = Date.now() - DAY;
  const end = Date.now() - 1000;
  const match = openMatch({
    group, mode: 'ondemand', start, end, state: 'pending',
    roster: [{ userId: lead }, { userId: near }, { userId: far }],
  });
  logCoffee(lead, start + 1000, { mg: 240 });
  logCoffee(near, start + 1000, { mg: 120 });
  logCoffee(far, start + 1000, { mg: 30 });

  settleMatch(match, end + 1);

  // Exactly one row per participant — winners, losers and everyone between.
  expect(notificationsFor(lead)).toHaveLength(1);
  expect(notificationsFor(near)).toHaveLength(1);
  expect(notificationsFor(far)).toHaveLength(1);

  // Rank tracks score desc; participant_count is the whole roster on every row.
  expect(notificationsFor(lead)[0].payload.rank).toBe(1);
  expect(notificationsFor(near)[0].payload.rank).toBe(2);
  expect(notificationsFor(far)[0].payload.rank).toBe(3);
  for (const u of [lead, near, far]) {
    expect(notificationsFor(u)[0].payload.participant_count).toBe(3);
  }
});

test('a match_end payload freezes the group name, match id and the player\'s own delta', () => {
  const [a, b] = ['a', 'b'].map((n) => makeUser(n));
  const group = makeGroup('UTC', [a, b]);
  const start = Date.now() - DAY;
  const end = Date.now() - 1000;
  const match = openMatch({
    group, mode: '1v1', start, end, state: 'pending',
    roster: [{ userId: a }, { userId: b }],
  });
  logCoffee(a, start + 1000, { mg: 150 });
  logCoffee(b, start + 1000, { mg: 30 });

  settleMatch(match, end + 1);

  const p = notificationsFor(a)[0].payload;
  expect(p.match_id).toBe(match.id);
  expect(p.group_id).toBe(group.id);
  expect(p.group_name).toBe(group.name);
  // The frozen delta matches the row written to match_participants.
  const row = participants(match.id).find((r) => r.user_id === a);
  expect(p.delta).toBe(row.delta);
  expect(p.rating_after).toBe(row.rating_after);
});

test('a cancelled settlement (only one player) writes no match_end notification', () => {
  const solo = makeUser('solo');
  const group = makeGroup('UTC', [solo]);
  const start = Date.now() - DAY;
  const end = Date.now() - 1000;
  const match = openMatch({
    group, mode: 'ondemand', start, end, state: 'pending',
    roster: [{ userId: solo }],
  });

  settleMatch(match, end + 1);
  expect(matchById(match.id).state).toBe('cancelled');
  expect(notificationsFor(solo)).toHaveLength(0);
});

// ── days off / group schedule (issue #18) ────────────────────────────────────

// Set the schedule on an existing group row and return the reloaded row, the
// shape ensureRecurringMatch / offRangesForMatch read.
function setSchedule(group, { mask = 127, from = null, to = null } = {}) {
  db.prepare('UPDATE competition_groups SET active_weekdays = ?, pause_from = ?, pause_to = ? WHERE id = ?')
    .run(mask, from, to, group.id);
  return db.prepare('SELECT * FROM competition_groups WHERE id = ?').get(group.id);
}

// bit0 = Monday ... bit6 = Sunday. Mon 2026-07-27 is index 0.
const MON = 1 << 0;
const ALL = 127;

test('a masked-off weekday opens no daily; a default group still does', () => {
  const a = makeUser('a');
  const b = makeUser('b');
  // Sunday 2026-07-26: the daily that opens is TOMORROW's, Monday 2026-07-27.
  const now = Date.parse('2026-07-26T10:00:00Z');

  const off = setSchedule(makeGroup('UTC', [a, b]), { mask: ALL & ~MON }); // Monday off
  ensureRecurringMatch(off, 'daily', now);
  expect(db.prepare("SELECT COUNT(*) AS c FROM matches WHERE group_id = ? AND mode = 'daily'").get(off.id).c).toBe(0);

  const on = makeGroup('UTC', [makeUser('c'), makeUser('d')]); // default 127
  ensureRecurringMatch(on, 'daily', now);
  expect(db.prepare("SELECT period_key FROM matches WHERE group_id = ? AND mode = 'daily'").get(on.id).period_key)
    .toBe('2026-07-27');
});

test('a fully-off week opens no weekly; a partially-off week still does', () => {
  const now = Date.parse('2026-07-25T10:00:00Z'); // Sat: the weekly for Mon 2026-07-27 opens

  const dead = setSchedule(makeGroup('UTC', [makeUser('a'), makeUser('b')]), { mask: 0 });
  expect(wholeWeekOff(dead, '2026-07-27')).toBe(true);
  ensureRecurringMatch(dead, 'weekly', now);
  expect(db.prepare("SELECT COUNT(*) AS c FROM matches WHERE group_id = ? AND mode = 'weekly'").get(dead.id).c).toBe(0);

  const partial = setSchedule(makeGroup('UTC', [makeUser('c'), makeUser('d')]), { mask: ALL & ~MON });
  ensureRecurringMatch(partial, 'weekly', now);
  expect(db.prepare("SELECT period_key FROM matches WHERE group_id = ? AND mode = 'weekly'").get(partial.id).period_key)
    .toBe('2026-07-27');
});

test('a pause range covering the daily date opens no daily', () => {
  const a = makeUser('a');
  const b = makeUser('b');
  const now = Date.parse('2026-07-26T10:00:00Z'); // daily opens for Mon 2026-07-27
  const paused = setSchedule(makeGroup('UTC', [a, b]), { from: '2026-07-27', to: '2026-07-30' });

  expect(dayIsOff(paused, '2026-07-27')).toBe(true);
  ensureRecurringMatch(paused, 'daily', now);
  expect(db.prepare("SELECT COUNT(*) AS c FROM matches WHERE group_id = ? AND mode = 'daily'").get(paused.id).c).toBe(0);
});

test("a weekly's score drops coffees logged on off days (mask), keeps the rest", () => {
  const user = makeUser('u');
  const group = setSchedule(makeGroup('UTC', [user, makeUser('o')]), { mask: ALL & ~MON }); // Monday off
  const { start, end } = weeklyWindow(group, Date.parse('2026-07-27T10:00:00Z'));
  const match = openMatch({ group, mode: 'weekly', start, end, state: 'pending', roster: [{ userId: user }] });

  logCoffee(user, Date.parse('2026-07-27T10:00:00Z'), { coffeeId: 'espresso', mg: 100 }); // Monday: off
  logCoffee(user, Date.parse('2026-07-28T10:00:00Z'), { coffeeId: 'latte', mg: 80 });     // Tuesday: on

  const excluded = offRangesForMatch(match);
  // Monday drops out, so the schedule-aware score is exactly the Tue-onward
  // window (Wed-Sun are empty) — and strictly less than counting both cups.
  const tueOnward = Date.parse('2026-07-28T00:00:00Z');
  expect(scoreFor(user, start, end, excluded)).toBe(scoreFor(user, tueOnward, end));
  expect(scoreFor(user, start, end, excluded)).toBeLessThan(scoreFor(user, start, end));
});

test('a pause inside a partial week is excluded from the weekly score', () => {
  const user = makeUser('u');
  // Pause Tue-Wed of the week of Mon 2026-07-27.
  const group = setSchedule(makeGroup('UTC', [user, makeUser('o')]), { from: '2026-07-28', to: '2026-07-29' });
  const { start, end } = weeklyWindow(group, Date.parse('2026-07-27T10:00:00Z'));
  const match = openMatch({ group, mode: 'weekly', start, end, state: 'pending', roster: [{ userId: user }] });

  logCoffee(user, Date.parse('2026-07-27T10:00:00Z'), { mg: 50 });                      // Mon: on
  logCoffee(user, Date.parse('2026-07-28T10:00:00Z'), { coffeeId: 'x', mg: 999 });      // Tue: paused
  logCoffee(user, Date.parse('2026-07-29T10:00:00Z'), { coffeeId: 'y', mg: 999 });      // Wed: paused

  const excluded = offRangesForMatch(match);
  // Thu-Sun are empty, so the surviving score is exactly Monday's single cup.
  const monEnd = Date.parse('2026-07-28T00:00:00Z') - 1;
  expect(scoreFor(user, start, end, excluded)).toBe(scoreFor(user, start, monEnd));
  expect(scoreFor(user, start, end, excluded)).toBeLessThan(scoreFor(user, start, end));
});
