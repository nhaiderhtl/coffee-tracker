---
topics: [issue-79-clickable-logo, issue-63-challenges-off-compete, issue-36-private-matches, no-local-bun]
---

# Quick issue sweep (2026-08-06)

## Environment gotcha: no local JS runtime

This machine has **no `bun` and no `node` on PATH**, and neither `client/` nor
`server/` has `node_modules`. `bun run test` / `lint` / `build` cannot be run
locally here. Verification for this session's changes came from **CI on the PR**
(`.github/workflows/pr-checks.yaml`) plus manual grepping that every referenced
symbol/token resolves (VALUES.md rule 0). If you land on this machine, expect
the same — push early and read the CI run rather than assuming a green local.

## Repo permissions

`gh issue edit --add-label` fails for this account
(`nico-haider does not have the correct permissions to execute AddLabelsToLabelable`).
The claim protocol's label step is therefore not available; claiming was done
with `gh issue comment` only.

## #79 clickable logo

The header brand is now a `<Link to="/">` rather than an `onClick` handler, so
middle-click / open-in-new-tab work. Hover feedback is opacity — a scale pop is
explicitly banned by the AGENTS.md guardrail.
