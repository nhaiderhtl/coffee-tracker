# Live data over SSE (issue #54)

The app does **not poll**. Every screen that shows shared state is kept current
by a server push over Server-Sent Events. There is no `refetchInterval` anywhere
in the client, and adding one back is the wrong fix for a stale screen — the
right fix is the missing push.

## The contract

The server never sends data. It sends **invalidation signals**: which React
Query keys are now stale. The client re-asks through the normal endpoints, so
every visibility rule stays where it already lives, in the GET handlers.

```
event: invalidate
data: {"keys":[["feed"],["rankings"]]}
```

That is the whole protocol. Because the event carries no payload, an untargeted
broadcast leaks nothing: a client told that `competitions` is stale still only
receives the matches it is allowed to see when it refetches.

## Pieces

| File | Role |
| --- | --- |
| `server/src/events.js` | Connection registry, `broadcast()`, the `GET /api/events` handler |
| `server/src/middleware/auth.js` | `requireAuthSSE` — EventSource cannot set headers, so the token arrives as a query param |
| `client/src/hooks/useSSE.ts` | One connection per session, mounted once in `App` |

Connections are tracked per user id, so a push can be aimed at one person
(`['streaks']` after their own coffee) or at everyone (`['feed']`).

## Rules for adding a push

**Every endpoint that mutates state must broadcast.** A write with no push is a
screen that silently lies until someone reloads — and since nothing polls, it
lies indefinitely. This is the single rule to remember from this document.

1. **Push after the write, before `res.json()`.** The response gives the actor
   their own new state; the broadcast gives it to everyone else.
2. **Skip the actor with `except`.** Their UI already applied the change
   optimistically (`broadcast(keys, undefined, { except: req.user.id })`).
   Without it, liking a post refetches the list under the user's own finger.
3. **Target when the audience is known and narrow** (`[userId]` for a private
   change like a bookmark); broadcast untargeted when visibility is decided by
   the GET handler. Do not try to recompute an audience here — that logic would
   be a second copy of the read rules, free to drift.
4. **Key by prefix.** React Query matches prefixes, so `['feed']` invalidates
   `['feed','saved']`, `['feed','mine']` and `['feed','hall-of-fame']`. A new
   feed-like list belongs under the `feed` prefix rather than at top level, or
   the existing pushes will miss it.
5. **Every key you broadcast must exist as a client query key.** A typo is
   silently inert — nothing errors, the screen just never updates.

Unlocks are the exception to rule 1, and deliberately so: `unlockAchievement`
and `unlockBadge` push `['badges']`/`['achievements']` themselves. Every unlock
in the app routes through those two, so no call site has to remember.

Scheduler-driven changes push from `tick()` in `server/src/competitions.js` —
lobbies opening on schedule and lobbies locking answer no request, so they are
the easiest pushes to forget.

## Reconnect is a refetch, not a replay

SSE has no replay and this app has no polling fallback, so anything that
happened while the stream was down would otherwise be lost for good.

`useSSE` therefore invalidates the **entire** cache on every `open`, including
each automatic reconnect. The client cannot know what it missed, so it re-asks.
React Query only refetches queries that are actually mounted, so the cost is one
round of the visible screen — and this is precisely what makes it safe to have
removed the polling.

Do not "optimise" this into invalidating a subset. The set of things that could
have changed during a gap is everything.

## Testing a push by hand

```bash
# terminal 1 — listen as one user
curl -sN "http://127.0.0.1:3001/api/events?token=$TOKEN_B"
# terminal 2 — act as another, then watch what arrives
curl -s -X POST http://127.0.0.1:3001/api/coffees/entries \
  -H "Authorization: Bearer $TOKEN_A" -F coffeeId=espresso -F is_public=1 -F description=hi
```

A push you expect and do not see is a missing `broadcast`, a key the client
never uses, or an `except` that swallowed it.
