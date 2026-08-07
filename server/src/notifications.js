const { randomUUID } = require('crypto');
const db = require('./db');
const { broadcast } = require('./events');

// The one writer for the notifications table (issue #32). A notification is an
// immutable event: this module only ever INSERTs. Nothing here (or anywhere)
// UPDATEs a payload — if a described fact later changes, that is a new row.
//
// Requires only ./db so it can be pulled into achievements.js and
// competitions.js without a dependency cycle.

// Server-side allowlist of known type strings. A typo cannot write an
// unrenderable row. Adding a type is one entry here plus a frontend catalog
// entry — never a migration (`type`/`payload` are opaque columns).
const TYPES = {
  ACHIEVEMENT: 'achievement',
  BADGE: 'badge',
  MATCH_END: 'match_end',
  // A settled match's ledger was rewritten because an admin invalidated an
  // earlier match. The original MATCH_END row stays (immutable); this is the
  // correction that carries the old vs new rating (see invalidateMatch).
  MATCH_RECOMPUTED: 'match_recomputed',
};
const KNOWN = new Set(Object.values(TYPES));

// createNotification(userId, type, payload) → the row's id.
//
// `payload` must already carry every display-relevant field (ids AND names);
// it is stringified on write and parsed on read, and nothing recomputes on
// read. An unknown `type` is a programming error and throws, so a bad tag
// fails loud at the write site instead of silently persisting.
function createNotification(userId, type, payload) {
  if (!KNOWN.has(type)) throw new Error(`unknown notification type: ${type}`);
  const id = randomUUID();
  db.prepare(
    'INSERT INTO notifications (id, user_id, type, payload, read_at, created_at) VALUES (?, ?, ?, ?, NULL, ?)'
  ).run(id, userId, type, JSON.stringify(payload), Date.now());
  broadcast([['notifications']], [userId]);
  return id;
}

module.exports = { createNotification, TYPES };
