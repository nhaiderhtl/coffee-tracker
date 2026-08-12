# Notification System (issue #32, phase 1)

In-app notification system. Server records events to a `notifications` table
and pushes an invalidation over SSE; the client shows an unread count on a bell
in `AppHeader` and lists history on a `/notifications` page.

This doc owns the **implementation**: table, migration, emit sites, API, types,
query-hook config, file paths. How notifications *behave and read* on the
client — read model, swipe, per-type presentation — lives in the side spec
[notifications-client.md](./notifications-client.md), which is authoritative for
interaction and supersedes any behavioural note here. Big `match_end` events get
a **fullscreen reveal** instead of a plain toast/card; that surface (trigger,
choreography, the generic-until-revealed model that reuses `read_at`) is specced
in [notifications-reveals.md](./notifications-reveals.md).

Sources in phase 1: `match_end`, `achievement`, `badge`.

Out of phase 1: OS/web push (no service worker, no PWA), `streak_break` (a
broken streak fires no synchronous server event — it needs a time sweep, its
own issue), replay animations.

## Core principle — immutable, self-contained events

**A notification is an immutable event with all its data embedded.** A row is
written once and never updated. Its `payload` carries everything needed to
render it — the renderer never reads back into live tables. If a fact later
changes (a match re-settles, a rating is returned), that is a **new**
notification (e.g. *"rating for match #X returned, +/−XX"*), never an edit to
the old one. The frontend decides how to display the embedded data.

This is a VALUES.md candidate: notifications are append-only, immutable, and
carry frozen copies of the facts they describe.

## Replaces existing toast / notification systems

This feature **replaces** the current ephemeral toast path. `UnlockToast` and
its per-page wiring (the `unlocked[]` arrays surfaced on coffee-log, goals,
challenge-join, compare) go away — those unlocks become persisted
`achievement` / `badge` notifications rendered through this system. Any other
toast or ad-hoc notification surface is likewise folded into this one system.
There is one notification path after this ships.

## 1. Migration — `server/src/migrations/019_add_notifications.js`

Follows the 018 convention: `exports.up = (db) => {…}`, idempotent,
`IF NOT EXISTS`. IDs are `randomUUID()`, times are `Date.now()` epoch ms.
`user_id` is TEXT (users.id is a uuid).

```sql
CREATE TABLE IF NOT EXISTS notifications (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  type        TEXT NOT NULL,          -- allowlisted server-side
  payload     TEXT NOT NULL,          -- JSON string, self-contained + immutable
  read_at     INTEGER,               -- epoch ms; NULL = unread
  created_at  INTEGER NOT NULL,      -- epoch ms
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_notifications_user   ON notifications(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(user_id, read_at);
```

`type` is a plain TEXT tag and `payload` is opaque JSON, so **a new notification
type needs no migration.**

## 2. Writer module — `server/src/notifications.js`

Single writer, requires only `./db` (no dependency cycle):

```js
// createNotification(userId, type, payload)
//   INSERT id=randomUUID(), user_id, type, payload=JSON.stringify(payload),
//          read_at=NULL, created_at=Date.now()
module.exports = { createNotification, TYPES };
```

`TYPES` is the server-side allowlist of known type strings, so a typo cannot
write an unrenderable row. `payload` is stringified on write, parsed on read.
**Nothing recomputes on read.**

### Payloads (embedded + frozen — everything needed to render, no fetch)

| type          | payload |
|---------------|---------|
| `achievement` | `{ id, name, icon, description }` |
| `badge`       | `{ id, name, icon, description }` |
| `match_end`   | `{ match_id, title, group_id, group_name, mode, period_key, scope_start, scope_end, rank, participant_count, score, rating_before, rating_after, delta }` |

