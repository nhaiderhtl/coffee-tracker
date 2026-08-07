const express = require('express');
const { randomUUID } = require('crypto');
const db = require('../db');
const images = require('../images');
const { requireAuth } = require('../middleware/auth');
const { BASE_RATING, K_BY_MODE } = require('../competition-core');
const { groupOf, joinDeadline } = require('../competitions');
const { badgesForMany } = require('../profile');
const { matchPayload } = require('../match-view');

const router = express.Router();

// Modes a user may open themselves. daily/weekly are opened by the ticker on a
// recurring window and are never created through the API.
const USER_MODES = ['ondemand', '1v1'];

const TITLE_MAX = 60;
// Upper bound on a user-created window. Long enough for "run this for a month",
// short enough that a typo can't park a match in the table for years.
const MAX_DURATION_MS = 90 * 86400000;
const MIN_DURATION_MS = 60 * 1000;

function matchOr404(res, id) {
  const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(id);
  if (!match) {
    res.status(404).json({ error: 'Match not found' });
    return null;
  }
  return match;
}

// GET /api/competitions — the caller's group's matches (if any) and the global
// (group-less) matches, plus their rating. The group buckets stay empty for a
// user in no group; the global buckets are populated for everyone (issue #35).
router.get('/', requireAuth, (req, res) => {
  const rating = db.prepare('SELECT rating, matches FROM user_ratings WHERE user_id = ?').get(req.user.id);
  const group = groupOf(req.user.id);

  const groupBuckets = { group: null, open: [], live: [], settled: [] };
  if (group) {
    const rows = db.prepare('SELECT * FROM matches WHERE group_id = ? ORDER BY scope_start DESC LIMIT 60')
      .all(group.id);
    groupBuckets.group = {
      id: group.id, name: group.name, timezone: group.timezone,
      // Schedule (issue #18) so the log screen can warn when a coffee lands on an
      // off day, the same way it warns about private logs.
      active_weekdays: group.active_weekdays ?? 127,
      pause_from: group.pause_from ?? null,
      pause_to: group.pause_to ?? null,
    };
    groupBuckets.open = rows.filter((m) => m.state === 'open').map((m) => matchPayload(m, { viewerId: req.user.id }));
    groupBuckets.live = rows.filter((m) => m.state === 'pending').map((m) => matchPayload(m, { viewerId: req.user.id }));
    groupBuckets.settled = rows.filter((m) => m.state === 'settled' || m.state === 'cancelled' || m.state === 'invalidated').map((m) => matchPayload(m, { viewerId: req.user.id }));
  }

  // Open global lobbies visible to this user: public ones (no join_code) plus
  // any private lobby the viewer created (so they can see their own match).
  const globalOpen = db.prepare(`
    SELECT * FROM matches
    WHERE group_id IS NULL AND state = 'open'
      AND (join_code IS NULL OR creator_id = ?)
    ORDER BY scope_start DESC LIMIT 60
  `).all(req.user.id);
  const globalMine = db.prepare(`
    SELECT m.* FROM matches m
    JOIN match_participants p ON p.match_id = m.id
    WHERE m.group_id IS NULL AND p.user_id = ? AND m.state != 'open'
    ORDER BY m.scope_start DESC LIMIT 60
  `).all(req.user.id);

  res.json({
    ...groupBuckets,
    global: {
      open: globalOpen.map((m) => matchPayload(m, { viewerId: req.user.id })),
      live: globalMine.filter((m) => m.state === 'pending').map((m) => matchPayload(m, { viewerId: req.user.id })),
      settled: globalMine.filter((m) => m.state === 'settled' || m.state === 'cancelled' || m.state === 'invalidated').map((m) => matchPayload(m, { viewerId: req.user.id })),
    },
    my_rating: rating ? rating.rating : BASE_RATING,
    my_matches: rating ? rating.matches : 0,
  });
});

