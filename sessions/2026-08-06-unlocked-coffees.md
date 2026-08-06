---
topics: [issue-85-unlocked-coffees, coffee-menu-tried-state, no-local-bun]
---

# Show unlocked coffees (#85)

Split out of `2026-08-06-quick-issue-sweep.md` (same session) so the two PRs
touching `sessions/` could merge independently instead of conflicting on one
filename.

## No new endpoint was needed

`GET /api/coffees/stats` already returns `by_type`, **keyed by `coffee_id`** with
a per-drink count — so "have I tried this?" is `by_type[coffee.id] > 0` on the
client. Nothing server-side changed. `LogCoffee` already invalidates the `stats`
query on submit (alongside `feed`/`badges`/…), so the menu's tried state
refreshes itself after a log with no extra wiring.

## Why untried drinks are the *plain* ones

Deliberate inversion of the obvious: tried drinks get the green
`--success-bg`/`--success-bd` tint, untried keep the normal `--surface2`. The
question the feature answers is "which are LEFT" (unique-type achievements), so
dimming the untried ones would push exactly the wrong set into the background
and make them read as disabled.

## CSS ordering trap

`.coffee-btn.tried`, `.coffee-btn.selected` and `.coffee-btn:hover` all have
equal specificity (0,2,0), so **source order alone** decides the winner.
`.tried` is declared first on purpose — move it below `.selected` and a
previously-tried drink stops showing any selection feedback when tapped.

## Environment

No `bun`/`node` on PATH and no `node_modules` on this machine — `bun run check`
cannot run locally; CI on the PR is the verification. See the sweep file for the
fork-based PR workflow (no push rights on the upstream repo).
