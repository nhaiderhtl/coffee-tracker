// 023 — add join_code to matches for private user-created lobbies (issue #36).
//
// User-created global matches (1v1, ondemand) are now private by default: a
// random 6-char code is generated at creation time. Only the creator sees the
// code; opponents join by entering it. Group matches stay members-only as before
// and never receive a join_code. Existing matches get NULL (joinable as before).

exports.up = (db) => {
  const cols = db.prepare('PRAGMA table_info(matches)').all().map((c) => c.name);
  if (cols.includes('join_code')) return;
  db.exec('ALTER TABLE matches ADD COLUMN join_code TEXT');
};