// Every user, ordered the one way this app ranks people: by the single global
// rating. Players who have never settled a match sort last regardless of
// rating — the default 1000 would otherwise place someone who has done nothing
// above an active player sitting just below it. Username breaks ties so the
// order, and therefore the rank, is the same on every request.
function globalStandings(viewerId) {
  // The ORDER BY repeats the COALESCEs rather than reusing the aliases: inside
  // a larger expression SQLite resolves a bare name against the SOURCE columns,
  // so `(matches = 0)` would read the raw NULL of a user with no rating row and
  // sort them FIRST — the exact opposite of what this ordering is for.
  const rows = db.prepare(`
    SELECT u.id, u.username, u.avatar, u.profile_photo, u.image_id AS profile_image_id,
           COALESCE(r.rating, ?) AS rating,
           COALESCE(r.matches, 0) AS matches
    FROM users u
    LEFT JOIN user_ratings r ON r.user_id = u.id
    ORDER BY (COALESCE(r.matches, 0) = 0) ASC, COALESCE(r.rating, ?) DESC, u.username ASC
  `).all(BASE_RATING, BASE_RATING);

  const variants = images.variantsForMany(rows.map((r) => r.profile_image_id));
  const badges = badgesForMany(rows.map((r) => r.id), viewerId);
  return rows.map((r, i) => ({
    id: r.id,
    username: r.username,
    avatar: r.avatar,
    profile_photo_url: r.profile_photo ? `/uploads/${r.profile_photo}` : null,
    profile_image: variants.get(r.profile_image_id) ?? null,
    badges: badges.get(r.id) ?? [],
    rating: r.rating,
    matches: r.matches,
    rank: i + 1,
  }));
}

// A global board is unbounded, so it ships a page rather than every user. The
// caller's own row is returned separately, so someone outside the cut still
// sees where they stand.
const LEADERBOARD_LIMIT = 50;

// GET /api/competitions/leaderboard?scope=global|group — standings by rating.
//
// Rank is a single global number in BOTH scopes (issue #53): `group` filters
// which players are listed, it does not re-rank them against each other. A
// three-member group therefore reads e.g. #4, #17, #58 — their real standing —
// rather than a private 1-2-3 that means something different per group.
router.get('/leaderboard', requireAuth, (req, res) => {
  const scope = req.query.scope === 'group' ? 'group' : 'global';
  const standings = globalStandings(req.user.id);
  const me = standings.find((r) => r.id === req.user.id) ?? null;

  if (scope === 'global') {
    return res.json({ scope, group: null, me, leaderboard: standings.slice(0, LEADERBOARD_LIMIT) });
  }

  const group = groupOf(req.user.id);
  if (!group) return res.json({ scope, group: null, me, leaderboard: [] });

  const memberIds = new Set(
    db.prepare('SELECT user_id FROM group_members WHERE group_id = ?')
      .all(group.id).map((r) => r.user_id)
  );

  res.json({
    scope,
    group: { id: group.id, name: group.name },
    me,
    leaderboard: standings.filter((r) => memberIds.has(r.id)),
  });
});

// GET /api/competitions/history — the caller's rating history and the group's
// finished matches (issue #34).
//
// `personal` is every settled match the caller played, group OR global, since
// the rating is one global number and every settlement moved it. It carries the
// before/after/delta the graph is drawn from; the client windows it into
// 30d/7d/24h rather than the server pre-slicing, so one payload feeds all three.
// Cancelled matches are excluded — they moved nobody's rating, so they are not
// history in the sense this pill means.
//
// `group_history` is the caller's group's finished matches as full end-match
// cards (the public history), newest first and capped so an old group does not
// ship hundreds of cards in one response.
router.get('/history', requireAuth, (req, res) => {
  const personal = db.prepare(`
    SELECT m.id AS match_id, m.mode, m.title, m.group_id,
           m.scope_start, m.scope_end, m.settled_at,
           p.rating_before, p.rating_after, p.delta
    FROM match_participants p
    JOIN matches m ON m.id = p.match_id
    WHERE p.user_id = ? AND m.state = 'settled'
    ORDER BY m.settled_at DESC
  `).all(req.user.id);

  const rating = db.prepare('SELECT rating FROM user_ratings WHERE user_id = ?').get(req.user.id);
  const group = groupOf(req.user.id);

  let groupHistory = [];
  if (group) {
    // Include invalidated matches so the public history still shows them (marked
    // with the (i) recompute note), even though they now move no rating.
    const rows = db.prepare(`
      SELECT * FROM matches
      WHERE group_id = ? AND state IN ('settled', 'invalidated')
      ORDER BY settled_at DESC LIMIT 40
    `).all(group.id);
    groupHistory = rows.map((m) => matchPayload(m, { viewerId: req.user.id }));
  }

  res.json({
    group: group ? { id: group.id, name: group.name } : null,
    my_rating: rating ? rating.rating : BASE_RATING,
    personal,
    group_history: groupHistory,
  });
});

