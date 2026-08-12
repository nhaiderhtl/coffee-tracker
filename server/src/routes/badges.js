const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { BADGES } = require('../data/badges');

const router = express.Router();

// GET /api/badges — all badges with unlock status
router.get('/', requireAuth, (req, res) => {
  const unlocked = db.prepare(
    'SELECT badge_id, unlocked_at FROM user_badges WHERE user_id = ?'
  ).all(req.user.id);
  const unlockedMap = Object.fromEntries(unlocked.map(u => [u.badge_id, u.unlocked_at]));

  // A retired badge (one whose unlock path no longer exists — see `retired` in
  // data/badges.js) is dropped from the collection unless the viewer earned it
  // while it was live. Owners keep it; nobody else is shown a badge they could
  // never get.
  const result = BADGES.filter(b => !b.retired || unlockedMap[b.id]).map(b => {
    const isUnlocked = !!unlockedMap[b.id];
    if (b.secret && !isUnlocked) {
      return {
        id: b.id,
        name: '???',
        // No explanation for a hidden badge — a locked ??? gives nothing away.
        // Only real (unlocked) badges carry a description.
        description: '',
        icon: 'lock',
        rarity: 'secret',
        secret: true,
        unlocked: false,
        unlocked_at: null,
      };
    }
    return { ...b, unlocked: isUnlocked, unlocked_at: unlockedMap[b.id] || null };
  });

  res.json(result);
});

module.exports = router;
