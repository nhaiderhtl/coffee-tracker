const express = require('express');
const { randomUUID } = require('crypto');
const db = require('../db');
const images = require('../images');
const { requireAuth } = require('../middleware/auth');
const { badgesForMany } = require('../profile');

const router = express.Router();

// Shape a raw joined row into the API post object. bookmarked_by_me is derived
// from a correlated EXISTS (not a join) so it can't inflate the likes COUNT.
// image / profile_image carry the responsive variant lists; the *_url fields
// stay for legacy single-file photos and as a fallback. `variants` is a prebuilt
// Map<imageId, field> (images.variantsForMany) so a page of posts resolves its
// images in two queries total, not two per post.
// `badges` is a prebuilt Map<userId, chips> (profile.badgesForMany) so a page of
// posts resolves every author's earned badges in one lookup, not one per post.
// Badges ride along so a post header shows them wherever a profile appears
// (issue #80).
function mapPost(p, variants, badges) {
  const { image_id, profile_image_id, ...rest } = p;
  return {
    ...rest,
    photo_url: p.photo_path ? `/uploads/${p.photo_path}` : null,
    profile_photo_url: p.profile_photo ? `/uploads/${p.profile_photo}` : null,
    image: variants.get(image_id) ?? null,
    profile_image: variants.get(profile_image_id) ?? null,
    badges: badges.get(p.user_id) ?? [],
    liked_by_me: p.liked_by_me === 1,
    bookmarked_by_me: p.bookmarked_by_me === 1,
  };
}

// Resolve every post's image + profile image + author badges in batched lookups,
// then shape. `viewerId` masks secret badges the viewer hasn't earned.
function mapPosts(posts, viewerId) {
  const variants = images.variantsForMany(
    posts.flatMap((p) => [p.image_id, p.profile_image_id]),
  );
  const badges = badgesForMany(posts.map((p) => p.user_id), viewerId);
  return posts.map((p) => mapPost(p, variants, badges));
}

const POST_COLUMNS = `
  e.id, e.user_id, e.coffee_id, e.caffeine_mg, e.logged_at,
  e.photo_path, e.image_id AS image_id, e.description, e.is_public,
  u.username, u.avatar, u.profile_photo, u.image_id AS profile_image_id,
  COUNT(pl.id) AS likes_count,
  MAX(CASE WHEN pl.user_id = ? THEN 1 ELSE 0 END) AS liked_by_me,
  EXISTS(SELECT 1 FROM post_bookmarks pb WHERE pb.entry_id = e.id AND pb.user_id = ?) AS bookmarked_by_me
`;

router.get('/', requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  const posts = db.prepare(`
    SELECT ${POST_COLUMNS}
    FROM coffee_entries e
    JOIN users u ON e.user_id = u.id
    LEFT JOIN post_likes pl ON pl.entry_id = e.id
    WHERE e.is_public = 1
    GROUP BY e.id
    ORDER BY e.logged_at DESC
    LIMIT ? OFFSET ?
  `).all(req.user.id, req.user.id, limit, offset);

  res.json(mapPosts(posts, req.user.id));
});

// The current user's saved posts, newest-saved first. Someone else's post has to
// still be public — one that has gone private drops out, matching the main
// feed's privacy rule — but your own private entries stay, since you may save
// those too.
router.get('/saved', requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  const posts = db.prepare(`
    SELECT ${POST_COLUMNS}, mine.created_at AS saved_at
    FROM post_bookmarks mine
    JOIN coffee_entries e ON e.id = mine.entry_id
    JOIN users u ON e.user_id = u.id
    LEFT JOIN post_likes pl ON pl.entry_id = e.id
    WHERE mine.user_id = ? AND (e.is_public = 1 OR e.user_id = ?)
    GROUP BY e.id
    ORDER BY mine.created_at DESC
    LIMIT ? OFFSET ?
  `).all(req.user.id, req.user.id, req.user.id, req.user.id, limit, offset);

  res.json(mapPosts(posts, req.user.id));
});

// Everything the current user has posted, newest coffee first — public and
// private alike. This is the only list that shows a user their own private
// entries, which is why it filters on user_id instead of is_public.
router.get('/mine', requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  const posts = db.prepare(`
    SELECT ${POST_COLUMNS}
    FROM coffee_entries e
    JOIN users u ON e.user_id = u.id
    LEFT JOIN post_likes pl ON pl.entry_id = e.id
    WHERE e.user_id = ?
    GROUP BY e.id
    ORDER BY e.logged_at DESC
    LIMIT ? OFFSET ?
  `).all(req.user.id, req.user.id, req.user.id, limit, offset);

  res.json(mapPosts(posts, req.user.id));
});

