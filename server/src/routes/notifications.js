const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { broadcast } = require('../events');

const router = express.Router();

// In-app notification feed (issue #32). Every query is scoped to req.user.id —
// there is no cross-user read. Rows are immutable events written elsewhere
// (achievements.js, competitions.js); this router only lists them and marks
// them read. `payload` is stored as JSON text and parsed back to an object on
// the way out; nothing is recomputed on read.

// The caller's total unread count, independent of any paging or filter on the
// list itself — this is the number the bell badge shows.
function unreadCount(userId) {
  return db.prepare(
    'SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL'
  ).get(userId).n;
}

// GET /api/notifications?unread=1&limit=&before=
//   limit  default 30, capped at 100.
//   before created_at keyset cursor (newest-first paging).
//   unread=1 restricts to read_at IS NULL.
router.get('/', requireAuth, (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
  const before = req.query.before != null ? parseInt(req.query.before, 10) : null;
  const unreadOnly = req.query.unread === '1';

  const where = ['user_id = ?'];
  const params = [req.user.id];
  if (unreadOnly) where.push('read_at IS NULL');
  if (before != null && !Number.isNaN(before)) { where.push('created_at < ?'); params.push(before); }

  const rows = db.prepare(
    `SELECT id, type, payload, read_at, created_at
       FROM notifications
      WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT ?`
  ).all(...params, limit);

  res.json({
    notifications: rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) })),
    unread_count: unreadCount(req.user.id),
  });
});

// POST /api/notifications/read  — body { ids: string[] } or { all: true }.
// Marks matching unread rows read (read_at = now). Only ever touches the
// caller's own rows; already-read rows are left as they were.
router.post('/read', requireAuth, (req, res) => {
  const { ids, all } = req.body || {};
  const now = Date.now();

  if (all === true) {
    db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL')
      .run(now, req.user.id);
  } else if (Array.isArray(ids) && ids.length > 0) {
    const placeholders = ids.map(() => '?').join(', ');
    db.prepare(
      `UPDATE notifications SET read_at = ?
        WHERE user_id = ? AND read_at IS NULL AND id IN (${placeholders})`
    ).run(now, req.user.id, ...ids);
  }

  // Keeps the bell count in step across this user's other open tabs.
  broadcast([['notifications']], [req.user.id]);
  res.json({ ok: true, unread_count: unreadCount(req.user.id) });
});

module.exports = router;
