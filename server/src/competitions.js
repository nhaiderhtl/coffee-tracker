// Competitions — everything that touches SQLite. The math lives in
// ./competition-core.js and never imports the database.
//
// Responsibilities:
//   - work out a group's civil day / week window (in the GROUP's zone)
//   - open the recurring daily/weekly matches for each group
//   - lock user-created lobbies when their start instant arrives
//   - settle any match whose window has closed, writing an immutable
//     match_participants row per player and updating the rating cache
//
// Nothing here recomputes a settled match. Settlement writes once.

const { randomUUID } = require('crypto');
const db = require('./db');
const {
  BASE_RATING, K_BY_MODE,
  points, settleFfa, marginScaleFor,
} = require('./competition-core');
const { localDateStr, localWallInstant, localDayBounds, isValidTz, DEFAULT_TZ } = require('./time');
const { scoreMgSql } = require('./coffees');
const { createNotification, TYPES } = require('./notifications');
const { broadcast } = require('./events');

// How often the ticker looks for work. A match settles on the first tick after
// its window closes, so this is also the worst-case settlement lag.
const TICK_MS = 60 * 1000;

// How far ahead a recurring match opens for joining. Both are lobbies: they
// exist before their window starts precisely so members have a period in which
// to join them, because nothing joins on a member's behalf.
const DAILY_LEAD_DAYS = 1;   // tomorrow's daily is joinable all of today
const WEEKLY_LEAD_DAYS = 2;  // next week's weekly opens on the Saturday before

// ── civil windows (group zone) ───────────────────────────────────────────────

function groupTz(group) {
  return isValidTz(group.timezone) ? group.timezone : DEFAULT_TZ;
}

// Local date of the Monday that starts the local week containing `dateStr`.
// Pure label arithmetic (parsed as UTC), so no zone is involved — a calendar
// date's weekday is the same wherever you evaluate it.
function mondayOf(dateStr) {
  const t = Date.parse(`${dateStr}T00:00:00Z`);
  const dow = new Date(t).getUTCDay(); // 0 = Sunday
  const back = (dow + 6) % 7;
  return new Date(t - back * 86400000).toISOString().slice(0, 10);
}

