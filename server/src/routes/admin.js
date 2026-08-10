// Admin routes. Every endpoint is behind requireAdmin (see middleware/auth.js),
// so admin status is checked live on each request.
//
// Two tiers of admin (see migration 017 / admin-bootstrap.js):
//   - super admin (is_super_admin): the protected primary admin from
//     ADMIN_USERNAME. Can manage EVERY user, and is the ONLY one allowed to
//     manage other admins. Cannot be demoted or reset through these routes by
//     anyone — the protection is enforced here, server-side, not just hidden in
//     the UI.
//   - regular admin (is_admin only): may manage non-admins (reset their
//     password) and promote non-admins to admin, but may not touch any admin.
//
// "Manage" = change a user's admin status or reset their password.
const express = require('express');
const bcrypt  = require('bcryptjs');
const db      = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { isValidPassword } = require('../password');
const { ID_RE, listCoffeesAdmin, listClasses, getClass } = require('../coffees');
const { invalidateMatch, MAX_INVALIDATE_DEPTH } = require('../competitions');
const { matchPayload } = require('../match-view');

const router = express.Router();

// The columns the admin UI needs. Never exposes password_hash.
const ADMIN_USER_COLS = 'id, username, avatar, is_admin, is_super_admin, created_at';

router.use(requireAdmin);

// Whether `actor` may manage `target` (reset password / change admin status).
// Returns an error string to reject with, or null when allowed. The rules:
//   - the protected super admin is untouchable by anyone (including themselves
//     via these routes — they use the self-service flow instead);
//   - managing any other admin requires the actor to be the super admin;
//   - managing a non-admin is open to any admin.
function manageBlock(actor, target) {
  if (target.is_super_admin === 1) return 'The protected admin cannot be modified';
  if (target.is_admin === 1 && actor.is_super_admin !== 1) {
    return 'Only the primary admin can manage other admins';
  }
  return null;
}

