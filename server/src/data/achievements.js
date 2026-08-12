// The live catalog size backs the "try every type" target (issue #77), read
// through a getter (see variety_all below) so it tracks admin edits — adding or
// deleting a coffee changes the goal immediately, no restart, and there is no
// DB query at import time (which would run before migrations in some require
// orders).
const { coffeeCount } = require('../coffees');

// `progress` is the single source of truth for a milestone's threshold: the
// unlock engine (server/src/achievements.js) tests against it and the client
// draws its progress bar from it, so the two can never drift. Achievements
// without it are events, not counters, and get no bar.
//   metric — which running total to compare against, resolved client-side from
//            /coffees/stats and /streaks.
//   target — the number to reach. Derived at runtime where it depends on data
//            that changes (the menu), never typed out as a literal.
const ACHIEVEMENTS = [
  // ── Volume milestones ──────────────────────────────────────────────────────
  {
    id: 'first_sip',
    name: 'First Sip',
    description: 'Log your very first coffee',
    icon: 'coffee',
    secret: false,
    category: 'milestone',
  },
  {
    id: 'ten_cups',
    name: 'Getting Started',
    description: 'Log 10 total coffees',
    icon: 'seedling',
    secret: false,
    category: 'milestone',
    progress: { metric: 'total_cups', target: 10 },
  },
  {
    id: 'fifty_cups',
    name: 'Regular',
    description: 'Log 50 total coffees',
    icon: 'chart-line',
    secret: false,
    category: 'milestone',
    progress: { metric: 'total_cups', target: 50 },
  },
  {
    id: 'hundred_cups',
    name: 'Century',
    description: 'Log 100 total coffees',
    icon: 'century',
    secret: false,
    category: 'milestone',
    progress: { metric: 'total_cups', target: 100 },
  },
  {
    id: 'five_hundred_cups',
    name: 'Coffee Legend',
    description: 'Log 500 total coffees',
    icon: 'trophy',
    secret: false,
    category: 'milestone',
    progress: { metric: 'total_cups', target: 500 },
  },

  // ── Caffeine milestones ────────────────────────────────────────────────────
  {
    id: 'caffeine_1000',
    name: 'Caffeinated',
    description: 'Consume 1,000mg caffeine total',
    icon: 'bolt',
    secret: false,
    category: 'caffeine',
    progress: { metric: 'total_caffeine', target: 1000 },
  },
  {
    id: 'caffeine_10000',
    name: 'Caffeine Machine',
    description: 'Consume 10,000mg caffeine total',
    icon: 'battery',
    secret: false,
    category: 'caffeine',
    progress: { metric: 'total_caffeine', target: 10000 },
  },
  {
    id: 'overdrive_day',
    name: 'Into the Red',
    description: 'Reach Overdrive in a single day (500mg+)',
    icon: 'fire',
    secret: true,
    category: 'caffeine',
  },
  {
    id: 'gone_day',
    name: 'Flatlined',
    description: 'Reach the Gone theme... somehow survive',
    icon: 'flatline',
    secret: true,
    category: 'caffeine',
  },

  // ── Variety ────────────────────────────────────────────────────────────────
  {
    id: 'variety_3',
    name: 'Explorer',
    description: 'Try 3 different coffee types',
    icon: 'map',
    secret: false,
    category: 'variety',
    progress: { metric: 'unique_types', target: 3 },
  },
  {
    id: 'variety_7',
    name: 'Connoisseur',
    description: 'Try 7 different coffee types',
    icon: 'hat',
    secret: false,
    category: 'variety',
    progress: { metric: 'unique_types', target: 7 },
  },
  {
    id: 'variety_all',
    name: 'Full Menu',
    description: 'Try every coffee type on the menu',
    icon: 'list',
    secret: false,
    category: 'variety',
    progress: { metric: 'unique_types', get target() { return coffeeCount(); } },
  },

  // ── Time of day ────────────────────────────────────────────────────────────
  {
    id: 'early_bird',
    name: 'Early Bird',
    description: 'Log a coffee before 7:00 AM',
    icon: 'sunrise',
    secret: false,
    category: 'time',
  },
  {
    id: 'night_owl',
    name: 'Night Owl',
    description: 'Log a coffee after 10:00 PM',
    icon: 'night',
    secret: true,
    category: 'time',
  },
  {
    id: 'morning_ritual',
    name: 'Morning Ritual',
    description: 'Log coffee at the same time (±30min) for 5 consecutive days',
    icon: 'clock',
    secret: true,
    category: 'time',
  },

  // ── Streaks ────────────────────────────────────────────────────────────────
  // The streak counts consecutive local days with at least one coffee. It used
  // to count consecutive days of *completing daily goals*, which stopped
  // advancing the moment issue #83 removed the Goals UI — the metric was renamed
  // from `goal_streak` to `day_streak` along with the source it reads.
  {
    id: 'streak_3',
    name: 'On a Roll',
    description: 'Logged a coffee 3 days in a row',
    icon: 'fire',
    secret: false,
    category: 'streak',
    progress: { metric: 'day_streak', target: 3 },
  },
  {
    id: 'streak_7',
    name: 'Committed',
    description: 'Logged a coffee 7 days in a row',
    icon: 'fire',
    secret: false,
    category: 'streak',
    progress: { metric: 'day_streak', target: 7 },
  },
  {
    id: 'streak_30',
    name: 'Unstoppable',
    description: 'Logged a coffee 30 days in a row',
    icon: 'fire',
    secret: false,
    category: 'streak',
    progress: { metric: 'day_streak', target: 30 },
  },

  // ── Combos ─────────────────────────────────────────────────────────────────
  {
    id: 'combo_3',
    name: 'Triple Shot',
    description: 'Log 3 coffees within 2 hours',
    icon: 'bolt',
    secret: false,
    category: 'combo',
  },
  {
    id: 'combo_5',
    name: 'Quintuple Shot',
    description: 'Log 5 coffees within 2 hours',
    icon: 'sparkles',
    secret: false,
    category: 'combo',
  },

  // ── Goals ──────────────────────────────────────────────────────────────────
  {
    id: 'first_goal_complete',
    name: 'Goal-Getter',
    description: 'Complete all daily goals for the first time',
    icon: 'check-circle',
    secret: false,
    retired: true,
    category: 'goals',
  },
  {
    id: 'goals_10',
    name: 'Disciplined',
    description: 'Complete all daily goals 10 times',
    icon: 'chart',
    secret: false,
    retired: true,
    category: 'goals',
  },

  // ── Social ─────────────────────────────────────────────────────────────────
  {
    id: 'first_compare',
    name: 'How Do You Compare?',
    description: 'Compare stats with another user for the first time',
    icon: 'scale',
    secret: false,
    category: 'social',
  },
  {
    id: 'compare_5',
    name: 'Competitive',
    description: 'Compare stats with 5 different users',
    icon: 'medal',
    secret: false,
    category: 'social',
  },

  // ── Challenges ─────────────────────────────────────────────────────────────
  {
    id: 'first_challenge',
    name: 'Up for a Challenge',
    description: 'Complete your first challenge',
    icon: 'target',
    secret: false,
    category: 'challenge',
  },
  {
    id: 'challenge_win',
    name: 'Champion',
    description: 'Win a community challenge',
    icon: 'trophy',
    secret: false,
    category: 'challenge',
  },

  // ── Secret easter eggs ─────────────────────────────────────────────────────
  {
    id: 'decaf_spy',
    name: 'Decaf Spy',
    description: 'A beverage of deception, followed by the real thing',
    icon: 'spy',
    secret: true,
    category: 'secret',
  },
  {
    id: 'coffee_loop',
    name: 'Coffee Loop',
    description: 'Same pattern, day after day after day...',
    icon: 'loop',
    secret: true,
    category: 'secret',
  },
  {
    id: 'monochrome',
    name: 'Monochrome',
    description: 'One type. Only ever one type. Always.',
    icon: 'square',
    secret: true,
    category: 'secret',
  },
];

module.exports = { ACHIEVEMENTS };
