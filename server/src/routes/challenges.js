const express = require('express');
const { randomUUID } = require('crypto');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const {
  checkAfterChallengeWin,
  checkAfterFirstChallenge,
} = require('../achievements');
const { coffeeCount } = require('../coffees');
const { broadcast } = require('../events');

const router = express.Router();

// Aggregate progress toward a metric for one or more users since startDate.
// Pass a single-element array for an individual participant's progress.
function computeProgress(metric, startDate, userIds) {
  if (!userIds || userIds.length === 0) return 0;
  // Challenges are shared across users, so their start/end are challenge-global
  // civil dates anchored to UTC (not any single participant's zone). Parse with
  // an explicit Z so the boundary never depends on the server's local zone.
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const placeholders = userIds.map(() => '?').join(',');
  const scope = `user_id IN (${placeholders}) AND`;

  switch (metric) {
    case 'espresso_cups':
      return db.prepare(
        `SELECT COUNT(*) as v FROM coffee_entries WHERE ${scope} coffee_id IN ('espresso','espresso_mac') AND logged_at >= ?`
      ).get(...userIds, start).v;
    case 'caffeine':
      return db.prepare(
        `SELECT COALESCE(SUM(caffeine_mg),0) as v FROM coffee_entries WHERE ${scope} logged_at >= ?`
      ).get(...userIds, start).v;
    case 'unique_types':
      return db.prepare(
        `SELECT COUNT(DISTINCT coffee_id) as v FROM coffee_entries WHERE ${scope} logged_at >= ?`
      ).get(...userIds, start).v;
    case 'total_cups':
      return db.prepare(
        `SELECT COUNT(*) as v FROM coffee_entries WHERE ${scope} logged_at >= ?`
      ).get(...userIds, start).v;
    default:
      return 0;
  }
}

function communityProgressFor(challenge, participants) {
  return computeProgress(challenge.metric, challenge.start_date, participants.map(p => p.user_id));
}

function userProgressFor(challenge, userId) {
  return computeProgress(challenge.metric, challenge.start_date, [userId]);
}

function seedCommunityChallenges() {
  const existing = db.prepare("SELECT COUNT(*) as cnt FROM challenges WHERE type = 'community'").get();
  if (existing.cnt > 0) return;

  const today = new Date();
  const weekEnd = new Date(today);
  weekEnd.setDate(today.getDate() + 7);
  const monthEnd = new Date(today);
  monthEnd.setDate(today.getDate() + 30);
  const todayStr2 = today.toISOString().slice(0, 10);

  // Target tracks the menu — adding a coffee type must not silently leave the
  // Variety Show completable without trying the new one. Read from the live
  // catalog (issue #77); fixed for this challenge's life once seeded, same as
  // the old COFFEES.length was fixed at boot.
  const menuSize = coffeeCount();

  const challenges = [
    { id: randomUUID(), name: 'Espresso Week', description: 'As a community, drink 500 espressos this week!', metric: 'espresso_cups', target: 500, end: weekEnd },
    { id: randomUUID(), name: 'Caffeine Collective', description: 'Reach 100,000mg of caffeine together this month!', metric: 'caffeine', target: 100000, end: monthEnd },
    { id: randomUUID(), name: 'Variety Show', description: `Try all ${menuSize} coffee types as a community this week!`, metric: 'unique_types', target: menuSize, end: weekEnd },
  ];

  const insert = db.prepare(
    'INSERT INTO challenges (id, type, creator_id, name, description, metric, target, start_date, end_date, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  for (const c of challenges) {
    insert.run(c.id, 'community', null, c.name, c.description, c.metric, c.target, todayStr2, c.end.toISOString().slice(0, 10), 'active');
  }
}

seedCommunityChallenges();

router.get('/', requireAuth, (req, res) => {
  // Personal challenges were removed (issue #51) — only community challenges,
  // shared by everyone, exist now. They surface here and on the Compete page.
  const challenges = db.prepare(
    "SELECT * FROM challenges WHERE status = 'active' AND type = 'community' ORDER BY end_date"
  ).all();

  const result = challenges.map(c => {
    const participants = db.prepare(
      'SELECT cp.*, u.username FROM challenge_participants cp JOIN users u ON u.id = cp.user_id WHERE cp.challenge_id = ?'
    ).all(c.id);
    const joined = participants.some(p => p.user_id === req.user.id);

    return {
      ...c,
      participants_count: participants.length,
      community_progress: communityProgressFor(c, participants),
      my_progress: joined ? userProgressFor(c, req.user.id) : null,
      joined,
    };
  });

  res.json(result);
});

router.post('/:id/join', requireAuth, (req, res) => {
  const challenge = db.prepare("SELECT * FROM challenges WHERE id = ? AND status = 'active'").get(req.params.id);
  if (!challenge) return res.status(404).json({ error: 'Challenge not found' });

  const existing = db.prepare('SELECT id FROM challenge_participants WHERE challenge_id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (existing) return res.status(409).json({ error: 'Already joined' });

  db.prepare(
    'INSERT INTO challenge_participants (id, challenge_id, user_id, joined_at) VALUES (?, ?, ?, ?)'
  ).run(randomUUID(), req.params.id, req.user.id, Date.now());

  // Unlock side effect only — any unlock is persisted as a notification and
  // reaches the client through the bell, not this response (issue #32).
  checkAfterFirstChallenge(req.user.id);
  broadcast([['challenges']], undefined, { except: req.user.id });
  res.json({ ok: true });
});

router.get('/:id', requireAuth, (req, res) => {
  const challenge = db.prepare('SELECT * FROM challenges WHERE id = ?').get(req.params.id);
  if (!challenge) return res.status(404).json({ error: 'Not found' });

  const participants = db.prepare(
    'SELECT cp.*, u.username FROM challenge_participants cp JOIN users u ON u.id = cp.user_id WHERE cp.challenge_id = ?'
  ).all(challenge.id);
  const communityProgress = communityProgressFor(challenge, participants);

  const now = Date.now();
  const endDate = Date.parse(`${challenge.end_date}T23:59:59Z`);

  if (communityProgress >= challenge.target && challenge.status === 'active') {
    db.prepare("UPDATE challenges SET status = 'completed' WHERE id = ?").run(challenge.id);
    for (const p of participants) {
      db.prepare('UPDATE challenge_participants SET completed = 1 WHERE challenge_id = ? AND user_id = ?').run(challenge.id, p.user_id);
      checkAfterChallengeWin(p.user_id);
    }
    // A challenge flipping to completed is the one state change here nobody
    // triggered on purpose — it falls out of whoever happened to open it.
    broadcast([['challenges'], ['badges'], ['achievements']]);
  } else if (now > endDate && challenge.status === 'active') {
    // Ran out the clock without hitting the target — retire it, no winners.
    db.prepare("UPDATE challenges SET status = 'completed' WHERE id = ?").run(challenge.id);
  }

  res.json({
    ...challenge,
    participants_count: participants.length,
    participants: participants.map(p => ({
      username: p.username,
      progress: userProgressFor(challenge, p.user_id),
    })),
    community_progress: communityProgress,
    my_progress: userProgressFor(challenge, req.user.id),
    joined: participants.some(p => p.user_id === req.user.id),
  });
});

module.exports = router;
