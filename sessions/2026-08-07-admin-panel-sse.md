---
topics: [issue-54, issue-68, sse, live-data, admin-panel, polling-removal]
---

## Session 2026-08-07: SSE live data + admin panel

### Issue #54 — SSE replaces polling (PR #100)

- SSE branch: `feat/live-data-sse-54`, PR #100
- See session file `2026-08-07-sse-live-data.md` for full details

### Issue #68 — Admin panel at /admin (PR #101)

Admin features were embedded in Profile.tsx (`AdminCard`, `AdminActions`).
Moved them to a standalone page at `/admin`.

- `AdminPanel.tsx`: user search + actions (reset password, promote/demote), link card to `/admin/coffees`
- Profile.tsx: AdminCard/AdminActions removed; replaced by a single `profile-link-card` (shield icon) → `/admin`
- `shield` icon used (no `settings` icon in the Icon registry)
- AGENTS.md: added rule "Consult the user before placing any new admin feature"

### Badge overhaul (#84) — no action needed

Investigated: all badge requirements map to real achievements except
`challenge_champion` (type: `challenges_won`) — but `checkAfterChallengeWin`
in achievements.js handles that badge directly, bypassing the requirement
type. Badges ARE working; issue description "most of them aren't possible"
appears overstated. Left for user to clarify.

### Issue #36 (private matches) — skipped

Would need an invite/request mechanism to be useful. Without that, private
matches are inaccessible. Left for design discussion.
