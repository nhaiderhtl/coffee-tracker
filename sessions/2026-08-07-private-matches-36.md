---
topics: [issue-36-private-matches, join-codes, migration-025, match-view-payload]
---

# 2026-08-07 — Private matches with join codes (#36)

## What was done
Issue #36: custom created matches private per default.

## Implementation
- Migration 025 (written as 023, renumbered on consolidation — 023/024 shipped
  to main meanwhile): `ALTER TABLE matches ADD COLUMN join_code TEXT`
- Global user-created matches generate a 6-char join code at creation
- `GET /competitions` filters private matches from non-creators
- `POST /competitions/:id/join` requires code for private matches
- `POST /competitions/join-by-code` new endpoint: join by code
- `matchPayload`: join_code only visible to creator
- `NewMatchForm`: shows code + copy button after creation
- `MatchList` (global): "Join by code" button + inline form
- Tests updated: 2 replaced + 2 new = 297 total

## PR
#106: https://github.com/JakobHuemer/coffee-tracker/pull/106