// POST /api/competitions — open a user-created match. Without `global: true` it
// lives in the caller's group (members-only); with it the match belongs to no
// group and anyone may join (issue #35). Either way it is a user-created lobby.
router.post('/', requireAuth, (req, res) => {
  const { mode, title = null, scope_start, scope_end } = req.body || {};
  const isGlobal = (req.body && req.body.global) === true;

  const group = isGlobal ? null : groupOf(req.user.id);
  if (!isGlobal && !group) return res.status(400).json({ error: 'Join a group before starting a match' });
  const groupId = isGlobal ? null : group.id;

  if (!USER_MODES.includes(mode)) {
    return res.status(400).json({ error: `Mode must be one of: ${USER_MODES.join(', ')}` });
  }
  if (title !== null && (typeof title !== 'string' || title.length > TITLE_MAX)) {
    return res.status(400).json({ error: `Title must be at most ${TITLE_MAX} characters` });
  }
  if (!Number.isFinite(scope_start) || !Number.isFinite(scope_end)) {
    return res.status(400).json({ error: 'scope_start and scope_end must be epoch milliseconds' });
  }

  const now = Date.now();
  // Joining runs until the start instant, so a match that starts in the past
  // could never be joined by anyone but its creator — and would then be
  // cancelled for an illegal roster on the very next tick.
  if (scope_start <= now) return res.status(400).json({ error: 'The match must start in the future' });
  const duration = scope_end - scope_start;
  if (duration < MIN_DURATION_MS) return res.status(400).json({ error: 'The match must run for at least a minute' });
  if (duration > MAX_DURATION_MS) return res.status(400).json({ error: 'A match can run for at most 90 days' });

  const id = randomUUID();
  // Global user-created matches are private by default: a 6-char code is
  // generated and only returned to the creator. Group matches stay members-only
  // and don't need a code.
  const joinCode = isGlobal ? randomUUID().slice(0, 6).toUpperCase() : null;

  // `team_size` and `side` stay in the schema because settled team matches hold
  // real data in them, but team mode is gone (v2) and a new match never fills
  // them in.
  db.transaction(() => {
    db.prepare(`
      INSERT INTO matches (id, group_id, mode, period_key, title, creator_id,
                           scope_start, scope_end, state, k_factor, team_size, created_at, join_code)
      VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 'open', ?, NULL, ?, ?)
    `).run(id, groupId, mode, title ? title.trim() : null, req.user.id,
      scope_start, scope_end, K_BY_MODE[mode], now, joinCode);

    db.prepare('INSERT INTO match_participants (id, match_id, user_id, side, joined_at) VALUES (?, ?, ?, NULL, ?)')
      .run(randomUUID(), id, req.user.id, now);
  })();

  res.status(201).json({ match: matchPayload(db.prepare('SELECT * FROM matches WHERE id = ?').get(id), { viewerId: req.user.id }) });
});

// POST /api/competitions/join-by-code — look up a private match by its join
// code and enter it. The code is case-insensitive; the same join rules apply
// as for /:id/join (state, deadline, roster cap, etc.).
router.post('/join-by-code', requireAuth, (req, res) => {
  const raw = req.body?.code;
  if (!raw || typeof raw !== 'string') return res.status(400).json({ error: 'code is required' });
  const code = raw.trim().toUpperCase();
  const match = db.prepare("SELECT * FROM matches WHERE join_code = ? AND state = 'open'").get(code);
  if (!match) return res.status(404).json({ error: 'No open match found with that code' });
  if (joinDeadline(match) <= Date.now()) return res.status(409).json({ error: 'This match is no longer open to join' });

  const already = db.prepare('SELECT 1 FROM match_participants WHERE match_id = ? AND user_id = ?')
    .get(match.id, req.user.id);
  if (already) return res.status(409).json({ error: 'You are already in this match' });

  const current = db.prepare('SELECT user_id FROM match_participants WHERE match_id = ?').all(match.id);
  if (match.mode === '1v1' && current.length >= 2) {
    return res.status(409).json({ error: 'This match already has both players' });
  }

  db.prepare('INSERT INTO match_participants (id, match_id, user_id, side, joined_at) VALUES (?, ?, ?, NULL, ?)')
    .run(randomUUID(), match.id, req.user.id, Date.now());

  res.json({ match: matchPayload(db.prepare('SELECT * FROM matches WHERE id = ?').get(match.id), { viewerId: req.user.id }) });
});

