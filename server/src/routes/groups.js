const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { randomUUID, randomInt } = require('crypto');
const db = require('../db');
const images = require('../images');
const { requireAuth } = require('../middleware/auth');
const { broadcast } = require('../events');
const { isValidTz, getUserTz } = require('../time');
const { BASE_RATING } = require('../competition-core');
const { ensureRecurringMatches, groupOf } = require('../competitions');
const { badgesForMany } = require('../profile');

const router = express.Router();

// Membership changes move people between rosters and can open or close the
// group's recurring lobbies, so both the group list and the competition screen
// go stale for everyone — group visibility is decided by the GET handlers, so
// this is deliberately untargeted. The actor is skipped; their own response
// already carries the new state.
function pushGroups(actorId) {
  broadcast([['groups'], ['competitions']], undefined, { except: actorId });
}

const NAME_RE = /^[\w][\w '-]{1,30}$/;
const DESCRIPTION_MAX = 200;
// A civil date in the group's zone: YYYY-MM-DD, no time component (issue #18).
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAYS_ALL = 127; // 7-bit mask, every weekday on

// Join codes are read off a screen and typed by hand, so the alphabet drops
// the characters that get confused there (0/O, 1/I/L).
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

// A join code is the ONLY gate on a private group, and unlike a password it is
// checked without a username to go with it — every guess is a guess at every
// group at once. 31^6 makes that impractical on its own; this makes it pointless.
// Generous enough that mistyping a code off a screen a few times is fine.
const joinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 40,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many join attempts — try again later' },
});

function makeJoinCode() {
  // Loop rather than return blindly: a collision on a 6-char code is unlikely
  // but the column is UNIQUE, so an unchecked insert would 500.
  for (let attempt = 0; attempt < 20; attempt++) {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    if (!db.prepare('SELECT 1 FROM competition_groups WHERE join_code = ?').get(code)) return code;
  }
  throw new Error('Could not allocate a unique join code');
}

function memberCount(groupId) {
  return db.prepare('SELECT COUNT(*) AS c FROM group_members WHERE group_id = ?').get(groupId).c;
}

// Shape sent to the client. join_code is only included for members — it is the
// key to a private group, so the public listing must not leak it.
function publicGroup(group, { includeCode = false } = {}) {
  return {
    id: group.id,
    name: group.name,
    description: group.description,
    owner_id: group.owner_id,
    timezone: group.timezone,
    is_public: group.is_public,
    active_weekdays: group.active_weekdays ?? 127,
    pause_from: group.pause_from ?? null,
    pause_to: group.pause_to ?? null,
    member_count: memberCount(group.id),
    created_at: group.created_at,
    ...(includeCode ? { join_code: group.join_code } : {}),
  };
}

function membersOf(groupId, viewerId) {
  const rows = db.prepare(`
    SELECT u.id, u.username, u.avatar, u.profile_photo, u.image_id AS profile_image_id, m.joined_at,
           COALESCE(r.rating, ?) AS rating,
           COALESCE(r.matches, 0) AS matches
    FROM group_members m
    JOIN users u ON u.id = m.user_id
    LEFT JOIN user_ratings r ON r.user_id = u.id
    WHERE m.group_id = ?
    ORDER BY rating DESC, u.username ASC
  `).all(BASE_RATING, groupId);
  const variants = images.variantsForMany(rows.map((m) => m.profile_image_id));
  const badges = badgesForMany(rows.map((m) => m.id), viewerId);
  return rows.map((m) => ({
    id: m.id,
    username: m.username,
    avatar: m.avatar,
    profile_photo_url: m.profile_photo ? `/uploads/${m.profile_photo}` : null,
    profile_image: variants.get(m.profile_image_id) ?? null,
    badges: badges.get(m.id) ?? [],
    joined_at: m.joined_at,
    rating: m.rating,
    matches: m.matches,
  }));
}

