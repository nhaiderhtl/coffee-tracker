---
topics: [consolidated-pr, migration-number-collision, admin-panel-entry-point, pr-head-recovery, local-bun-available, goals-removal-orphans-badges, unearnable-badges]
---

# Backlog consolidation into one PR (2026-08-12)

Fourteen open PRs (#92–#98, #100–#106) were closed and their branches deleted
on both the fork and locally. This session rebuilt that work as a single branch.

## Closed PRs are recoverable after branch deletion

Deleting a PR's head branch does **not** destroy the commits. GitHub keeps them
at `refs/pull/<N>/head` on the **upstream** repo, fetchable long after the
branch is gone:

```
git fetch origin refs/pull/104/head:pr/104
```

Every one of the 14 resolved to the same SHA the deleted branch had. If work
looks lost after a branch cleanup, check here before rewriting anything.

## 🔴 Migration number collision would have hard-failed boot

`023_match_join_code.js` (from the closed PR #106) collided with
`023_add_group_schedule.js`, which shipped to main while that PR sat open.
`migrate.js` explicitly rejects this — `Duplicate migration version 23` — and a
failed migration aborts the process, so the app would not have started at all.

Renumbered to `025_` (main already had `024_`). This is *not* the "never
renumber a migration" rule biting: that rule protects **shipped** migrations,
and this one had never merged. Any long-lived branch carrying a migration needs
its number re-checked against main before merge — the collision is invisible
until boot.

## Consolidating deletes silently orphans entry points

Issue #68 moves the admin block off Profile into `/admin`. While that PR was
open, PR #109 added a super-admin "Manage matches" button *to the block being
deleted*. Cherry-picking the deletion took the button with it: the
`/admin/matches` route still existed and still worked, but nothing in the UI
linked to it any more, and neither typecheck nor build nor tests can see that —
an unreachable route is valid code.

Re-added as a panel card under the same `is_super_admin` gate. When a refactor
*moves* a container, diff what landed in the old container while the branch was
open; a clean cherry-pick is not evidence that nothing was lost.

## Duplicate implementations of one issue

#93 and #104 both implemented issue #63 (challenges off Compete) — two agents,
near-identical results. Took #93: it also updated the Stats.tsx comment that
still claimed challenges lived in Compete (VALUES 0.4). Dropped #104 entirely
rather than merging both, which would have collided on every file.

## Correction: bun IS on PATH here

`2026-08-06-quick-issue-sweep.md` says this machine has no `bun`/`node` and that
only CI can verify. No longer true — bun 1.3.14 and both `node_modules` trees
exist, and `bun run check` runs locally.

Remaining gotcha: `bun install` in `client/` can fail `EPERM
NtSetInformationFile` while the dev server holds `node_modules`. Don't kill it —
if deps are unchanged versus main, the branch's `bun.lock` is already correct.

## 🔴 Removing Goals orphans the goal achievements and badges

`Stats.tsx` held the **only** caller of `POST /goals/complete` (see it on
`origin/main`). Issue #83 removes that tab, so nothing can reach the endpoint
any more — and `achievements.js` awards `first_goal_complete`, `goals_10` and
the whole `goal_streak` counter chain *exclusively* from that path. Those, plus
the `goal_getter` badge, are now permanently unearnable.

Issue #84 makes it sharper: it adds a **new** badge `on_target`, requirement
`{ type: 'achievement', achievementId: 'first_goal_complete' }` — unearnable on
the day it ships. The two issues contradict each other and both are in the same
PR. Left for the owner to decide: does "Remove Goals" mean delete the feature
(then the goal achievements/badges go too, and #17/#74 need rethinking), or
just move it off Stats? Do not resolve this by quietly deleting badges.

## A requirement type with no evaluator

`challenge_champion` declares `requirement: { type: 'challenges_won', count: 3 }`,
but `achievements.js` only handles `type === 'achievement'` and
`type === 'ranking'`. Nothing evaluates `challenges_won`, so the badge has never
been earnable. Pre-existing on main, not introduced here.

Worth knowing generally: badge requirements are **declarative data**, so a typo
or an unhandled type fails silently — no import error, no failing test, nothing
in typecheck. When touching `data/badges.js`, check that every `achievementId`
exists in `data/achievements.js` and that the `type` has a branch in
`achievements.js`.

## Label claims still unavailable

`gh issue edit --add-label` 403s for `nhaiderhtl` (no push rights). Claims are
comment-only. AGENTS.md calls the label claim best-effort, so this is within
protocol — but it means a claim is invisible to anyone filtering by label.
