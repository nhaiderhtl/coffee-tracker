---
topics: [match-invalidation, migration-024, elo-replay, match-view-extract, match-recomputed-notification, admin-matches-page]
---

# Admin match invalidation (INVALIDATE_MATCH_PLAN)

Super-admin invalidates a settled match; every settled match after it (settle
order `(settled_at, id)`) is replayed so ratings stay zero-sum. Cap: ≤3 settled
matches may follow the target.

## Non-obvious findings

- **Partial replay is correct without re-running pre-target history** (unlike
  migration 015 which replays ALL settled matches). `invalidateMatch` replays
  only `[target, ...after]`, lazily seeding each player's entering rating from
  the STORED `rating_before` of their FIRST window match — valid because nothing
  before the window changed. This is what lets it use the CURRENT
  `settleFfa`/`marginScaleFor` instead of frozen settle-v1: every window match
  was already settled under v2. Re-running v1-era matches through v2 (what 015
  guards against) never happens because they're all before the target.
- **user_ratings rebuild is per-touched-user, not wholesale.** 015 does
  `DELETE FROM user_ratings` + reinsert; that would wrongly drop users whose last
  match predates the window. Here: upsert only users in the replay `cache`, with
  `matches` recounted live (`state='settled'` COUNT) so the now-`invalidated`
  target drops out of everyone's count automatically.
- **bun:sqlite named params `@s` did NOT bind** via `.all({s,id})` — the query
  silently returned 0 rows (tests caught it as `matches_recomputed: 0`). Use
  positional `?`.
- **`matches.state` has no CHECK constraint** (free text), so `'invalidated'`
  needs no schema change — migration 024 only adds `recomputed_at` /
  `recompute_reason`.
- Extracted `matchPayload`/`participantsOf` into `server/src/match-view.js` so
  routes/admin.js reuses them (was route-local in routes/competitions.js). Also
  changed the "finished" check there from `state==='settled'` to
  `settled || invalidated` so an invalidated match reads its stored ledger, not
  the live-score path.

## Deviation from approved copy

Info-marker copy draft said "recalculated after **<invalidated match title>**",
but `matchPayload` (and the recomputed row) doesn't carry the invalidated match's
title — `recompute_reason` is the generic "a match was invalidated". Marker shows
"This match's rating was recalculated after a match was invalidated." The TOAST
does carry `invalidated_title` (in the notification payload) so it keeps the
titled copy. Flagged to user.

## Client

- New admin page `/admin/matches` (super-admin only), reuses exported `MatchCard`
  from Compete.tsx. Nav button in Profile AdminCard, gated `is_super_admin`.
- `match_recomputed` notification: toast + Notifications list; `highlight()` in
  catalog.tsx renders `**bold**` spans.