// Everything that has to happen when `leavingUserId` walks out of `group`.
// Call INSIDE the transaction, after their group_members row is gone.
//
// Leaving must never destroy a group that has a rating ledger: settled matches
// hang off it and are the record those ratings were derived from. So ownership
// passes to the longest-standing remaining member instead of the row dying.
//
// A group that empties with nothing on it is a different thing — it is litter.
// Left alone it would sit in the public directory forever with zero members, an
// owner_id of NULL that no PATCH can ever match (so it can never be unlisted or
// renamed), and a UNIQUE name nobody can reuse. Those get deleted.
function handleDeparture(group, leavingUserId) {
  const remaining = db.prepare(
    'SELECT user_id FROM group_members WHERE group_id = ? ORDER BY joined_at LIMIT 1'
  ).get(group.id);

  if (!remaining && !mustPreserve(group.id)) {
    // Nothing here but empty/cancelled lobbies; the FK cascade takes them.
    db.prepare('DELETE FROM competition_groups WHERE id = ?').run(group.id);
    return;
  }
  if (group.owner_id !== leavingUserId) return;
  db.prepare('UPDATE competition_groups SET owner_id = ? WHERE id = ?')
    .run(remaining ? remaining.user_id : null, group.id);
}

// Does this group hold anything that makes an empty row worth keeping?
//
// 'settled' is the rating ledger — the record those ratings were derived from.
// 'pending' is a match still owed a settlement: its roster froze when it
// started, so it settles whether or not anyone is still in the group. Deleting
// the group would cascade that match away and hand everyone on it a way to
// dodge a bad day by walking out together.
function mustPreserve(groupId) {
  return !!db.prepare(
    "SELECT 1 FROM matches WHERE group_id = ? AND state IN ('settled', 'pending') LIMIT 1"
  ).get(groupId);
}

// GET /api/groups — the public directory plus the caller's own group.
router.get('/', requireAuth, (req, res) => {
  const mine = groupOf(req.user.id);
  // Empty groups are hidden: the only ones that survive an empty roster are
  // those holding a ledger, and there is nothing to join in those.
  const rows = db.prepare(`
    SELECT * FROM competition_groups g
    WHERE g.is_public = 1
      AND EXISTS (SELECT 1 FROM group_members m WHERE m.group_id = g.id)
    ORDER BY g.created_at DESC LIMIT 100
  `).all();
  res.json({
    groups: rows.map((g) => publicGroup(g)),
    my_group: mine ? publicGroup(mine, { includeCode: true }) : null,
  });
});

// GET /api/groups/mine — the caller's group with its roster.
router.get('/mine', requireAuth, (req, res) => {
  const group = groupOf(req.user.id);
  if (!group) return res.json({ group: null, members: [] });
  res.json({ group: publicGroup(group, { includeCode: true }), members: membersOf(group.id, req.user.id) });
});

