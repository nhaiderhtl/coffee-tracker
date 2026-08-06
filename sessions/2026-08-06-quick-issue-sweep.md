---
topics: [issue-79-clickable-logo, issue-63-challenges-off-compete, issue-36-private-matches, no-local-bun, fork-based-prs]
---

# Quick issue sweep (2026-08-06)

## Environment gotcha: no local JS runtime

This machine has **no `bun` and no `node` on PATH**, and neither `client/` nor
`server/` has `node_modules`. `bun run test` / `lint` / `build` cannot be run
locally here. Verification came from **CI on the PR**
(`.github/workflows/pr-checks.yaml`) plus manual grepping that every referenced
symbol/token resolves (VALUES.md rule 0). Push early and read the CI run rather
than assuming a green local.

## Contributing without write access

Neither `nico-haider` nor `nhaiderhtl` has push rights on
`JakobHuemer/coffee-tracker` (`permissions.push: false`), and
`gh issue edit --add-label` 403s for the same reason — so the claim protocol's
label step is simply unavailable. PRs go through a fork:
`nhaiderhtl/coffee-tracker`, remote `fork`, `--head nhaiderhtl:<branch>`.
Note `gh repo fork` adds the remote as **SSH**, but SSH auth fails here
(`Permission denied (publickey)`); reset it to HTTPS and let
`gh auth setup-git` supply credentials.

## #79 clickable logo

Header brand is a `<Link to="/">`, not an `onClick`, so middle-click and
open-in-new-tab work. Hover feedback is opacity — a scale pop is banned by the
AGENTS.md guardrail.

## #63 challenges off Compete

Challenges bounced: Stats tab → Compete/Global (#51) → their own `/challenges`
page (#63). The `.ch-*` CSS is all top-level (not scoped under `.cmp-body`), so
the markup moved to a standalone page unchanged.

Route ordering note: `/compete/global/challenges` (static) out-ranks
`/compete/:scope/:section` (dynamic) in React Router v6 regardless of
declaration order, so the back-compat redirect works where it sits.