// Look up a single user by exact username. The admin UI is search-based (like
// the Compare page), not a full user list. Exact match; 404 when absent.
router.get('/users/:username', (req, res) => {
  const user = db.prepare(`SELECT ${ADMIN_USER_COLS} FROM users WHERE username = ?`).get(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

// Reset a user's password to a new value. Deliberately does NOT require the
// target's current password — that is the whole point of an admin reset. Bounds
// mirror the self-service rule in routes/auth.js (1..72 chars).
router.post('/users/:id/reset-password', (req, res) => {
  const { password } = req.body;
  if (!isValidPassword(password)) {
    return res.status(400).json({ error: 'Password must be 1–72 characters' });
  }
  const target = db.prepare('SELECT id, is_admin, is_super_admin FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });

  const block = manageBlock(req.actor, target);
  if (block) return res.status(403).json({ error: block });

  const password_hash = bcrypt.hashSync(password, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(password_hash, target.id);
  res.json({ ok: true });
});

// Promote or demote a user. Promoting a non-admin is open to any admin;
// demoting an admin is "managing an admin" and so restricted to the super
// admin. The protected super admin can never be changed.
router.post('/users/:id/admin', (req, res) => {
  const { is_admin } = req.body;
  if (typeof is_admin !== 'boolean') {
    return res.status(400).json({ error: 'is_admin must be true or false' });
  }
  const target = db.prepare('SELECT id, is_admin, is_super_admin FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });

  // Same gate as reset-password: the protected admin is untouchable, and only the
  // super admin may manage another admin. Which flag we're setting doesn't relax
  // that — promoting a non-admin is the one admin-status change open to a regular
  // admin, and manageBlock already permits it (the target isn't an admin yet).
  const block = manageBlock(req.actor, target);
  if (block) return res.status(403).json({ error: block });

  db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(is_admin ? 1 : 0, target.id);
  const user = db.prepare(`SELECT ${ADMIN_USER_COLS} FROM users WHERE id = ?`).get(target.id);
  res.json(user);
});

// ── Coffee catalog (issue #77) ──────────────────────────────────────────────
//
// The menu lives in the `coffees` table (seeded by migration 020) and is edited
// here, so adding/retiring a drink or changing its caffeine no longer needs a
// redeploy. Any admin may edit the catalog — these are not user-management
// routes, so the super-admin manageBlock rules above don't apply.
//
// Note on history: coffee_entries copy `caffeine` at log time and store the
// coffee_id as a bare string (no FK), so editing or deleting a coffee never
// rewrites or breaks past entries — it only changes what future logs get and
// what the picker/labels show. This mirrors the long-standing catalog contract.

// A generous ceiling on the two mg fields. Not a realism claim — it just stops a
// fat-fingered / pasted value (e.g. 1e9) from being copied onto every future
// entry and poisoning the Buzz, stats and competition sums. Real drinks are two
// orders of magnitude under this.
const MAX_MG = 100000;

// Validate a coffee body. `partial` skips required-field checks for PATCH,
// where an absent field means "leave unchanged". Returns { error } or { values }
// holding only the fields present (so PATCH can build a targeted UPDATE).
function validateCoffee(body, { partial } = {}) {
  const values = {};

  if (body.name !== undefined || !partial) {
    if (typeof body.name !== 'string' || !body.name.trim()) return { error: 'name is required' };
    values.name = body.name.trim();
  }
  if (body.caffeine !== undefined || !partial) {
    const n = Number(body.caffeine);
    if (!Number.isInteger(n) || n < 0 || n > MAX_MG) return { error: `caffeine must be a whole number between 0 and ${MAX_MG}` };
    values.caffeine = n;
  }
  if (body.icon !== undefined || !partial) {
    if (typeof body.icon !== 'string' || !body.icon.trim()) return { error: 'icon is required' };
    values.icon = body.icon.trim();
  }
  if (body.class !== undefined || !partial) {
    if (typeof body.class !== 'string' || !body.class.trim()) return { error: 'class is required' };
    values.class = body.class.trim();
  }
  // score_caffeine is the competition-only override. Explicit null (or empty
  // string from a form) clears it → "score what you show".
  if (body.score_caffeine !== undefined) {
    if (body.score_caffeine === null || body.score_caffeine === '') {
      values.score_caffeine = null;
    } else {
      const s = Number(body.score_caffeine);
      if (!Number.isInteger(s) || s < 0 || s > MAX_MG) return { error: `score_caffeine must be a whole number between 0 and ${MAX_MG}, or null` };
      values.score_caffeine = s;
    }
  } else if (!partial) {
    values.score_caffeine = null;
  }

  return { values };
}

// Full catalog incl. the score override and order — the admin view needs every
// column, unlike the public GET /api/coffees which hides score_caffeine.
router.get('/coffees', (req, res) => {
  res.json(listCoffeesAdmin());
});

router.post('/coffees', (req, res) => {
  const id = typeof req.body.id === 'string' ? req.body.id.trim() : '';
  // The id is interpolated into a SQL CASE by scoreMgSql() and stored on every
  // entry, so it must be a strict slug — see coffees.js ID_RE.
  if (!ID_RE.test(id)) {
    return res.status(400).json({ error: 'id must be lowercase letters, numbers and underscores' });
  }
  if (db.prepare('SELECT id FROM coffees WHERE id = ?').get(id)) {
    return res.status(409).json({ error: 'A coffee with that id already exists' });
  }

  const { error, values } = validateCoffee(req.body, { partial: false });
  if (error) return res.status(400).json({ error });
  // A coffee must sit in a real category — the log screen reads its label/order
  // from there (migration 021). Reject an unknown class rather than create an
  // orphan group with no name.
  if (!getClass(values.class)) return res.status(400).json({ error: 'Unknown category' });

  // New drinks go to the end of the menu; sort_order is otherwise not editable.
  const max = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM coffees').get().m;
  db.prepare(
    'INSERT INTO coffees (id, name, caffeine, icon, class, score_caffeine, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, values.name, values.caffeine, values.icon, values.class, values.score_caffeine, max + 1);

  res.status(201).json(db.prepare('SELECT id, name, caffeine, icon, class, score_caffeine, sort_order FROM coffees WHERE id = ?').get(id));
});

router.patch('/coffees/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM coffees WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Coffee not found' });

  const { error, values } = validateCoffee(req.body, { partial: true });
  if (error) return res.status(400).json({ error });
  if (values.class !== undefined && !getClass(values.class)) {
    return res.status(400).json({ error: 'Unknown category' });
  }
  const keys = Object.keys(values);
  if (keys.length === 0) return res.status(400).json({ error: 'No fields to update' });

  // The id is the primary key and is embedded in existing entries, so it is not
  // rewritable here — a rename is a delete + re-create decision, not an edit.
  const setSql = keys.map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE coffees SET ${setSql} WHERE id = ?`).run(...keys.map((k) => values[k]), req.params.id);

  res.json(db.prepare('SELECT id, name, caffeine, icon, class, score_caffeine, sort_order FROM coffees WHERE id = ?').get(req.params.id));
});

router.delete('/coffees/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM coffees WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Coffee not found' });
  // Past entries keep their copied caffeine_mg and coffee_id string; only the
  // picker loses the option (see the history note above).
  db.prepare('DELETE FROM coffees WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── Drink categories (migration 021) ────────────────────────────────────────
// Each category carries the display name and group order the log screen reads.
// A coffee's `class` must be one of these ids (enforced on coffee write above),
// and a category can't be deleted while a coffee still uses it.

router.get('/coffee-classes', (req, res) => {
  res.json(listClasses());
});

router.post('/coffee-classes', (req, res) => {
  const id = typeof req.body.id === 'string' ? req.body.id.trim() : '';
  if (!ID_RE.test(id)) {
    return res.status(400).json({ error: 'id must be lowercase letters, numbers and underscores' });
  }
  if (getClass(id)) return res.status(409).json({ error: 'A category with that id already exists' });
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (!name) return res.status(400).json({ error: 'name is required' });

  const max = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM coffee_classes').get().m;
  db.prepare('INSERT INTO coffee_classes (id, name, sort_order) VALUES (?, ?, ?)').run(id, name, max + 1);
  res.status(201).json(getClass(id));
});

router.patch('/coffee-classes/:id', (req, res) => {
  if (!getClass(req.params.id)) return res.status(404).json({ error: 'Category not found' });
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (!name) return res.status(400).json({ error: 'name is required' });
  db.prepare('UPDATE coffee_classes SET name = ? WHERE id = ?').run(name, req.params.id);
  res.json(getClass(req.params.id));
});

// Swap a category with its neighbour in either direction, so order is fully
// editable from the UI without exposing raw sort_order numbers. A no-op at the
// end of the list just returns the unchanged row.
router.post('/coffee-classes/:id/move', (req, res) => {
  const dir = req.body.direction;
  if (dir !== 'up' && dir !== 'down') return res.status(400).json({ error: "direction must be 'up' or 'down'" });
  const current = getClass(req.params.id);
  if (!current) return res.status(404).json({ error: 'Category not found' });

  const neighbour = db.prepare(
    dir === 'up'
      ? 'SELECT * FROM coffee_classes WHERE sort_order < ? ORDER BY sort_order DESC LIMIT 1'
      : 'SELECT * FROM coffee_classes WHERE sort_order > ? ORDER BY sort_order ASC LIMIT 1'
  ).get(current.sort_order);
  if (!neighbour) return res.json(listClasses()); // already at the edge

  const swap = db.prepare('UPDATE coffee_classes SET sort_order = ? WHERE id = ?');
  const tx = db.transaction(() => {
    swap.run(neighbour.sort_order, current.id);
    swap.run(current.sort_order, neighbour.id);
  });
  tx();
  res.json(listClasses());
});

router.delete('/coffee-classes/:id', (req, res) => {
  if (!getClass(req.params.id)) return res.status(404).json({ error: 'Category not found' });
  const inUse = db.prepare('SELECT COUNT(*) AS n FROM coffees WHERE class = ?').get(req.params.id).n;
  if (inUse > 0) {
    return res.status(409).json({ error: `In use by ${inUse} ${inUse === 1 ? 'coffee' : 'coffees'} — reassign them first` });
  }
  db.prepare('DELETE FROM coffee_classes WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── match invalidation (super-admin only) ────────────────────────────────────

// Every finished match (settled / invalidated / cancelled — never a running
// lobby), newest-ending first. This is the admin matches review list. Each row
// is a normal match payload plus:
//   - settled_after: how many settled matches follow it in settle order (null
//     for a non-settled row)
//   - invalidatable: whether it may be invalidated now (settled AND within the
//     depth cap). The client disables the button and shows the reason otherwise.
// Ordered by scope_end DESC so the recent, invalidatable matches surface first.
router.get('/matches', (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM matches
    WHERE state IN ('settled', 'invalidated', 'cancelled')
    ORDER BY scope_end DESC
  `).all();

  // A settled match is invalidatable iff at most MAX_INVALIDATE_DEPTH settled
  // matches follow it. Derive the after-count from the settle-ordered id list.
  const settledOrder = db.prepare(
    "SELECT id FROM matches WHERE state = 'settled' ORDER BY settled_at, id",
  ).all().map((r) => r.id);
  const afterCount = new Map();
  settledOrder.forEach((id, i) => afterCount.set(id, settledOrder.length - 1 - i));

  const matches = rows.map((m) => {
    const settledAfter = afterCount.has(m.id) ? afterCount.get(m.id) : null;
    return {
      ...matchPayload(m, { viewerId: req.user.id }),
      settled_after: settledAfter,
      invalidatable: m.state === 'settled' && settledAfter <= MAX_INVALIDATE_DEPTH,
    };
  });

  res.json({ matches, max_depth: MAX_INVALIDATE_DEPTH });
});

// Invalidate a settled match and replay everything after it. Super-admin only —
// requireAdmin lets any admin this far, so re-gate here (mirrors manageBlock's
// super-admin rule). A regular admin gets 403.
router.post('/matches/:id/invalidate', (req, res) => {
  if (req.actor.is_super_admin !== 1) {
    return res.status(403).json({ error: 'Only the primary admin can invalidate matches' });
  }
  try {
    res.json(invalidateMatch(req.params.id, Date.now()));
  } catch (e) {
    const msg = e.message || 'Could not invalidate match';
    res.status(msg === 'Match not found' ? 404 : 400).json({ error: msg });
  }
});

module.exports = router;
