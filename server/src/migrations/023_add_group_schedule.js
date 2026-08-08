// Group schedule / days off (issue #18).
//
// Two independent controls, both owner-set and both scoped to the GROUP's zone:
//
//   - active_weekdays: a 7-bit mask of the weekdays a recurring daily/weekly is
//     active on. bit0 = Monday ... bit6 = Sunday (Monday-anchored to match the
//     weekly window). 127 = every day on = the behaviour before this migration,
//     so existing groups keep competing exactly as they did.
//
//   - pause_from / pause_to: an inclusive civil-date range (YYYY-MM-DD, group
//     zone) during which every day is off, like snoozing an alarm. Both NULL =
//     no pause. Dates, not instants: a day is the atomic unit — it either counts
//     or it does not; a pause never lands mid-day.
//
// An "off" day (masked out or inside the pause range) is not scored — coffees
// logged on it are excluded from the competitive total — and a recurring match
// is not opened when its whole period is off. See server/src/competitions.js.
exports.up = (db) => {
  const cols = db.prepare('PRAGMA table_info(competition_groups)').all().map((c) => c.name);
  if (!cols.includes('active_weekdays')) {
    db.prepare('ALTER TABLE competition_groups ADD COLUMN active_weekdays INTEGER NOT NULL DEFAULT 127').run();
  }
  if (!cols.includes('pause_from')) {
    db.prepare('ALTER TABLE competition_groups ADD COLUMN pause_from TEXT').run();
  }
  if (!cols.includes('pause_to')) {
    db.prepare('ALTER TABLE competition_groups ADD COLUMN pause_to TEXT').run();
  }
};
