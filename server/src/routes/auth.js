const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { rateLimit } = require('express-rate-limit');
const { randomUUID } = require('crypto');
const multer   = require('multer');
const db       = require('../db');
const images   = require('../images');
const { requireAuth } = require('../middleware/auth');
const { broadcast } = require('../events');
const { isValidTz, DEFAULT_TZ } = require('../time');
const { clampHalfLife } = require('../energy');
const { isValidPassword } = require('../password');

const UPLOAD_DIR = images.UPLOAD_DIR;

// In-memory upload; ../images derives the variants and writes every file. The
// `pfp_` filename prefix (applied by deriveAndStore) is what lets the serving
// route treat profile photos as visible to any authenticated user.
const profilePhotoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  },
});

// Convert multer upload failures (too large, wrong type) into a 400 with the
// real message instead of letting them fall through to the global 500 handler.
function handleUpload(mw) {
  return (req, res, next) => mw(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
    next();
  });
}

const router = express.Router();

// A username, avatar or profile photo is this user's identity, and it is
// rendered next to them in the feed, on rosters, the leaderboard, compare and
// their public profile. Changing it makes every one of those stale for everyone
// else — the actor already has the new value in their own response.
function pushIdentity(actorId) {
  broadcast([['feed'], ['competitions'], ['rankings'], ['groups'], ['compare'], ['user-profile']],
    undefined, { except: actorId });
}

const USER_COLS = 'id, username, avatar, profile_photo, image_id, timezone, caffeine_half_life_h, auto_join_daily, auto_join_weekly, is_admin, is_super_admin, created_at';
const USERNAME_RE = /^[a-zA-Z0-9_-]{2,20}$/;

// Throttle credential guessing and mass account creation. Per-IP: generous
// enough that a shared NAT of real users never hits it, far too slow for
// brute force (30 attempts / 15 min).
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many attempts — try again later' },
});

function parseUser(u) {
  if (!u) return u;
  const { image_id, ...rest } = u;
  return {
    ...rest,
    profile_photo_url: u.profile_photo ? `/uploads/${u.profile_photo}` : null,
    profile_image: images.variantsFor(image_id),
  };
}

function makeToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, process.env.JWT_SECRET, { expiresIn: '30d' });
}

router.post('/register', authLimiter, (req, res) => {
  const { username, password, timezone } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
  // No complexity/minimum rule by design — this is a for-fun site, passwords
  // are treated as public (see the register-page warning). Any non-empty
  // string is fine. The upper bound only exists because bcrypt ignores
  // everything past 72 bytes anyway.
  if (typeof password !== 'string' || password.length > 72) return res.status(400).json({ error: 'Password must be a string of at most 72 characters' });
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) return res.status(400).json({ error: 'Username must be 2-20 alphanumeric characters' });

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return res.status(409).json({ error: 'Username already taken' });

  const password_hash = bcrypt.hashSync(password, 10);
  const id = randomUUID();
  const tz = isValidTz(timezone) ? timezone : DEFAULT_TZ;
  db.prepare('INSERT INTO users (id, username, password_hash, timezone, created_at) VALUES (?, ?, ?, ?, ?)').run(id, username, password_hash, tz, Date.now());
  db.prepare('INSERT INTO user_streaks (user_id) VALUES (?)').run(id);
  db.prepare('INSERT INTO user_combos (user_id) VALUES (?)').run(id);

  const user = parseUser(db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(id));
  // The Elo ladder lists every user, not just those who have played, so a
  // signup changes the board everyone else is looking at.
  broadcast([['rankings'], ['competitions']], undefined, { except: id });
  res.json({ token: makeToken(user), user });
});

