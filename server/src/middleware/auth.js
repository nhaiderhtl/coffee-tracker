const jwt = require('jsonwebtoken');
const db = require('../db');

function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = auth.slice(7).trim();
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    // Pin the algorithm to the one used when signing (HS256) so a forged token
    // can't downgrade the algorithm (e.g. "none") to bypass verification.
    req.user = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// EventSource cannot set headers, so SSE auth accepts the token via the `token`
// query parameter in addition to the standard Authorization header. Same
// verification logic — only the extraction differs.
function requireAuthSSE(req, res, next) {
  const header = req.headers.authorization;
  const raw = header && header.startsWith('Bearer ')
    ? header.slice(7).trim()
    : (typeof req.query.token === 'string' ? req.query.token : '');
  if (!raw) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(raw, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Admin gate. Composes requireAuth, then reads the actor's row LIVE from the DB
// rather than trusting the token: the JWT carries only id/username (see makeToken
// in routes/auth.js), and reading fresh means a demoted admin loses access on the
// very next request without anyone re-issuing tokens. Stashes the row on
// req.actor (id + both admin flags) so handlers can reuse it without re-querying.
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    const row = db.prepare('SELECT id, is_admin, is_super_admin FROM users WHERE id = ?').get(req.user.id);
    if (!row || row.is_admin !== 1) {
      return res.status(403).json({ error: 'Admin only' });
    }
    req.actor = row;
    next();
  });
}

module.exports = { requireAuth, requireAuthSSE, requireAdmin };