`match_end` field sources (verified against the live schema):
`title`, `mode`, `period_key`, `scope_start`, `scope_end` from `matches`;
`group_name` from `competition_groups.name` (null for a global match);
`score`, `rating_before`, `rating_after`, `delta` from the caller's
`match_participants` row; `rank` / `participant_count` derived at settle time.
`match_participants.side` and `contribution_share` are **deliberately omitted**
— v2 dropped team mode and leaves them null. The opponent roster (other
players' names) is also omitted by design: a per-user result row, not a full
scoreboard.

Every payload embeds all display data (ids **and** names). This is forced by
the immutability principle: the renderer never reads back into live tables, so
anything shown must live in the row. Ids stay in the payload too as canonical
references (linking, dedup), but they are never the *only* copy of a name.

## 3. Emit sites (synchronous — no new scheduler)

**Unlocks** — in `achievements.js`, right after the successful `INSERT` inside
`unlockAchievement` and `unlockBadge` (the only two unlock write points → every
caller covered: coffee-log, goals, challenge, ranking-badge). Both already
`return null` on a duplicate before inserting, so a re-check emits nothing.
`achievements.js` gains `require('./notifications')`.

**match_end** — inside the `db.transaction` in `settleMatch()`
(`server/src/competitions.js`), in the existing `for (const r of results)`
loop, **one row per participant** (winners, losers, and away users alike).
Build a `Map<userId, rank>` once before the loop by sorting participants by
`score` desc (roster order is already total via `joined_at, user_id`). All
payload fields are in scope. Rows commit atomically with the settlement.

## 4. Text lives in the frontend, keyed by type

The backend **never** writes a sentence. All copy and layout live in a frontend
render catalog keyed by `type`, so wording/layout is a one-place edit that
applies to every row, past and present, because text is never stored. A default
renderer for unknown types is **required** so a server type shipped ahead of
the frontend still renders.

The catalog's output shape and the per-type presentation (data-forward layout,
copy rules, colour tokens, the default renderer's contents) are specified in
[notifications-client.md](./notifications-client.md#presentation--data-forward-per-type).

## 5. API — `server/src/routes/notifications.js`

Convention per `routes/streaks.js` (`express.Router()`, `requireAuth`,
`req.user.id`, `module.exports = router`). Register in `index.js` after the
competitions line:

```js
app.use('/api/notifications', require('./routes/notifications'));
```

Every query is filtered by `req.user.id`; no cross-user reads.

### `GET /api/notifications?unread=1&limit=&before=`
- `limit` default 30, cap 100. `before` = `created_at` keyset cursor
  (newest-first). `unread=1` → only `read_at IS NULL`.
- Response: `{ notifications: [{ id, type, payload, read_at, created_at }],
  unread_count }`. `payload` parsed to an object; `unread_count` is the user's
  total unread, independent of paging/filter.

### `POST /api/notifications/read`
- Body `{ ids: string[] }` or `{ all: true }`.
- `UPDATE notifications SET read_at = Date.now()
   WHERE user_id = ? AND read_at IS NULL AND (id IN (…) | <all>)`.
- Response `{ ok: true, unread_count }`.

## 6. Client

- **types/index.ts** — add (`Notification` is a DOM global, so `AppNotification`):
  ```ts
  export type NotificationType = 'match_end' | 'achievement' | 'badge';
  export interface AppNotification {
    id: string; type: NotificationType | string;
    payload: unknown; read_at: number | null; created_at: number;
  }
  export interface NotificationsResponse {
    notifications: AppNotification[]; unread_count: number;
  }
  ```
- **Query hook** — `useQuery(['notifications'], …, { refetchInterval: 60_000,
  refetchOnWindowFocus: true })`.
- **Bell** — control in `AppHeader`'s `header-actions`, unread badge when
  `unread_count > 0`, opens `/notifications`. `AppHeader` renders on all main
  pages, so the bell is global with no per-page wiring.
- **Page** — `client/src/pages/Notifications.tsx`, route `/notifications` under
  `RequireAuth`. Renders each row through the catalog, falling back to the
  default renderer for unknown types.

The read model (no auto-read on open), the swipe-to-read and "mark all read"
interactions, and the per-type presentation are specified in
[notifications-client.md](./notifications-client.md).

## 7. Delivery is a push, not a poll (#54 landed)

The 60s poll this section used to describe is gone. `createNotification`
broadcasts `['notifications']` to the recipient, so the bell updates on the
server event rather than on an interval, and `useNotifications` carries no
`refetchInterval`.

Two consequences worth knowing before changing anything here:

- A notification that is written **without** going through `createNotification`
  will not reach the bell until the next refetch. Emit through it.
- The connection, its reconnect behaviour and the rule that every mutating
  endpoint must broadcast are specced in
  [live-data-sse.md](./live-data-sse.md). The bell is one consumer of that
  system, not a mechanism of its own.

## 8. Retention

The competitions ticker's `tick()` (already running) gains one statement:

```sql
DELETE FROM notifications WHERE read_at IS NOT NULL AND read_at < ?;  -- now − 90 days
```

Bounded growth; an unread notification is never deleted.

## 9. Tests

- `server/src/routes.notifications.test.js` (HTTP, mounts the router like the
  other `routes.*.test.js`): auth required; list scoped to caller (A cannot see
  B); `unread=1` filter; `read` marks rows and drops `unread_count`;
  `limit`/`before` paging.
- Module tests: `settleMatch` writes one row per participant with correct
  `rank`; a second identical unlock writes no row.

## Non-negotiables honored

Numbered migration (019), single container / same-origin, no CORS, Bun, no new
external dependencies (react-query and the ticker both already exist).