router.post('/login', authLimiter, (req, res) => {
  const { username, password } = req.body;
  if (!username || !password || typeof username !== 'string' || typeof password !== 'string') return res.status(400).json({ error: 'Missing fields' });

  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!row || !bcrypt.compareSync(password, row.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  // Refresh the stored zone from the client on login (lazy tz update — the user
  // may have moved). Only when it's a valid IANA name and actually changed.
  const { timezone } = req.body;
  if (isValidTz(timezone) && timezone !== row.timezone) {
    db.prepare('UPDATE users SET timezone = ? WHERE id = ?').run(timezone, row.id);
    row.timezone = timezone;
  }
  const { password_hash, ...safe } = row;
  res.json({ token: makeToken(row), user: parseUser(safe) });
});

router.get('/me', requireAuth, (req, res) => {
  const user = parseUser(db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(req.user.id));
  // A valid token whose user no longer exists (e.g. deleted, or DB reset) is an
  // invalid session, not a missing resource — 401 so the client logs out.
  if (!user) return res.status(401).json({ error: 'Session no longer valid' });
  res.json(user);
});

router.patch('/me', requireAuth, (req, res) => {
  const {
    username, avatar, password, timezone, caffeine_half_life_h,
    auto_join_daily, auto_join_weekly,
  } = req.body;
  if (username && !USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'Invalid username' });
  }
  // Opt-in auto-join for the recurring competition matches. Booleans only: a
  // silent coercion here would be the difference between being entered into
  // every daily match and none of them. Validated here but written at the very
  // end — a later 400/403 (a bad password, a taken username) must not leave the
  // user opted into every daily match on a request that was rejected.
  const autoJoin = [['auto_join_daily', auto_join_daily], ['auto_join_weekly', auto_join_weekly]]
    .filter(([, value]) => value !== undefined);
  for (const [key, value] of autoJoin) {
    if (typeof value !== 'boolean') {
      return res.status(400).json({ error: `${key} must be true or false` });
    }
  }
  // Personal caffeine half-life (hours) for the Buzz score. null clears it back
  // to the population default. Out-of-range numbers are clamped rather than
  // rejected — the client offers a free-text box, and a typo should give a
  // sane curve, not an error. Anything non-numeric is a client bug: 400.
  if (caffeine_half_life_h !== undefined) {
    if (caffeine_half_life_h === null) {
      db.prepare('UPDATE users SET caffeine_half_life_h = NULL WHERE id = ?').run(req.user.id);
    } else if (typeof caffeine_half_life_h === 'number' && Number.isFinite(caffeine_half_life_h)) {
      db.prepare('UPDATE users SET caffeine_half_life_h = ? WHERE id = ?')
        .run(clampHalfLife(caffeine_half_life_h), req.user.id);
    } else {
      return res.status(400).json({ error: 'caffeine_half_life_h must be a number or null' });
    }
  }
  // Timezone: accept only a valid IANA name; silently ignore anything else so a
  // stale/garbage client value can't overwrite a good one.
  if (timezone !== undefined && isValidTz(timezone)) {
    db.prepare('UPDATE users SET timezone = ? WHERE id = ?').run(timezone, req.user.id);
  }
  if (password !== undefined) {
    if (!isValidPassword(password)) {
      return res.status(400).json({ error: 'Password must be 1–72 characters' });
    }
    // Require the current password to rotate the hash. A valid JWT alone is not
    // enough: a stolen token could otherwise lock the real owner out by changing
    // the password. Re-authenticating proves possession of the secret itself.
    const { currentPassword } = req.body;
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!row || typeof currentPassword !== 'string' || !bcrypt.compareSync(currentPassword, row.password_hash)) {
      return res.status(403).json({ error: 'Current password is incorrect' });
    }
    const hash = bcrypt.hashSync(password, 10);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user.id);
  }
  // Avatars are single emoji picked in the client; 16 chars covers any
  // multi-codepoint emoji while rejecting arbitrary blobs.
  if (avatar && (typeof avatar !== 'string' || avatar.length > 16)) {
    return res.status(400).json({ error: 'Invalid avatar' });
  }
  if (username) {
    const taken = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username, req.user.id);
    if (taken) return res.status(409).json({ error: 'Username taken' });
    db.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, req.user.id);
  }
  if (avatar) {
    db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatar, req.user.id);
  }
  for (const [key, value] of autoJoin) {
    db.prepare(`UPDATE users SET ${key} = ? WHERE id = ?`).run(value ? 1 : 0, req.user.id);
  }
  const user = parseUser(db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(req.user.id));
  pushIdentity(req.user.id);
  res.json(user);
});

router.patch('/me/photo', requireAuth, handleUpload(profilePhotoUpload.single('photo')), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No photo provided' });
  const existing = db.prepare('SELECT profile_photo, image_id FROM users WHERE id = ?').get(req.user.id);

  let image_id;
  try {
    image_id = await images.deriveAndStore({
      buffer: req.file.buffer,
      mimetype: req.file.mimetype,
      ownerId: req.user.id,
      createdAt: Date.now(),
      prefix: 'pfp_',
    });
  } catch (err) {
    console.error('profile photo processing failed', err);
    return res.status(400).json({ error: 'Could not process image' });
  }

  // Link the new image, then remove the old one. A new upload drops the legacy
  // profile_photo (it lives under image_id now).
  db.prepare('UPDATE users SET profile_photo = NULL, image_id = ? WHERE id = ?').run(image_id, req.user.id);
  if (existing?.image_id) images.deleteImage(existing.image_id);
  if (existing?.profile_photo) images.unlinkPaths([existing.profile_photo]);

  const user = parseUser(db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(req.user.id));
  pushIdentity(req.user.id);
  res.json(user);
});

router.delete('/me/photo', requireAuth, (req, res) => {
  const existing = db.prepare('SELECT profile_photo, image_id FROM users WHERE id = ?').get(req.user.id);
  if (existing?.image_id || existing?.profile_photo) {
    db.prepare('UPDATE users SET profile_photo = NULL, image_id = NULL WHERE id = ?').run(req.user.id);
    if (existing.image_id) images.deleteImage(existing.image_id);
    if (existing.profile_photo) images.unlinkPaths([existing.profile_photo]);
  }
  const user = parseUser(db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(req.user.id));
  pushIdentity(req.user.id);
  res.json(user);
});

router.delete('/me', requireAuth, (req, res) => {
  // Gather every file to unlink BEFORE the cascade removes the rows that name
  // them (deleting the user cascades images/image_variants + coffee_entries, but
  // a cascade never touches disk). Covers both new variant files and any legacy
  // single files still recorded in photo_path / profile_photo.
  const variantPaths = images.imagePathsForOwner(req.user.id);
  const legacyCoffee = db.prepare(
    'SELECT photo_path FROM coffee_entries WHERE user_id = ? AND photo_path IS NOT NULL'
  ).all(req.user.id).map(r => r.photo_path);
  const { profile_photo } = db.prepare('SELECT profile_photo FROM users WHERE id = ?').get(req.user.id) ?? {};

  db.prepare('DELETE FROM users WHERE id = ?').run(req.user.id);

  images.unlinkPaths(variantPaths);
  images.unlinkPaths(legacyCoffee);
  if (profile_photo) images.unlinkPaths([profile_photo]);
  // The cascade took this user's posts, match entries and group membership with
  // them, so everyone else's lists are now showing rows that no longer exist.
  pushIdentity(req.user.id);
  res.status(204).end();
});

module.exports = router;