// POST /api/groups — create a group and join it (leaving any current one).
router.post('/', requireAuth, (req, res) => {
  const { name, description = null, timezone, is_public = true } = req.body || {};

  if (typeof name !== 'string' || !NAME_RE.test(name.trim())) {
    return res.status(400).json({ error: 'Name must be 2-31 characters (letters, numbers, spaces, - or \')' });
  }
  if (description !== null && (typeof description !== 'string' || description.length > DESCRIPTION_MAX)) {
    return res.status(400).json({ error: `Description must be at most ${DESCRIPTION_MAX} characters` });
  }
  // The group's zone anchors every member's day/week boundary, so it must be a
  // real IANA name. Default to the creator's own zone.
  const tz = timezone === undefined || timezone === null ? getUserTz(db, req.user.id) : timezone;
  if (!isValidTz(tz)) return res.status(400).json({ error: 'Invalid timezone' });

  const trimmed = name.trim();
  if (db.prepare('SELECT 1 FROM competition_groups WHERE name = ?').get(trimmed)) {
    return res.status(409).json({ error: 'That group name is taken' });
  }

  const now = Date.now();
  const id = randomUUID();
  const code = makeJoinCode();
  const previous = groupOf(req.user.id);

  db.transaction(() => {
    db.prepare(`
      INSERT INTO competition_groups (id, name, description, owner_id, timezone, is_public, join_code, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, trimmed, description ? description.trim() : null, req.user.id, tz, is_public ? 1 : 0, code, now);

    if (previous) {
      db.prepare('DELETE FROM group_members WHERE user_id = ?').run(req.user.id);
      handleDeparture(previous, req.user.id);
    }
    db.prepare('INSERT INTO group_members (id, group_id, user_id, joined_at) VALUES (?, ?, ?, ?)')
      .run(randomUUID(), id, req.user.id, now);
  })();

  // A brand-new group has one member, so nothing is created yet; this only
  // matters for the joins that follow.
  ensureRecurringMatches(now);

  const group = db.prepare('SELECT * FROM competition_groups WHERE id = ?').get(id);
  // The public group list everyone browses just changed, and ensureRecurringMatches
  // may have opened lobbies along with it.
  pushGroups(req.user.id);
  res.status(201).json({ group: publicGroup(group, { includeCode: true }), members: membersOf(id, req.user.id) });
});

// POST /api/groups/join — by id (public groups) or by join code (any group).
router.post('/join', requireAuth, joinLimiter, (req, res) => {
  const { group_id = null, code = null } = req.body || {};

  let group = null;
  if (typeof code === 'string' && code.trim()) {
    group = db.prepare('SELECT * FROM competition_groups WHERE join_code = ?')
      .get(code.trim().toUpperCase());
  } else if (typeof group_id === 'string' && group_id) {
    group = db.prepare('SELECT * FROM competition_groups WHERE id = ?').get(group_id);
    // A private group is reachable by its code only — an id alone is not proof
    // of an invitation.
    if (group && group.is_public !== 1) group = null;
  } else {
    return res.status(400).json({ error: 'Provide a group id or a join code' });
  }
  if (!group) return res.status(404).json({ error: 'Group not found' });

  const previous = groupOf(req.user.id);
  if (previous && previous.id === group.id) {
    return res.status(409).json({ error: 'You are already in this group' });
  }

  const now = Date.now();
  db.transaction(() => {
    if (previous) {
      db.prepare('DELETE FROM group_members WHERE user_id = ?').run(req.user.id);
      handleDeparture(previous, req.user.id);
    }
    db.prepare('INSERT INTO group_members (id, group_id, user_id, joined_at) VALUES (?, ?, ?, ?)')
      .run(randomUUID(), group.id, req.user.id, now);
  })();

  // Joining can take a group from one member to two, which is the point at
  // which its recurring matches start existing. Don't wait for the next tick.
  ensureRecurringMatches(now);

  pushGroups(req.user.id);
  res.json({
    group: publicGroup(group, { includeCode: true }),
    members: membersOf(group.id, req.user.id),
    left_group: previous ? { id: previous.id, name: previous.name } : null,
  });
});

// POST /api/groups/leave — stop being in any group.
router.post('/leave', requireAuth, (req, res) => {
  const group = groupOf(req.user.id);
  if (!group) return res.status(404).json({ error: 'You are not in a group' });

  // Matches already under way keep the caller on their roster and settle
  // normally — leaving takes effect from the next window. Rating is global, so
  // it follows the user out of the group either way.
  db.transaction(() => {
    db.prepare('DELETE FROM group_members WHERE user_id = ?').run(req.user.id);
    handleDeparture(group, req.user.id);
  })();

  pushGroups(req.user.id);
  res.json({ ok: true, left_group: { id: group.id, name: group.name } });
});

// PATCH /api/groups/:id — owner-only settings.
router.patch('/:id', requireAuth, (req, res) => {
  const group = db.prepare('SELECT * FROM competition_groups WHERE id = ?').get(req.params.id);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (group.owner_id !== req.user.id) return res.status(403).json({ error: 'Only the group owner can change this' });

  const { name, description, timezone, is_public,
          active_weekdays, pause_from, pause_to } = req.body || {};
  const next = {
    name: group.name,
    description: group.description,
    timezone: group.timezone,
    is_public: group.is_public,
    active_weekdays: group.active_weekdays ?? WEEKDAYS_ALL,
    pause_from: group.pause_from ?? null,
    pause_to: group.pause_to ?? null,
  };

  if (name !== undefined) {
    if (typeof name !== 'string' || !NAME_RE.test(name.trim())) {
      return res.status(400).json({ error: 'Name must be 2-31 characters (letters, numbers, spaces, - or \')' });
    }
    const taken = db.prepare('SELECT 1 FROM competition_groups WHERE name = ? AND id != ?').get(name.trim(), group.id);
    if (taken) return res.status(409).json({ error: 'That group name is taken' });
    next.name = name.trim();
  }
  if (description !== undefined) {
    if (description !== null && (typeof description !== 'string' || description.length > DESCRIPTION_MAX)) {
      return res.status(400).json({ error: `Description must be at most ${DESCRIPTION_MAX} characters` });
    }
    next.description = description ? description.trim() : null;
  }
  if (timezone !== undefined) {
    if (!isValidTz(timezone)) return res.status(400).json({ error: 'Invalid timezone' });
    next.timezone = timezone;
  }
  if (is_public !== undefined) next.is_public = is_public ? 1 : 0;

  // Days off (issue #18). The weekday mask is a 7-bit integer; the pause is a
  // from/to pair that is set and cleared together — either two valid civil dates
  // with from <= to, or both null. Rejecting a half-set pair keeps the DB from
  // ever holding a from with no to.
  if (active_weekdays !== undefined) {
    if (!Number.isInteger(active_weekdays) || active_weekdays < 0 || active_weekdays > WEEKDAYS_ALL) {
      return res.status(400).json({ error: 'active_weekdays must be an integer 0-127' });
    }
    next.active_weekdays = active_weekdays;
  }
  if (pause_from !== undefined || pause_to !== undefined) {
    const from = pause_from ?? null;
    const to = pause_to ?? null;
    const bothNull = from === null && to === null;
    const bothDates = typeof from === 'string' && DATE_RE.test(from)
      && typeof to === 'string' && DATE_RE.test(to);
    if (!bothNull && !bothDates) {
      return res.status(400).json({ error: 'Pause needs both a start and end date (YYYY-MM-DD), or clear both' });
    }
    if (bothDates && from > to) {
      return res.status(400).json({ error: 'Pause start must be on or before pause end' });
    }
    next.pause_from = from;
    next.pause_to = to;
  }

  db.prepare(`UPDATE competition_groups
              SET name = ?, description = ?, timezone = ?, is_public = ?,
                  active_weekdays = ?, pause_from = ?, pause_to = ?
              WHERE id = ?`)
    .run(next.name, next.description, next.timezone, next.is_public,
         next.active_weekdays, next.pause_from, next.pause_to, group.id);

  // A zone change moves the day boundary. Matches already open keep the window
  // they were created with (their scores are already being measured against
  // it); the new zone applies from the next period.
  const updated = db.prepare('SELECT * FROM competition_groups WHERE id = ?').get(group.id);
  pushGroups(req.user.id);
  res.json({ group: publicGroup(updated, { includeCode: true }), members: membersOf(group.id, req.user.id) });
});

// GET /api/groups/:id — detail. Private groups are visible to members only.
router.get('/:id', requireAuth, (req, res) => {
  const group = db.prepare('SELECT * FROM competition_groups WHERE id = ?').get(req.params.id);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  const isMember = !!db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?')
    .get(group.id, req.user.id);
  if (group.is_public !== 1 && !isMember) return res.status(404).json({ error: 'Group not found' });

  res.json({
    group: publicGroup(group, { includeCode: isMember }),
    members: membersOf(group.id, req.user.id),
    is_member: isMember,
  });
});

module.exports = router;
