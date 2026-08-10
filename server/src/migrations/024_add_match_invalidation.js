// Admin match invalidation (super-admin only). A wrongly-settled match can be
// invalidated; every settled match after it in settle order is replayed so the
// running ratings stay correct and zero-sum (see invalidateMatch in
// competitions.js, which reuses the migration-015 replay shape).
//
// `matches.state` is free text (no CHECK), so the new 'invalidated' value needs
// no column change — existing readers filter state='settled', and the routes are
// updated to also surface 'invalidated'. This migration only adds the audit
// columns stamped on every match a replay rewrote:
//   - recomputed_at:    when the replay rewrote this match's ledger rows
//   - recompute_reason: why (currently always "a match was invalidated")
//
// No backfill: existing rows keep NULL, meaning "never recomputed".
exports.up = (db) => {
  const cols = db.prepare('PRAGMA table_info(matches)').all().map((c) => c.name);
  if (!cols.includes('recomputed_at')) {
    db.prepare('ALTER TABLE matches ADD COLUMN recomputed_at INTEGER').run();
  }
  if (!cols.includes('recompute_reason')) {
    db.prepare('ALTER TABLE matches ADD COLUMN recompute_reason TEXT').run();
  }
};
