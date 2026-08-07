---
topics: [sse, live-data, events, issue-54, polling-removal]
---

## SSE implementation (issue #54)

- `server/src/events.js`: SSE registry — tracks connected `Response` objects keyed by `userId`. Heartbeat every 25s to survive proxy idle timeouts.
- `server/src/middleware/auth.js`: added `requireAuthSSE` that accepts `?token=` query param (EventSource can't set headers).
- `/api/events` mounted before other routes; used `requireAuthSSE` → `sseHandler`.
- Events sent as `event: invalidate\ndata: {"keys":[...]}` — client calls `invalidateQueries` per key.

## Where broadcasts are fired

- `notifications.js` → `createNotification` broadcasts `['notifications']` to the target user.
- `routes/coffees.js` POST /entries → broadcasts `['feed']` to all, then `['streaks','energy','stats','rankings']` to the author.
- `competitions.js` `settleMatch` → broadcasts `['competitions','rankings']` to all participants (after the transaction).

## Polling removed

Removed `refetchInterval` from queries now covered by SSE:
- `['competitions']` and `['competitions','history']` in Compete.tsx
- `['rankings',period]` in Stats.tsx
- `['stats']` in Stats.tsx
- `['energy',hours]` in BuzzWidget.tsx
- `['notifications']` in useNotifications.ts (was the explicit swap point)

Kept polling on `['goals']`, `['casualties']`, `['challenges']` — no SSE events cover those.

## No circular deps

`events.js` imports nothing from the app; all traffic flows inward. Tests unaffected — `broadcast` is a no-op when `clients` map is empty.