// POST /api/competitions/:id/join — take a slot in an open lobby.
router.post('/:id/join', requireAuth, (req, res) => {
  const match = matchOr404(res, req.params.id);
  if (!match) return;
  if (match.state !== 'open') return res.status(409).json({ error: 'This match is no longer open to join' });
  // A weekly stays joinable through its first day, so the cutoff is the join
  // deadline, not the start instant (issue #44). For every other mode the
  // deadline IS the start instant, so this behaves exactly as before.
  if (joinDeadline(match) <= Date.now()) return res.status(409).json({ error: 'This match is no longer open to join' });

  // A group match is members-only; a global match with a join_code requires
  // the code (private by default). A global match without a code is open.
  if (match.group_id !== null) {
    const group = groupOf(req.user.id);
    if (!group || group.id !== match.group_id) {
      return res.status(403).json({ error: 'This match belongs to another group' });
    }
  } else if (match.join_code !== null && match.creator_id !== req.user.id) {
    const provided = typeof req.body?.code === 'string' ? req.body.code.trim().toUpperCase() : '';
    if (provided !== match.join_code) {
      return res.status(403).json({ error: 'Invalid join code' });
    }
  }

  const already = db.prepare('SELECT 1 FROM match_participants WHERE match_id = ? AND user_id = ?')
    .get(match.id, req.user.id);
  if (already) return res.status(409).json({ error: 'You are already in this match' });

  const current = db.prepare('SELECT user_id FROM match_participants WHERE match_id = ?').all(match.id);
  if (match.mode === '1v1' && current.length >= 2) {
    return res.status(409).json({ error: 'This match already has both players' });
  }

  db.prepare('INSERT INTO match_participants (id, match_id, user_id, side, joined_at) VALUES (?, ?, ?, NULL, ?)')
    .run(randomUUID(), match.id, req.user.id, Date.now());

  res.json({ match: matchPayload(db.prepare('SELECT * FROM matches WHERE id = ?').get(match.id), { viewerId: req.user.id }) });
});

// POST /api/competitions/:id/leave — give up a slot before the match starts.
router.post('/:id/leave', requireAuth, (req, res) => {
  const match = matchOr404(res, req.params.id);
  if (!match) return;
  // Only a lobby can be left. Once a match is running its roster is fixed —
  // that is what stops a player dodging a bad day, and it applies to leaving
  // the match for the same reason it applies to leaving the group.
  if (match.state !== 'open') return res.status(409).json({ error: 'A running match cannot be left' });

  const row = db.prepare('SELECT 1 FROM match_participants WHERE match_id = ? AND user_id = ?')
    .get(match.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'You are not in this match' });

  db.transaction(() => {
    db.prepare('DELETE FROM match_participants WHERE match_id = ? AND user_id = ?')
      .run(match.id, req.user.id);
    // A user-created lobby whose last player walked out is cancelled rather
    // than left as an ownerless shell the ticker would cancel anyway.
    //
    // A recurring lobby is NOT cancelled when it empties: it belongs to the
    // group, not to whoever happened to join first, and it opens a day (or two)
    // ahead precisely so people can join over that period. Emptying it must not
    // deny the rest of the group their daily match.
    const isRecurring = match.period_key !== null;
    const left = db.prepare('SELECT COUNT(*) AS c FROM match_participants WHERE match_id = ?').get(match.id).c;
    if (left === 0 && !isRecurring) {
      db.prepare("UPDATE matches SET state = 'cancelled', settled_at = ? WHERE id = ?").run(Date.now(), match.id);
    }
  })();

  res.json({ ok: true });
});

// GET /api/competitions/:id — one match with its standings.
router.get('/:id', requireAuth, (req, res) => {
  const match = matchOr404(res, req.params.id);
  if (!match) return;

  // A group match is group business: only members of the owning group (or anyone
  // already on its roster) can read one. A global match (no group) is public.
  if (match.group_id !== null) {
    const group = groupOf(req.user.id);
    const onRoster = db.prepare('SELECT 1 FROM match_participants WHERE match_id = ? AND user_id = ?')
      .get(match.id, req.user.id);
    if ((!group || group.id !== match.group_id) && !onRoster) {
      return res.status(403).json({ error: 'This match belongs to another group' });
    }
  }

  res.json({ match: matchPayload(match, { viewerId: req.user.id }) });
});

module.exports = router;
