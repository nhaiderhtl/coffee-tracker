---
topics: [consolidated-pr, pr-head-recovery, migration-number-collision, admin-panel-entry-point, goals-removal-cascade, unearnable-badges, sse-audit-method, local-bun-available]
---

# Backlog consolidation into one PR (2026-08-12)

Fourteen open PRs (#92–#98, #100–#106) were closed and their branches deleted on
both the fork and locally. This session rebuilt that work as one branch, then
audited and completed the issues behind it. PR #110.

## Closed PRs are recoverable after branch deletion

Deleting a PR's head branch does **not** destroy the commits. GitHub keeps them
at `refs/pull/<N>/head` on the **upstream** repo, long after the branch is gone:

```
git fetch origin refs/pull/104/head:pr/104
```

All 14 resolved to the SHA the deleted branch had. If work looks lost after a
branch cleanup, look here before rewriting anything.

## 🔴 Migration number collision would have hard-failed boot

`023_match_join_code.js` (from closed PR #106) collided with
`023_add_group_schedule.js`, which shipped to main while that PR sat open.
`migrate.js` rejects duplicates outright and a failed migration aborts the
process — the app would not have started.

Renumbered to `025_`. This is *not* the "never renumber a migration" rule
biting: that protects **shipped** migrations, and this had never merged. Any
long-lived branch carrying a migration needs its number re-checked against main
before merge; the collision is invisible until boot.

## Consolidating silently orphans entry points

Issue #68 moves the admin block off Profile into `/admin`. While that PR sat
open, PR #109 added a super-admin "Manage matches" button *to the block being
deleted*. The cherry-pick took the button with it: `/admin/matches` still
existed and still worked, but nothing linked to it — and an unreachable route is
valid code, so typecheck, build and tests all stayed green.

When a refactor *moves* a container, diff what landed in the old one while the
branch was open. A clean cherry-pick is not evidence that nothing was lost.

## 🔴 Removing Goals cascaded much further than a tab

`Stats.tsx` held the **only** caller of `POST /goals/complete`, and
`user_streaks` was written from nowhere else. So #83 pinned every user's "Day
Streak" to 0 forever and killed `streak_3/7/30` — which is most of what #84
means by badges that are no longer possible. Nothing failed; the number just
stopped moving.

Resolved by moving the streak to where the UI already claims it comes from:
consecutive local days with ≥1 coffee, computed in `checkAfterCoffeeLog`. Metric
renamed `goal_streak` → `day_streak`. What genuinely cannot outlive Goals
(`goals_10`, `first_goal_complete`, the `goal_getter` badge) is `retired: true`
rather than deleted, so users who earned it keep it. `checkAfterGoalsComplete`
was left in place for #17/#74 but no longer writes the streak — two writers on
one column with different meanings is a trap waiting for whoever restores it.

**The general lesson:** before deleting a UI surface, grep for the endpoint it
calls and check what else hangs off that write. Here one button was load-bearing
for a table, three achievements and three badges.

## Correction: `challenge_champion` IS earnable

An earlier pass in this session called it dead because no evaluator handles
`type: 'challenges_won'`. Wrong: `checkAfterChallengeWin` awards it imperatively
at 3 wins, and the declarative requirement is decorative. Auditing only the
declarative path gives false positives — check `unlockBadge` call sites too.

The real hazard stands and is now in AGENTS.md: badge requirements are
declarative data, so an unhandled type or a mistyped `achievementId` is silently
inert. Nothing errors.

## Audit per handler, not per file

Counting `router.post` against `broadcast` per file said #54 was covered. Per
*handler* it was not: unlocks refreshed no collection page, and the ticker —
lobbies opening and locking on schedule — pushed nothing at all, because no
request answers it. Both are invisible to a file-level count.

Fixed centrally where possible: `unlockAchievement`/`unlockBadge` push
`['badges']`/`['achievements']` themselves, so no call site has to remember.

## Correction: bun IS on PATH here

`2026-08-06-quick-issue-sweep.md` says this machine has no `bun`/`node` and only
CI can verify. Not true — bun 1.3.14 is installed and `bun run check` runs
locally. (The `client/` `bun install` EPERM gotcha now lives in AGENTS.md.)

## Label claims still unavailable

`gh issue edit --add-label` 403s for `nhaiderhtl` (no push rights), so claims are
comment-only. AGENTS.md calls the label claim best-effort, so this is within
protocol — but a claim is invisible to anyone filtering by label.