function addDaysStr(dateStr, n) {
  return new Date(Date.parse(`${dateStr}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

// The daily window `offsetDays` from the group's current local day.
// offsetDays = 0 is today, 1 is tomorrow (the one that opens for joining).
function dailyWindow(group, now = Date.now(), offsetDays = 0) {
  const tz = groupTz(group);
  const date = addDaysStr(localDateStr(now, tz), offsetDays);
  const { start, end } = localDayBounds(date, tz);
  return { periodKey: date, start, end };
}

// The weekly window containing "now plus `offsetDays`", Monday-anchored in the
// group's zone. With the weekly lead time this rolls over to next week's match
// exactly `WEEKLY_LEAD_DAYS` before it starts.
function weeklyWindow(group, now = Date.now(), offsetDays = 0) {
  const tz = groupTz(group);
  const monday = mondayOf(addDaysStr(localDateStr(now, tz), offsetDays));
  const start = localWallInstant(monday, '00:00:00', tz);
  const end = localWallInstant(addDaysStr(monday, 7), '00:00:00', tz) - 1;
  return { periodKey: monday, start, end };
}

// ── group schedule / days off (issue #18) ────────────────────────────────────

// Every weekday active — the default mask, and the value that means "no schedule
// restriction", identical to the behaviour before schedules existed.
const ALL_WEEKDAYS = 127;

// Weekday index of a civil date, Monday-anchored (0 = Mon ... 6 = Sun) to match
// the weekly window and the active_weekdays bit order. Pure label arithmetic.
function weekdayIdx(dateStr) {
  const dow = new Date(Date.parse(`${dateStr}T00:00:00Z`)).getUTCDay(); // 0 = Sun
  return (dow + 6) % 7;
}

// Is this civil date off for the group — either masked out of active_weekdays or
// inside the inclusive pause range? Dates are compared as strings (ISO sorts
// chronologically), all in the group's own zone.
function dayIsOff(group, dateStr) {
  const mask = group.active_weekdays ?? ALL_WEEKDAYS;
  if (!(mask & (1 << weekdayIdx(dateStr)))) return true;
  if (group.pause_from && group.pause_to
      && dateStr >= group.pause_from && dateStr <= group.pause_to) return true;
  return false;
}

// The instant sub-ranges of [start, end] that fall on the group's off days, in
// the group's zone. These are excluded from scoring so a coffee logged on an off
// day never counts toward a competition. Contiguous off days are merged so a
// long pause adds one clause, not thirty.
//
// Fast path: a group with every weekday on and no pause excludes nothing, which
// is every group that has never touched its schedule.
function offRanges(group, start, end) {
  const mask = group.active_weekdays ?? ALL_WEEKDAYS;
  const hasPause = !!(group.pause_from && group.pause_to);
  if (mask === ALL_WEEKDAYS && !hasPause) return [];

  const tz = groupTz(group);
  const lastDate = localDateStr(end, tz);
  const ranges = [];
  for (let d = localDateStr(start, tz); d <= lastDate; d = addDaysStr(d, 1)) {
    if (!dayIsOff(group, d)) continue;
    const bounds = localDayBounds(d, tz);
    const from = Math.max(bounds.start, start);
    const to = Math.min(bounds.end, end);
    if (from > to) continue;
    const prev = ranges[ranges.length - 1];
    if (prev && from <= prev[1] + 1) prev[1] = to; // merge with the day before
    else ranges.push([from, to]);
  }
  return ranges;
}

// Off ranges for a specific match, read from its group's live schedule. A global
// (group-less) match has no schedule and excludes nothing.
function offRangesForMatch(match) {
  if (!match.group_id) return [];
  const group = db.prepare(
    'SELECT timezone, active_weekdays, pause_from, pause_to FROM competition_groups WHERE id = ?'
  ).get(match.group_id);
  return group ? offRanges(group, match.scope_start, match.scope_end) : [];
}

// Every day of the Monday-anchored week starting `monday` is off. Used to decide
// whether to bother opening a weekly at all — a week with even one active day is
// still created; only a fully-off week is skipped.
function wholeWeekOff(group, monday) {
  for (let i = 0; i < 7; i++) {
    if (!dayIsOff(group, addDaysStr(monday, i))) return false;
  }
  return true;
}

// ── layer 1: score a user over a window ──────────────────────────────────────

// Only PUBLIC entries count toward a competition, and only these two queries
// apply that filter — Buzz, stats, streaks, achievements, casualties, rankings
// and community challenges keep counting every entry. It is load-bearing, not
// cosmetic: a participant who logs mostly privately can go from first to last.
//
// `logged_at` (the user-stated drinking time), not `created_at`, decides window
// membership, and both bounds are inclusive.
//
// Caffeine is summed through scoreMgSql(), not the stored caffeine_mg — a few
// drinks score differently from what the app displays. See ./coffees.js
// (the score_caffeine override column, issue #77; formerly data/coffee-scores.js).
const metricsStmt = () => db.prepare(`
  SELECT COALESCE(SUM(${scoreMgSql()}), 0) AS caffeine,
         COUNT(*)                          AS cups,
         COUNT(DISTINCT coffee_id)         AS variety
  FROM coffee_entries
  WHERE user_id = ? AND is_public = 1 AND logged_at >= ? AND logged_at <= ?
`);

// SQL that removes each excluded instant range from a `logged_at` window, plus
// the params to bind. `excluded` is [[from, to], ...] (see offRanges); an empty
// list produces no clause and no params, so the fast prepared path is unchanged.
function excludeClause(excluded) {
  if (excluded.length === 0) return { sql: '', params: [] };
  return {
    sql: excluded.map(() => 'AND NOT (logged_at >= ? AND logged_at <= ?)').join(' '),
    params: excluded.flatMap(([from, to]) => [from, to]),
  };
}

// Raw metrics a user accumulated inside a match window, minus any off-day ranges
// (issue #18). With no exclusions this is one shared prepared statement; with
// them the query is built per call, which only happens for a scheduled group.
function metricsFor(userId, start, end, excluded = []) {
  if (excluded.length === 0) return metricsStmt().get(userId, start, end);
  const { sql, params } = excludeClause(excluded);
  return db.prepare(`
    SELECT COALESCE(SUM(${scoreMgSql()}), 0) AS caffeine,
           COUNT(*)                          AS cups,
           COUNT(DISTINCT coffee_id)         AS variety
    FROM coffee_entries
    WHERE user_id = ? AND is_public = 1 AND logged_at >= ? AND logged_at <= ? ${sql}
  `).get(userId, start, end, ...params);
}

// The points a user earned inside a match window. Linear and uncapped — this is
// the number the UI shows, raw, with no maximum to render it against.
function scoreFor(userId, start, end, excluded = []) {
  return points(metricsFor(userId, start, end, excluded));
}

// Same thing for a whole roster, in ONE query instead of one per player.
// Rendering a match list means scoring every participant of every match, so the
// per-user form turns a page load into hundreds of round trips.
// Returns Map(userId -> points); users with no entries are absent, so read it
// with `?? 0`.
function scoresForMany(userIds, start, end, excluded = []) {
  if (userIds.length === 0) return new Map();
  const holes = userIds.map(() => '?').join(',');
  const { sql, params } = excludeClause(excluded);
  const rows = db.prepare(`
    SELECT user_id,
           COALESCE(SUM(${scoreMgSql()}), 0) AS caffeine,
           COUNT(*)                          AS cups,
           COUNT(DISTINCT coffee_id)         AS variety
    FROM coffee_entries
    WHERE user_id IN (${holes}) AND is_public = 1
      AND logged_at >= ? AND logged_at <= ? ${sql}
    GROUP BY user_id
  `).all(...userIds, start, end, ...params);
  return new Map(rows.map((r) => [r.user_id, points(r)]));
}

// Ratings for a whole roster in one query. Absent users are unrated, so read
// with `?? BASE_RATING`.
function ratingsForMany(userIds) {
  if (userIds.length === 0) return new Map();
  const holes = userIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT user_id, rating FROM user_ratings WHERE user_id IN (${holes})`)
    .all(...userIds);
  return new Map(rows.map((r) => [r.user_id, r.rating]));
}

// ── rating cache ─────────────────────────────────────────────────────────────

function ratingOf(userId) {
  const row = db.prepare('SELECT rating FROM user_ratings WHERE user_id = ?').get(userId);
  return row ? row.rating : BASE_RATING;
}

function writeRating(userId, rating, now) {
  db.prepare(`
    INSERT INTO user_ratings (user_id, rating, matches, updated_at)
    VALUES (?, ?, 1, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      rating = excluded.rating,
      matches = user_ratings.matches + 1,
      updated_at = excluded.updated_at
  `).run(userId, rating, now);
}

// ── creating the recurring matches ───────────────────────────────────────────

// The group a user belongs to, or null. Membership is exclusive — the
// UNIQUE on group_members.user_id means this is always at most one row.
function groupOf(userId) {
  return db.prepare(`
    SELECT g.* FROM competition_groups g
    JOIN group_members m ON m.group_id = g.id
    WHERE m.user_id = ?
  `).get(userId);
}

function memberIds(groupId) {
  return db.prepare('SELECT user_id FROM group_members WHERE group_id = ? ORDER BY joined_at')
    .all(groupId).map((r) => r.user_id);
}

// Members who asked to be entered into this mode's recurring matches without
// pressing join each time. Opt-in only: a member who has not set the flag is
// never placed on a roster by the server.
function autoJoinMemberIds(groupId, mode) {
  const column = mode === 'daily' ? 'auto_join_daily' : 'auto_join_weekly';
  return db.prepare(`
    SELECT m.user_id FROM group_members m
    JOIN users u ON u.id = m.user_id
    WHERE m.group_id = ? AND u.${column} = 1
    ORDER BY m.joined_at
  `).all(groupId).map((r) => r.user_id);
}

// Open one recurring match if it does not already exist for this period.
//
// It opens as a LOBBY, ahead of its own window (a day early for daily, two for
// weekly), and starts EMPTY. Group membership does not put anyone on a roster:
// being in a group means you may join its matches, not that you are entered in
// all of them. The only exception is a member who explicitly turned on
// auto-join for this mode, which is what that preference means.
//
// Group size still gates creation: with fewer than two members nobody could
// field a legal roster by the start instant, so the lobby would only ever be
// cancelled.
function ensureRecurringMatch(group, mode, now) {
  const leadDays = mode === 'daily' ? DAILY_LEAD_DAYS : WEEKLY_LEAD_DAYS;
  const { periodKey, start, end } = mode === 'daily'
    ? dailyWindow(group, now, leadDays)
    : weeklyWindow(group, now, leadDays);

  const existing = db.prepare(
    'SELECT id FROM matches WHERE group_id = ? AND mode = ? AND period_key = ?'
  ).get(group.id, mode, periodKey);
  if (existing) return null;

  // Days off (issue #18): a daily is not opened on an off day at all, and a
  // weekly is skipped only when its whole week is off — a week with even one
  // active day still runs and simply drops its off days from the score.
  if (mode === 'daily' ? dayIsOff(group, periodKey) : wholeWeekOff(group, periodKey)) {
    return null;
  }

  // Never open a period that is already under way. The lead time only lands on
  // a future window when it crosses a period boundary — weekly's two days do
  // that on Sat/Sun only, so Mon-Fri this asks for the CURRENT week. For a
  // group that already has the row that is a no-op (caught above), but a group
  // that crosses two members mid-week would otherwise get a match whose window
  // opened days before it existed: cancelled on the next tick at best, and at
  // worst settled over days nobody was in the group for.
  if (start <= now) return null;

  if (memberIds(group.id).length < 2) return null;

  const matchId = randomUUID();
  const insertMatch = db.prepare(`
    INSERT INTO matches (id, group_id, mode, period_key, title, creator_id,
                         scope_start, scope_end, state, k_factor, team_size, created_at)
    VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, 'open', ?, NULL, ?)
  `);
  const insertParticipant = db.prepare(
    'INSERT INTO match_participants (id, match_id, user_id, side, joined_at) VALUES (?, ?, ?, NULL, ?)'
  );

  db.transaction(() => {
    insertMatch.run(matchId, group.id, mode, periodKey, start, end, K_BY_MODE[mode], now);
    for (const userId of autoJoinMemberIds(group.id, mode)) {
      insertParticipant.run(randomUUID(), matchId, userId, now);
    }
  })();

  return matchId;
}

function ensureRecurringMatches(now = Date.now()) {
  const groups = db.prepare(
    'SELECT id, timezone, active_weekdays, pause_from, pause_to FROM competition_groups'
  ).all();
  for (const group of groups) {
    ensureRecurringMatch(group, 'daily', now);
    ensureRecurringMatch(group, 'weekly', now);
  }
}

// ── locking lobbies ──────────────────────────────────────────────────────────

// The instant a lobby stops accepting joins and its roster locks.
//
// For most modes that is the start instant: once a match is running its roster
// is frozen, which is what stops a player dodging a bad day. A WEEKLY is the
// exception (issue #44): nobody joins a weekly at 00:00 Monday, so a Monday-start
// lock shuts almost everyone out. A weekly therefore stays joinable through its
// whole first civil day and only locks at the next local midnight. The scoring
// window is unchanged — every participant is still scored over the identical
// Mon–Sun window, so a day-1 joiner is judged on the same window as everyone
// else and the zero-sum argument is untouched.
function joinDeadline(match) {
  if (match.mode !== 'weekly') return match.scope_start;
  const group = db.prepare('SELECT timezone FROM competition_groups WHERE id = ?').get(match.group_id);
  const tz = groupTz(group || { timezone: DEFAULT_TZ });
  // period_key is the Monday's local date; the first day ends at the next local
  // midnight, evaluated in the group's zone so DST is handled by time.js.
  return localWallInstant(addDaysStr(match.period_key, 1), '00:00:00', tz);
}

// A user-created match accepts joins until its start instant. At that point the
// roster must be legal for its mode, or the match is cancelled without touching
// anyone's rating.
function rosterIsLegal(match, participants) {
  if (match.mode === '1v1') return participants.length === 2;
  // ondemand, daily and weekly are free-for-alls: any two players make a match.
  // A recurring lobby nobody joined is cancelled by this, which is the intended
  // outcome — an empty day costs nobody any rating.
  return participants.length >= 2;
}

function lockDueLobbies(now = Date.now()) {
  const due = db.prepare("SELECT * FROM matches WHERE state = 'open' AND scope_start <= ?").all(now);
  for (const match of due) {
    // A weekly that has started but is still inside its first-day join window
    // stays open (issue #44); everything else locks at its start instant.
    if (joinDeadline(match) > now) continue;
    const participants = db.prepare('SELECT user_id FROM match_participants WHERE match_id = ?')
      .all(match.id);
    const nextState = rosterIsLegal(match, participants) ? 'pending' : 'cancelled';
    db.prepare('UPDATE matches SET state = ?, settled_at = ? WHERE id = ?')
      .run(nextState, nextState === 'cancelled' ? now : null, match.id);
  }
}

// ── settlement ───────────────────────────────────────────────────────────────

function cancel(matchId, now) {
  db.prepare("UPDATE matches SET state = 'cancelled', settled_at = ? WHERE id = ?").run(now, matchId);
}

// Settle one match: score every participant over the match window, run the
// mode's settlement, and write the result. The whole thing is one transaction,
// so a crash mid-settlement leaves the match pending and it settles cleanly on
// the next tick rather than half-applying deltas to the rating cache.
function settleMatch(match, now = Date.now()) {
  // user_id breaks the joined_at tie: a whole-point delta that lands on a
  // fractional tie goes to the earlier participant, so the roster order has to
  // be total. Auto-joined rosters all share one joined_at instant.
  const rows = db.prepare(
    'SELECT user_id FROM match_participants WHERE match_id = ? ORDER BY joined_at, user_id'
  ).all(match.id);

  // Off days (issue #18) are dropped from the score: a coffee logged on a
  // masked or paused day never counts toward the settlement.
  const excluded = offRangesForMatch(match);
  const players = rows.map((r) => ({
    userId: r.user_id,
    rating: ratingOf(r.user_id),
    score: scoreFor(r.user_id, match.scope_start, match.scope_end, excluded),
  }));

  if (players.length < 2) return cancel(match.id, now);
  // The margin scale is derived from the match's own window (v2.1), so a daily
  // and a weekly grade on curves matched to their length. k_factor is the K the
  // match was created with; both are immutable inputs to a one-shot settlement.
  const marginScale = marginScaleFor(match.scope_start, match.scope_end);
  const results = settleFfa(players, match.k_factor, marginScale);

  const scoreByUser = new Map(players.map((p) => [p.userId, p.score]));

  // Rank each participant by score desc for the match_end notification (issue
  // #32). The roster order is already total (joined_at, user_id), so a score
  // tie resolves deterministically. 1-based; every player gets a rank.
  const ranked = [...players].sort((a, b) => b.score - a.score);
  const rankByUser = new Map(ranked.map((p, i) => [p.userId, i + 1]));

  // Group name is frozen into every payload so the renderer never reads back
  // into competition_groups. null for a group-less (global) match.
  const groupName = match.group_id
    ? (db.prepare('SELECT name FROM competition_groups WHERE id = ?').get(match.group_id)?.name ?? null)
    : null;

  // `side` and `contribution_share` only ever meant something in team mode,
  // which v2 dropped; the columns stay because settled team matches still hold
  // real data in them. A v2 settlement leaves them as it found them: null.
  const updateParticipant = db.prepare(`
    UPDATE match_participants
    SET score = ?, rating_before = ?, rating_after = ?, delta = ?
    WHERE match_id = ? AND user_id = ?
  `);

  db.transaction(() => {
    for (const r of results) {
      updateParticipant.run(
        scoreByUser.get(r.userId),
        r.ratingBefore, r.ratingAfter, r.delta,
        match.id, r.userId,
      );
      writeRating(r.userId, r.ratingAfter, now);

      // One immutable match_end notification per participant — winners, losers
      // and away users alike (issue #32). All display data is frozen into the
      // payload (ids AND names) so the renderer never reads back into live
      // tables. Emitted inside the settlement transaction: rows commit
      // atomically with the settlement, or not at all. `side` /
      // `contribution_share` are deliberately omitted (v2 dropped team mode);
      // the opponent roster is omitted by design — this is a per-user result.
      createNotification(r.userId, TYPES.MATCH_END, {
        match_id: match.id,
        title: match.title,
        group_id: match.group_id,
        group_name: groupName,
        mode: match.mode,
        period_key: match.period_key,
        scope_start: match.scope_start,
        scope_end: match.scope_end,
        rank: rankByUser.get(r.userId),
        participant_count: players.length,
        score: scoreByUser.get(r.userId),
        rating_before: r.ratingBefore,
        rating_after: r.ratingAfter,
        delta: r.delta,
      });
    }
    db.prepare("UPDATE matches SET state = 'settled', settled_at = ? WHERE id = ?").run(now, match.id);
  })();

  // Tell participants their competition and ranking data are stale. Notifications
  // were already pushed inside the transaction via createNotification → broadcast.
  const participantIds = players.map((p) => p.userId);
  broadcast([['competitions'], ['rankings']], participantIds);
}

function settleDueMatches(now = Date.now()) {
  const due = db.prepare("SELECT * FROM matches WHERE state = 'pending' AND scope_end <= ?").all(now);
  for (const match of due) settleMatch(match, now);
  return due.length;
}

// ── admin match invalidation ─────────────────────────────────────────────────

// At most this many settled matches may follow the target in settle order. A
// deeper replay would rewrite more immutable ledger rows than a correction can
// stay legible for (the info marker on each recomputed card is the trade-off).
const MAX_INVALIDATE_DEPTH = 3;
const RECOMPUTE_REASON = 'a match was invalidated';

// Invalidate a wrongly-settled match (super-admin action, gated in the route).
// The target keeps its audit rows but moves no rating, and every settled match
// after it in settle order is re-settled from its STORED score so the running
// ratings stay correct and zero-sum — the same replay shape as migration 015,
// but with the CURRENT settleFfa/marginScaleFor (015 froze v1 because it re-ran
// history predating v2; here every match in the window was already settled under
// v2, so the current curve is the right one).
//
// Correctness of the partial replay: matches BEFORE the target are untouched, so
// each player's stored `rating_before` in their FIRST window match is still the
// true rating they carried into it. That is the seed; every later window match
// reads the running value the replay just wrote. Nothing is re-read from
// coffee_entries — the stored `score` is the immutable record of the window.
//
// Returns a summary { invalidated, matches_recomputed, participants_notified }.
function invalidateMatch(matchId, now = Date.now()) {
  const target = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId);
  if (!target) throw new Error('Match not found');
  if (target.state !== 'settled') throw new Error('Only a settled match can be invalidated');

  // Settle order is (settled_at, id) — a total order. Only settled matches hold a
  // rating, so pending/open/cancelled/already-invalidated ones can never shift
  // and are not counted toward the depth cap or the replay.
  const after = db.prepare(`
    SELECT * FROM matches
    WHERE state = 'settled'
      AND (settled_at > ? OR (settled_at = ? AND id > ?))
    ORDER BY settled_at, id
  `).all(target.settled_at, target.settled_at, target.id);

  if (after.length > MAX_INVALIDATE_DEPTH) {
    throw new Error(
      `${after.length} matches settled after this one — at most ${MAX_INVALIDATE_DEPTH} may follow an invalidated match`,
    );
  }

  const replayWindow = [target, ...after];

  const loadRoster = db.prepare(
    'SELECT user_id, score, rating_before, rating_after, delta FROM match_participants WHERE match_id = ? ORDER BY joined_at, user_id',
  );
  const writeParticipant = db.prepare(
    'UPDATE match_participants SET rating_before = ?, rating_after = ?, delta = ? WHERE match_id = ? AND user_id = ?',
  );
  const stampInvalidated = db.prepare("UPDATE matches SET state = 'invalidated' WHERE id = ?");
  const stampRecomputed = db.prepare('UPDATE matches SET recomputed_at = ?, recompute_reason = ? WHERE id = ?');
  const upsertRating = db.prepare(`
    INSERT INTO user_ratings (user_id, rating, matches, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      rating = excluded.rating, matches = excluded.matches, updated_at = excluded.updated_at
  `);
  const countSettled = db.prepare(`
    SELECT COUNT(*) AS n FROM match_participants p JOIN matches m ON m.id = p.match_id
    WHERE p.user_id = ? AND m.state = 'settled'
  `);

  // Lazy-seeded running ratings (see the correctness note above).
  const cache = new Map();
  const ratingIn = (userId, storedBefore) => (cache.has(userId) ? cache.get(userId) : storedBefore);
  const groupNameOf = (gid) => (gid
    ? (db.prepare('SELECT name FROM competition_groups WHERE id = ?').get(gid)?.name ?? null)
    : null);

  const notifications = []; // { userId, payload } — emitted inside the transaction
  let recomputed = 0;       // matches actually rewritten (a no-op replay is neither)

  db.transaction(() => {
    for (const match of replayWindow) {
      const roster = loadRoster.all(match.id);
      const isTarget = match.id === target.id;
      const groupName = groupNameOf(match.group_id);
      const oldByUser = new Map(
        roster.map((r) => [r.user_id, { after: r.rating_after, delta: r.delta }]),
      );

      let results;
      if (isTarget) {
        // Keep the audit rows, move no rating: delta 0, after = before (unchanged).
        results = roster.map((r) => {
          const before = ratingIn(r.user_id, r.rating_before);
          return { userId: r.user_id, ratingBefore: before, ratingAfter: before, delta: 0 };
        });
      } else {
        const players = roster.map((r) => ({
          userId: r.user_id,
          rating: ratingIn(r.user_id, r.rating_before),
          score: r.score ?? 0,
        }));
        const marginScale = marginScaleFor(match.scope_start, match.scope_end);
        results = settleFfa(players, match.k_factor, marginScale);
      }

      // A match in the settle-order window that shares no changed player with the
      // target replays to the identical ledger (settleFfa is deterministic on the
      // stored score + unchanged seed). Such a match moved nothing, so it must not
      // be stamped recomputed and its players must not be told "your rating
      // changed" — that would be a false correction on an untouched group.
      let matchChanged = false;

      for (const r of results) {
        writeParticipant.run(r.ratingBefore, r.ratingAfter, r.delta, match.id, r.userId);
        cache.set(r.userId, r.ratingAfter);
        const old = oldByUser.get(r.userId);
        const userChanged = old.after !== r.ratingAfter || old.delta !== r.delta;
        if (userChanged) matchChanged = true;
        // Notify a player only when their ledger actually moved. The target's own
        // roster always notifies (the match they were in is gone), even for a
        // player whose rating happens not to shift.
        if (!isTarget && !userChanged) continue;
        // Self-contained payload (ids AND names) — the toast never reads back into
        // live tables. Carries old vs new so the user sees the correction.
        notifications.push({
          userId: r.userId,
          payload: {
            match_id: match.id,
            title: match.title,
            group_id: match.group_id,
            group_name: groupName,
            mode: match.mode,
            period_key: match.period_key,
            scope_start: match.scope_start,
            scope_end: match.scope_end,
            invalidated: isTarget,
            // The match whose invalidation triggered this — same for every row.
            invalidated_match_id: target.id,
            invalidated_title: target.title,
            old_rating: old.after,
            new_rating: r.ratingAfter,
            old_delta: old.delta,
            new_delta: r.delta,
          },
        });
      }

      if (isTarget) {
        stampInvalidated.run(match.id);
      } else if (matchChanged) {
        stampRecomputed.run(now, RECOMPUTE_REASON, match.id);
        recomputed += 1;
      }
    }

    // Rebuild the rating cache for every user the replay touched. The window is
    // the tail of settle order, so a touched user's final running rating IS their
    // latest settled rating. `matches` is recounted live — the target dropped out
    // of 'settled', so it is excluded automatically.
    for (const [userId, rating] of cache) {
      upsertRating.run(userId, rating, countSettled.get(userId).n, now);
    }

    for (const n of notifications) createNotification(n.userId, TYPES.MATCH_RECOMPUTED, n.payload);
  })();

  return {
    invalidated: target.id,
    matches_recomputed: recomputed,
    participants_notified: notifications.length,
  };
}

