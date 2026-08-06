---
topics: [issue-45-puns, empty-state-copy, no-local-bun]
---

# Coffee puns in empty states (#45)

Own file (not the shared `2026-08-06-quick-issue-sweep.md`) so the session's
PRs could merge independently instead of colliding on one filename.

## What was deliberately left alone

The issue says "every line like *Nothing settled yet.*" — that class is
**empty states**, not all copy. Left factual on purpose:

- **Instructional sub-copy** under an empty title ("Tap the bookmark on any post
  to save it here"). The title carries the joke; the line telling you what to do
  has to stay plain or the empty state stops teaching.
- **Status, not emptiness** — "You are not in a group.", "Competitions run
  inside a group. Join one to play."
- **`AdminCoffees.tsx`** — internal tooling, nobody needs a pun while editing
  the catalog.
- **`Milestones.tsx`** "No milestones yet — keep brewing." was already a pun.

## Merge-conflict avoidance

`Compete.tsx`'s "No community challenges right now." was **not** punned even
though it qualifies: PR for #63 deletes that whole block out of `Compete.tsx`
into a new `Challenges.tsx`. Touching the same line here would have guaranteed
a conflict between two open PRs. Re-pun it there once #63 lands.

## Apostrophes

Use the typographic `’`, not `'`, in JSX **text** — oxlint's unescaped-entities
rule flags the straight quote, and the rest of the app's copy already uses `’`
("don’t", "haven’t"). Applies inside double-quoted JSX attributes too, purely
for consistency.

## Environment

No `bun`/`node` on PATH here, so `bun run check` could not be run — see the
sweep file. Copy-only change, so the risk is confined to lint.
