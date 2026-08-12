const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { ACHIEVEMENTS } = require('../data/achievements');

const router = express.Router();

// GET /api/achievements — all achievements with unlock status for the current user
router.get('/', requireAuth, (req, res) => {
  const unlocked = db.prepare(
    'SELECT achievement_id, unlocked_at FROM user_achievements WHERE user_id = ?'
  ).all(req.user.id);
  const unlockedMap = Object.fromEntries(unlocked.map(u => [u.achievement_id, u.unlocked_at]));

  // Retired achievements (goals, issue #83) stay listed only for the users who
  // already earned them — see the same rule in routes/badges.js.
  const result = ACHIEVEMENTS.filter(a => !a.retired || unlockedMap[a.id]).map(a => {
    const isUnlocked = !!unlockedMap[a.id];
    // Hide secret achievements that haven't been unlocked
    if (a.secret && !isUnlocked) {
      return {
        id: a.id,
        name: '???',
        description: 'Keep exploring to discover this secret achievement',
        icon: 'lock',
        secret: true,
        category: a.category,
        unlocked: false,
        unlocked_at: null,
      };
    }
    return { ...a, unlocked: isUnlocked, unlocked_at: unlockedMap[a.id] || null };
  });

  res.json(result);
});

module.exports = router;
