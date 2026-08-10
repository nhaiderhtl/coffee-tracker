// Shared read-model for a match: the participant roster and the match payload the
// client renders. Lives here (not in a route) so both the competitions routes and
// the admin match routes build the exact same shape — one source, no drift.

const db = require('./db');
const images = require('./images');
const { BASE_RATING } = require('./competition-core');
const { scoresForMany, ratingsForMany, offRangesForMatch } = require('./competitions');
const { badgesForMany } = require('./profile');

// Participants with everything the UI needs. For a match that has not settled
// yet, `points` is computed live from the window so far; for a finished one it is
// the stored value, which is the number the deltas were actually derived from.
//
// Points are a linear, uncapped integer (docs/competitions-rating-v2.md) — there
// is no maximum, so nothing here or in the client may render one as a fraction
// of a whole.
//
// The live path scores and rates the whole roster in two queries rather than
// two per player: a match list is dozens of matches deep, so the per-user form
// made one page load hundreds of round trips.
function participantsOf(match, viewerId) {
  const rows = db.prepare(`
    SELECT p.*, u.username, u.avatar, u.profile_photo, u.image_id AS profile_image_id
    FROM match_participants p
    JOIN users u ON u.id = p.user_id
    WHERE p.match_id = ?
    ORDER BY p.joined_at
  `).all(match.id);

  // A finished match (settled OR invalidated) reads its frozen ledger; only a
  // still-running match is scored/rated live. An invalidated match keeps the
  // stored score/rating rows the settlement wrote (its deltas are zeroed, but the
  // row is real history), so it must take the stored path, not the live one.
  const finished = match.state === 'settled' || match.state === 'invalidated';
  const userIds = rows.map((r) => r.user_id);
  const livePoints = finished
    ? new Map()
    : scoresForMany(userIds, match.scope_start, Math.min(Date.now(), match.scope_end),
                    offRangesForMatch(match));
  const liveRatings = finished ? new Map() : ratingsForMany(userIds);
  const variants = images.variantsForMany(rows.map((r) => r.profile_image_id));
  const badges = badgesForMany(userIds, viewerId);

  const enriched = rows.map((r) => ({
    user_id: r.user_id,
    username: r.username,
    avatar: r.avatar,
    profile_photo_url: r.profile_photo ? `/uploads/${r.profile_photo}` : null,
    profile_image: variants.get(r.profile_image_id) ?? null,
    badges: badges.get(r.user_id) ?? [],
    joined_at: r.joined_at,
    // The stored `score` column IS the points a finished window was worth. A
    // match settled under v1 holds a 0..1000 number from the old curve instead —
    // history is immutable and is never re-derived.
    points: finished ? (r.score ?? 0) : (livePoints.get(r.user_id) ?? 0),
    rating_before: r.rating_before,
    rating_after: r.rating_after,
    delta: r.delta,
    // A live match shows the rating a player is carrying INTO it; a finished
    // one shows what they had when it settled.
    current_rating: finished ? r.rating_after : (liveRatings.get(r.user_id) ?? BASE_RATING),
  }));

  // Standings order: most points first.
  return enriched.sort((a, b) => b.points - a.points);
}

function matchPayload(match, { withParticipants = true, viewerId } = {}) {
  const participants = withParticipants ? participantsOf(match, viewerId) : null;
  const base = {
    id: match.id,
    group_id: match.group_id,
    mode: match.mode,
    period_key: match.period_key,
    title: match.title,
    creator_id: match.creator_id,
    scope_start: match.scope_start,
    scope_end: match.scope_end,
    state: match.state,
    k_factor: match.k_factor,
    created_at: match.created_at,
    settled_at: match.settled_at,
    // Non-null once a replay rewrote this match's ledger (issue: match
    // invalidation). The client shows an (i) marker when set.
    recomputed_at: match.recomputed_at ?? null,
    recompute_reason: match.recompute_reason ?? null,
    participant_count: participants
      ? participants.length
      : db.prepare('SELECT COUNT(*) AS c FROM match_participants WHERE match_id = ?').get(match.id).c,
  };
  return participants ? { ...base, participants } : base;
}

module.exports = { participantsOf, matchPayload };