// Hall of Fame: public posts from the last 30 days that meet a dynamic
// like threshold. The threshold is max(1, floor(avg likes per post in
// the window)), so it scales up automatically as the community grows —
// a quiet week keeps the bar at 1, a busy month raises it.
router.get('/hall-of-fame', requireAuth, (req, res) => {
  const posts = db.prepare(`
    SELECT ${POST_COLUMNS}
    FROM coffee_entries e
    JOIN users u ON e.user_id = u.id
    LEFT JOIN post_likes pl ON pl.entry_id = e.id
    WHERE e.is_public = 1
      AND e.logged_at >= (unixepoch('now', '-30 days') * 1000)
    GROUP BY e.id
    HAVING COUNT(pl.id) >= (
      SELECT MAX(1, CAST(AVG(like_count) AS INTEGER))
      FROM (
        SELECT COUNT(pl2.id) AS like_count
        FROM coffee_entries e2
        LEFT JOIN post_likes pl2 ON pl2.entry_id = e2.id
        WHERE e2.is_public = 1
          AND e2.logged_at >= (unixepoch('now', '-30 days') * 1000)
        GROUP BY e2.id
      )
    )
    ORDER BY COUNT(pl.id) DESC
    LIMIT 30
  `).all(req.user.id, req.user.id);

  res.json(mapPosts(posts, req.user.id));
});

router.post('/:entryId/like', requireAuth, (req, res) => {
  const entry = db.prepare(
    'SELECT id, user_id FROM coffee_entries WHERE id = ? AND is_public = 1'
  ).get(req.params.entryId);
  if (!entry) return res.status(404).json({ error: 'Post not found' });
  if (entry.user_id === req.user.id) {
    return res.status(403).json({ error: "You can't like your own post." });
  }

  try {
    db.prepare(
      'INSERT INTO post_likes (id, entry_id, user_id, created_at) VALUES (?, ?, ?, ?)'
    ).run(randomUUID(), req.params.entryId, req.user.id, Date.now());
  } catch (err) {
    // Only a duplicate like (UNIQUE(entry_id, user_id)) is expected here — treat
    // it as idempotent and return the current count. Any other DB error (FK,
    // I/O) is real and must not be silently reported as success.
    if (!String(err.code).startsWith('SQLITE_CONSTRAINT')) throw err;
  }

  const { count } = db.prepare(
    'SELECT COUNT(*) AS count FROM post_likes WHERE entry_id = ?'
  ).get(req.params.entryId);
  res.json({ likes_count: count, liked_by_me: true });
});

router.delete('/:entryId/like', requireAuth, (req, res) => {
  db.prepare(
    'DELETE FROM post_likes WHERE entry_id = ? AND user_id = ?'
  ).run(req.params.entryId, req.user.id);

  const { count } = db.prepare(
    'SELECT COUNT(*) AS count FROM post_likes WHERE entry_id = ?'
  ).get(req.params.entryId);
  res.json({ likes_count: count, liked_by_me: false });
});

// Bookmarks are private — unlike likes, you may bookmark your own post, and
// that includes your own private entries. Someone else's post must be public.
router.post('/:entryId/bookmark', requireAuth, (req, res) => {
  const entry = db.prepare(
    'SELECT id FROM coffee_entries WHERE id = ? AND (is_public = 1 OR user_id = ?)'
  ).get(req.params.entryId, req.user.id);
  if (!entry) return res.status(404).json({ error: 'Post not found' });

  try {
    db.prepare(
      'INSERT INTO post_bookmarks (id, entry_id, user_id, created_at) VALUES (?, ?, ?, ?)'
    ).run(randomUUID(), req.params.entryId, req.user.id, Date.now());
  } catch (err) {
    // Duplicate bookmark is idempotent; any other DB error is real.
    if (!String(err.code).startsWith('SQLITE_CONSTRAINT')) throw err;
  }

  res.json({ bookmarked_by_me: true });
});

router.delete('/:entryId/bookmark', requireAuth, (req, res) => {
  db.prepare(
    'DELETE FROM post_bookmarks WHERE entry_id = ? AND user_id = ?'
  ).run(req.params.entryId, req.user.id);

  res.json({ bookmarked_by_me: false });
});

module.exports = router;