// ── the ticker ───────────────────────────────────────────────────────────────

// One pass: open what should exist, lock what has started, settle what has
// finished. Ordered so a window that opened and closed between two ticks (only
// possible for a very short user-created match) still gets locked before it is
// considered for settlement.
function tick(now = Date.now()) {
  ensureRecurringMatches(now);
  lockDueLobbies(now);
  settleDueMatches(now);
  purgeOldNotifications(now);
}

// Bounded growth for the notifications table (issue #32): drop rows the user
// has already read and left untouched for 90 days. An unread notification is
// never deleted, however old.
const NOTIFICATION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
function purgeOldNotifications(now = Date.now()) {
  db.prepare('DELETE FROM notifications WHERE read_at IS NOT NULL AND read_at < ?')
    .run(now - NOTIFICATION_TTL_MS);
}

let timer = null;

// Runs one pass immediately so a restart catches up on anything that closed
// while the process was down, then every TICK_MS. unref'd: the ticker must
// never be the reason the process stays alive.
function startTicker() {
  if (timer) return timer;
  const safeTick = () => {
    try {
      tick();
    } catch (err) {
      // A bad match must not take the process down or stop the ticker; the next
      // pass retries it.
      console.error('competition tick failed:', err);
    }
  };
  safeTick();
  timer = setInterval(safeTick, TICK_MS);
  timer.unref();
  return timer;
}

function stopTicker() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  TICK_MS, DAILY_LEAD_DAYS, WEEKLY_LEAD_DAYS,
  mondayOf, addDaysStr, dailyWindow, weeklyWindow, groupOf, autoJoinMemberIds,
  dayIsOff, offRanges, offRangesForMatch, wholeWeekOff,
  metricsFor, scoreFor, scoresForMany, ratingOf, ratingsForMany,
  ensureRecurringMatch, ensureRecurringMatches, rosterIsLegal, lockDueLobbies,
  joinDeadline, settleMatch, settleDueMatches, invalidateMatch, MAX_INVALIDATE_DEPTH,
  tick, startTicker, stopTicker,
};
