const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { getDailyTasks } = require('../data/tasks');
const { checkAfterGoalsComplete } = require('../achievements');
const { getUserTz, localTodayStr, localDayBounds, localWallInstant } = require('../time');

const router = express.Router();

// Tasks are civil-day constructs, evaluated in the user's timezone.
function evaluateTask(taskId, userId, tz) {
  const today = localTodayStr(tz);
  const { start: dayStart, end: dayEnd } = localDayBounds(today, tz);

  const todayEntries = db.prepare(
    'SELECT coffee_id, caffeine_mg, logged_at FROM coffee_entries WHERE user_id = ? AND logged_at BETWEEN ? AND ?'
  ).all(userId, dayStart, dayEnd);

  const todayCaffeine = todayEntries.reduce((s, e) => s + e.caffeine_mg, 0);
  const todayTypes = new Set(todayEntries.map(e => e.coffee_id));

  const weekStart = Date.now() - 7 * 86400000;
  const weekEntries = db.prepare(
    'SELECT coffee_id FROM coffee_entries WHERE user_id = ? AND logged_at >= ?'
  ).all(userId, weekStart);
  const weekTypes = new Set(weekEntries.map(e => e.coffee_id));

  const allTypes = new Set(db.prepare(
    'SELECT DISTINCT coffee_id FROM coffee_entries WHERE user_id = ?'
  ).all(userId).map(e => e.coffee_id));

  switch (taskId) {
    case 'log_first_coffee':
      return todayEntries.length >= 1;

    case 'try_new_type': {
      // A type not logged any time this week before today
      const prevWeekEntries = db.prepare(
        'SELECT DISTINCT coffee_id FROM coffee_entries WHERE user_id = ? AND logged_at >= ? AND logged_at < ?'
      ).all(userId, weekStart, dayStart);
      const prevTypes = new Set(prevWeekEntries.map(e => e.coffee_id));
      return todayEntries.some(e => !prevTypes.has(e.coffee_id));
    }

    case 'stay_under_limit':
      return todayEntries.length > 0 && todayCaffeine < 400;

    case 'log_before_10am': {
      const tenAm = localWallInstant(today, '10:00:00', tz);
      return todayEntries.some(e => e.logged_at < tenAm);
    }

    case 'log_after_3pm': {
      const threePm = localWallInstant(today, '15:00:00', tz);
      return todayEntries.some(e => e.logged_at >= threePm);
    }

    case 'two_types':
      return todayTypes.size >= 2;

    case 'three_cups':
      return todayEntries.length >= 3;

    case 'have_espresso':
      return todayEntries.some(e => e.coffee_id === 'espresso' || e.coffee_id === 'espresso_mac');

    case 'have_latte':
      return todayEntries.some(e => e.coffee_id === 'latte' || e.coffee_id === 'latte_macchiato');

    case 'under_200mg':
      return todayEntries.length > 0 && todayCaffeine < 200;

    case 'log_within_hour_of_waking': {
      const eightAm = localWallInstant(today, '08:00:00', tz);
      return todayEntries.some(e => e.logged_at < eightAm);
    }

    case 'exactly_two_cups':
      return todayEntries.length === 2;

    case 'have_doppio':
      return todayEntries.some(e => e.coffee_id === 'doppio');

    case 'have_cold':
      return todayEntries.some(e => e.coffee_id === 'frappuccino');

    default:
      return false;
  }
}

// GET /api/goals/today — get today's tasks with current completion state
router.get('/today', requireAuth, (req, res) => {
  const tz = getUserTz(db, req.user.id);
  const today = localTodayStr(tz);
  const tasks = getDailyTasks(today, req.user.id).map(task => ({
    ...task,
    completed: evaluateTask(task.id, req.user.id, tz),
  }));

  const streak = db.prepare('SELECT * FROM user_streaks WHERE user_id = ?').get(req.user.id);
  res.json({ date: today, tasks, streak });
});

// POST /api/goals/complete — evaluate all tasks and award streak if all done
//
// NO CALLER as of issue #83: Stats.tsx held the only client call and the Goals
// tab went with it. The route still mounts and still works — nothing hits it.
// The streak no longer depends on it (it is derived from the coffee log now,
// see checkDayStreak), and the goal achievements/badge are marked `retired`.
// Kept so that rehoming Goals (#17, #74) is just a matter of adding a caller.
router.post('/complete', requireAuth, (req, res) => {
  const tz = getUserTz(db, req.user.id);
  const today = localTodayStr(tz);
  const tasks = getDailyTasks(today, req.user.id).map(task => ({
    ...task,
    completed: evaluateTask(task.id, req.user.id, tz),
  }));

  const allDone = tasks.every(t => t.completed);

  if (allDone) {
    // Only credit if not already credited today. Any unlock is persisted as a
    // notification inside checkAfterGoalsComplete and reaches the client through
    // the bell, so the response no longer returns an `unlocked` array (#32).
    const streak = db.prepare('SELECT * FROM user_streaks WHERE user_id = ?').get(req.user.id);
    if (streak?.last_goal_date !== today) {
      checkAfterGoalsComplete(req.user.id);
    }
  }

  const updatedStreak = db.prepare('SELECT * FROM user_streaks WHERE user_id = ?').get(req.user.id);
  res.json({ tasks, allDone, streak: updatedStreak });
});

module.exports = router;
