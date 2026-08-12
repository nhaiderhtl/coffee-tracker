const { randomUUID } = require('crypto');
const db = require('./db');
const { ACHIEVEMENTS } = require('./data/achievements');
const { BADGES } = require('./data/badges');
const { getUserTz, localDateStr, localTodayStr, localParts } = require('./time');
const { createNotification, TYPES } = require('./notifications');

// Civil day/hour for streaks and time-of-day achievements are evaluated in the
// user's own timezone. See docs/time-and-timezones.md.
function yesterdayOf(dateStr) {
  return new Date(Date.parse(`${dateStr}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
}

function unlockAchievement(userId, achievementId) {
  const already = db.prepare(
    'SELECT id FROM user_achievements WHERE user_id = ? AND achievement_id = ?'
  ).get(userId, achievementId);
  if (already) return null;

  const def = ACHIEVEMENTS.find(a => a.id === achievementId);
  if (!def) return null;

  db.prepare(
    'INSERT INTO user_achievements (id, user_id, achievement_id, unlocked_at) VALUES (?, ?, ?, ?)'
  ).run(randomUUID(), userId, achievementId, Date.now());

  // Persist the unlock as a self-contained notification (issue #32). The early
  // `return null` on a duplicate above means a re-check emits nothing. Payload
  // embeds every display field so the renderer never reads back into the defs.
  createNotification(userId, TYPES.ACHIEVEMENT, {
    id: def.id, name: def.name, icon: def.icon, description: def.description,
  });

  const badges = checkBadgesForAchievement(userId, achievementId);
  return { def, badges };
}

// Unlock every counter milestone whose threshold the supplied running totals
// have reached. `values` maps a `progress.metric` name to the user's current
// figure; metrics absent from it are simply not evaluated on this pass, which
// is how the goal-streak milestones stay out of the coffee-logging path.
function checkCounterMilestones(userId, values) {
  const unlocked = [];
  for (const a of ACHIEVEMENTS) {
    if (!a.progress) continue;
    const current = values[a.progress.metric];
    if (current === undefined) continue;
    if (current >= a.progress.target) unlocked.push(..._try(userId, a.id));
  }
  return unlocked;
}

function unlockBadge(userId, badgeId) {
  const already = db.prepare(
    'SELECT id FROM user_badges WHERE user_id = ? AND badge_id = ?'
  ).get(userId, badgeId);
  if (already) return null;

  const def = BADGES.find(b => b.id === badgeId);
  if (!def) return null;

  db.prepare(
    'INSERT INTO user_badges (id, user_id, badge_id, unlocked_at) VALUES (?, ?, ?, ?)'
  ).run(randomUUID(), userId, badgeId, Date.now());

  // Every unlock write point routes through here (achievement-, ranking- and
  // count-driven badges alike), so one emit covers them all (issue #32).
  createNotification(userId, TYPES.BADGE, {
    id: def.id, name: def.name, icon: def.icon, description: def.description,
  });
  return def;
}

// Badge requirements are declarative data, and only two functions read them:
// this one handles `type: 'achievement'` and checkBadgeForRanking below handles
// `type: 'ranking'`. Any other type is silently inert — no error, no failing
// test, the badge simply never unlocks. (`challenges_won` is such a type, but
// that badge is fine: checkAfterChallengeWin awards it imperatively.)
//
// So when adding a requirement type, add its evaluator here in the same change,
// and check every `achievementId` exists in data/achievements.js — a typo fails
// the same silent way, and neither typecheck nor the suite will say a word.
function checkBadgesForAchievement(userId, achievementId) {
  const notifs = [];
  for (const badge of BADGES) {
    if (badge.requirement.type === 'achievement' && badge.requirement.achievementId === achievementId) {
      const b = unlockBadge(userId, badge.id);
      if (b) notifs.push({ type: 'badge', ...b });
    }
  }
  return notifs;
}

// The current leader of each all-time board, keyed by the `metric` a ranking
// badge names in badges.js. Adding a board is a data edit there plus one query
// here — never a change to the awarding loop below.
const RANKING_LEADER_SQL = {
  // Top of the Elo ladder — only players who have settled at least one match, so
  // the 1000 default never crowns someone who has never competed.
  elo: `
    SELECT user_id AS id
    FROM user_ratings
    WHERE matches > 0
    ORDER BY rating DESC
    LIMIT 1
  `,
  // Most caffeine logged, all time. HAVING keeps an empty board from crowning a
  // zero-total row.
  caffeine: `
    SELECT user_id AS id
    FROM coffee_entries
    GROUP BY user_id
    HAVING SUM(caffeine_mg) > 0
    ORDER BY SUM(caffeine_mg) DESC
    LIMIT 1
  `,
  // Most cups logged, all time.
  cups: `
    SELECT user_id AS id
    FROM coffee_entries
    GROUP BY user_id
    ORDER BY COUNT(*) DESC
    LIMIT 1
  `,
};

// Award every "you're #1" badge to whoever currently leads its board. These are
// permanent once earned — losing the lead later never revokes them. Driven by
// each ranking badge's own `metric` (issue: Top Brewer moved to Elo, plus the
// Addicted/Decorated volume boards), so this loop never names a specific badge.
function checkBadgeForRanking() {
  for (const badge of BADGES) {
    if (badge.requirement.type !== 'ranking') continue;
    const sql = RANKING_LEADER_SQL[badge.requirement.metric];
    if (!sql) continue;
    const leader = db.prepare(sql).get();
    if (leader) unlockBadge(leader.id, badge.id);
  }
}

function checkAfterCoffeeLog(userId) {
  const unlocked = [];
  const tz = getUserTz(db, userId);

  const allEntries = db.prepare(
    'SELECT coffee_id, caffeine_mg, logged_at FROM coffee_entries WHERE user_id = ? ORDER BY logged_at'
  ).all(userId);

  const today         = localTodayStr(tz);
  const totalCups     = allEntries.length;
  const totalCaffeine = allEntries.reduce((s, e) => s + e.caffeine_mg, 0);
  const todayEntries  = allEntries.filter(e => localDateStr(e.logged_at, tz) === today);
  const todayCaffeine = todayEntries.reduce((s, e) => s + e.caffeine_mg, 0);
  const seenTypes     = new Set(allEntries.map(e => e.coffee_id));
  const latestTs      = allEntries[allEntries.length - 1]?.logged_at;
  const latestHour    = latestTs !== undefined ? localParts(latestTs, tz).hour : -1;

  // Volume, caffeine total and variety are all plain "running total reached a
  // threshold" milestones, so they come straight off the `progress` metadata
  // rather than being restated here. The client draws its bars from the same
  // numbers, which is what stops the two from drifting apart.
  unlocked.push(...checkCounterMilestones(userId, {
    total_cups: totalCups,
    total_caffeine: totalCaffeine,
    unique_types: seenTypes.size,
  }));

  if (totalCups >= 1) unlocked.push(..._try(userId, 'first_sip'));

  // Daily caffeine thresholds
  if (todayCaffeine >= 500)  unlocked.push(..._try(userId, 'overdrive_day'));
  if (todayCaffeine >= 1000) unlocked.push(..._try(userId, 'gone_day'));

  // Time of day
  if (latestHour < 7 && latestHour >= 0) unlocked.push(..._try(userId, 'early_bird'));
  if (latestHour >= 22)                   unlocked.push(..._try(userId, 'night_owl'));

  // Morning ritual
  unlocked.push(...checkMorningRitual(userId, allEntries, tz));

  // Combo
  unlocked.push(...checkCombo(userId, todayEntries));

  // Day streak
  unlocked.push(...checkDayStreak(userId, allEntries, tz, today));

  // Secret: decaf spy
  const last2 = allEntries.slice(-2);
  if (last2.length === 2 && last2[0].coffee_id === 'hot_chocolate' && last2[1].coffee_id === 'espresso') {
    unlocked.push(..._try(userId, 'decaf_spy'));
  }

  // Secret: monochrome
  if (totalCups >= 10 && seenTypes.size === 1) {
    unlocked.push(..._try(userId, 'monochrome'));
  }

  // Secret: coffee_loop
  unlocked.push(...checkCoffeeLoop(userId, allEntries, tz));

  // Increment casualties if user just crossed 400mg today
  const lastEntry = allEntries[allEntries.length - 1];
  const prevCaffeine = todayCaffeine - (lastEntry?.caffeine_mg || 0);
  if (prevCaffeine < 400 && todayCaffeine >= 400) {
    db.prepare('UPDATE coffee_casualties SET count = count + 1 WHERE id = 1').run();
  }

  return unlocked;
}

// Consecutive local days ending today that have at least one coffee in them.
//
// This used to be a *goal* streak, advanced only by POST /api/goals/complete.
// Issue #83 removed the Goals UI and with it that endpoint's only caller, so
// `user_streaks` stopped being written at all: every user's "Day Streak" tile
// sat at 0 forever and streak_3/7/30 became unreachable. Reading the streak off
// the coffee log instead is what the UI already claims it is — a day streak,
// under a flame — and it needs no goals to exist.
//
// Counting back from today is safe because this only runs right after a coffee
// was logged, so today is always present. `last_goal_date` keeps its column
// name (renaming it would be a migration for no behavioural gain); it now means
// "last day counted into the streak".
function checkDayStreak(userId, allEntries, tz, today) {
  const days = new Set(allEntries.map((e) => localDateStr(e.logged_at, tz)));

  let current = 0;
  for (let day = today; days.has(day); day = yesterdayOf(day)) current += 1;

  const row = db.prepare('SELECT * FROM user_streaks WHERE user_id = ?').get(userId);
  const longest = Math.max(row?.longest_streak ?? 0, current);
  if (row) {
    db.prepare(
      'UPDATE user_streaks SET current_streak = ?, longest_streak = ?, last_goal_date = ? WHERE user_id = ?'
    ).run(current, longest, today, userId);
  } else if (db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) {
    // Registration seeds a row, so this only runs for a user created outside
    // that path. Checking the parent first keeps the FOREIGN KEY from throwing
    // when the account was deleted while this request was still in flight —
    // photo processing is async, so that window is real, not theoretical.
    db.prepare(
      'INSERT INTO user_streaks (user_id, current_streak, longest_streak, last_goal_date) VALUES (?, ?, ?, ?)'
    ).run(userId, current, longest, today);
  }

  return checkCounterMilestones(userId, { day_streak: current });
}

function checkCombo(userId, todayEntries) {
  const unlocked = [];
  if (todayEntries.length < 2) return unlocked;
  const now = todayEntries[todayEntries.length - 1].logged_at;
  const window = 2 * 60 * 60 * 1000;
  const inWindow = todayEntries.filter(e => now - e.logged_at <= window);
  const current = inWindow.length;

  const combo = db.prepare('SELECT * FROM user_combos WHERE user_id = ?').get(userId);
  if (!combo) {
    db.prepare(
      'INSERT INTO user_combos (user_id, current_combo, highest_combo, last_coffee_at) VALUES (?, ?, ?, ?)'
    ).run(userId, current, current, now);
  } else {
    const highest = Math.max(combo.highest_combo, current);
    db.prepare(
      'UPDATE user_combos SET current_combo = ?, highest_combo = ?, last_coffee_at = ? WHERE user_id = ?'
    ).run(current, highest, now, userId);
  }

  if (current >= 3) unlocked.push(..._try(userId, 'combo_3'));
  if (current >= 5) unlocked.push(..._try(userId, 'combo_5'));
  return unlocked;
}

function checkMorningRitual(userId, allEntries, tz) {
  if (allEntries.length < 5) return [];
  const byDay = {};
  for (const e of allEntries) {
    const d = localDateStr(e.logged_at, tz);
    if (!byDay[d]) byDay[d] = e.logged_at;
  }
  const days = Object.keys(byDay).sort();
  if (days.length < 5) return [];
  const last5 = days.slice(-5);
  const hours = last5.map(d => { const p = localParts(byDay[d], tz); return p.hour * 60 + p.minute; });
  const baseMin = hours[0];
  if (hours.every(m => Math.abs(m - baseMin) <= 30)) return _try(userId, 'morning_ritual');
  return [];
}

function checkCoffeeLoop(userId, allEntries, tz) {
  if (allEntries.length < 9) return [];
  const byDay = {};
  for (const e of allEntries) {
    const d = localDateStr(e.logged_at, tz);
    if (!byDay[d]) byDay[d] = [];
    byDay[d].push(e.coffee_id);
  }
  const days = Object.keys(byDay).sort().slice(-3);
  if (days.length < 3) return [];
  const seqs = days.map(d => byDay[d].slice(0, 3).join(','));
  if (seqs[0] === seqs[1] && seqs[1] === seqs[2]) return _try(userId, 'coffee_loop');
  return [];
}

// UNREACHABLE as of issue #83: this runs only from POST /api/goals/complete,
// whose only caller was the Goals tab that #83 removed.
//
// What used to depend on it has been moved off or retired rather than left to
// rot: the day streak is now derived from the coffee log (checkDayStreak), and
// `first_goal_complete` / `goals_10` plus the `goal_getter` badge are marked
// `retired` so they stay visible to whoever already earned them without being
// advertised to anyone else. The code below is kept, not deleted, so that
// rehoming Goals (#17, #74) only needs a caller restored.
function checkAfterGoalsComplete(userId) {
  const unlocked = [];
  const tz = getUserTz(db, userId);
  const today = localTodayStr(tz);
  const streak = db.prepare('SELECT * FROM user_streaks WHERE user_id = ?').get(userId);
  const total = streak?.goals_completed || 0;

  if (!streak) {
    db.prepare(
      'INSERT INTO user_streaks (user_id, current_streak, longest_streak, last_goal_date, goals_completed) VALUES (?, 1, 1, ?, 1)'
    ).run(userId, today);
  } else {
    // Consecutive = last completion was the user's local yesterday. Comparing
    // calendar-date strings makes this DST-proof.
    const isConsecutive = streak.last_goal_date === yesterdayOf(today);
    const newStreak = isConsecutive ? streak.current_streak + 1 : 1;
    const longest   = Math.max(streak.longest_streak, newStreak);
    db.prepare(
      'UPDATE user_streaks SET current_streak = ?, longest_streak = ?, last_goal_date = ?, goals_completed = ? WHERE user_id = ?'
    ).run(newStreak, longest, today, total + 1, userId);

    unlocked.push(...checkCounterMilestones(userId, { goal_streak: newStreak }));
  }

  const newTotal = total + 1;
  if (newTotal === 1)  unlocked.push(..._try(userId, 'first_goal_complete'));
  if (newTotal >= 10) unlocked.push(..._try(userId, 'goals_10'));

  return unlocked;
}

function checkAfterCompare(userId, comparedWithId) {
  const unlocked = [];

  const existing = db.prepare(
    'SELECT id FROM compare_history WHERE user_id = ? AND compared_with = ?'
  ).get(userId, comparedWithId);
  if (!existing) {
    db.prepare(
      'INSERT INTO compare_history (id, user_id, compared_with, compared_at) VALUES (?, ?, ?, ?)'
    ).run(randomUUID(), userId, comparedWithId, Date.now());
  }

  const uniqueCount = db.prepare(
    'SELECT COUNT(DISTINCT compared_with) AS cnt FROM compare_history WHERE user_id = ?'
  ).get(userId).cnt;

  if (uniqueCount >= 1) unlocked.push(..._try(userId, 'first_compare'));
  if (uniqueCount >= 5) unlocked.push(..._try(userId, 'compare_5'));

  return unlocked;
}

function checkAfterChallengeWin(userId) {
  const unlocked = [];
  unlocked.push(..._try(userId, 'challenge_win'));

  const wins = db.prepare(
    'SELECT COUNT(*) AS cnt FROM challenge_participants WHERE user_id = ? AND completed = 1'
  ).get(userId).cnt;
  if (wins >= 3) {
    const b = unlockBadge(userId, 'challenge_champion');
    if (b) unlocked.push({ type: 'badge', ...b });
  }

  return unlocked;
}

function checkAfterFirstChallenge(userId) {
  return _try(userId, 'first_challenge');
}

function _try(userId, achievementId) {
  const res = unlockAchievement(userId, achievementId);
  if (!res) return [];
  return [{ type: 'achievement', ...res.def }, ...res.badges];
}

module.exports = {
  unlockAchievement,
  unlockBadge,
  checkBadgeForRanking,
  checkAfterCoffeeLog,
  checkAfterGoalsComplete,
  checkAfterCompare,
  checkAfterChallengeWin,
  checkAfterFirstChallenge,
};
