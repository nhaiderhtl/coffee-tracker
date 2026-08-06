---
topics: [issue-16-testing, auth-routes, rate-limiter-tests, bun-sqlite-get-null, json-nan]
---

# routes/auth.js tests (#16, phase 3)

The app's front door — register, login, JWT issuance, password rotation,
account deletion — had no test of its own. What existed touched only
`PATCH /me/photo` (`routes.images.test.js`) and the auto-join prefs
(`routes.competitions.test.js`).

## The rate limiter is shared module state — budget for it

`authLimiter` is 30 requests / 15 min / IP, created at **module scope** in
`routes/auth.js`. Every test request comes from 127.0.0.1, so the budget is
shared by every register/login call in the file. Blow past it and later tests
start failing with 429 for no visible reason.

Two consequences, both applied here:

- Seed users with a direct `INSERT` (`seedUser`) instead of `POST /register`
  wherever the test isn't about registering. Costs no budget and skips bcrypt.
- The limiter's **own** test gets a fresh instance by busting the require cache
  (`delete require.cache[require.resolve('./routes/auth')]`) and mounting a
  second app, rather than spending the shared 30. It restores the cache
  afterwards.

Also: an unknown username short-circuits before `bcrypt.compareSync`, so 30
failed logins against a nonexistent user run in milliseconds. Use that, not a
real user, when you need volume.

## Two "bugs" that were not bugs

**`bun:sqlite`'s `.get()` returns `null`, not `undefined`,** when nothing
matches. `toBeUndefined()` on a deleted-row check fails. Use `toBeNull()`.

**`NaN` cannot reach the server.** JSON has no NaN literal, so
`JSON.stringify({ v: NaN })` emits `{"v":null}` — a `caffeine_half_life_h: NaN`
PATCH arrives as `null` and correctly *clears* the field (200, not 400). The
`Number.isFinite` half of the handler's guard is therefore unreachable over
HTTP and only defends direct in-process callers. Pinned with its own test so
nobody "fixes" the 200 later.

## Worth keeping covered

- Wrong password and unknown user return the **same** message — a different one
  would confirm which usernames exist.
- `alg: none` and wrong-secret tokens are rejected (requireAuth pins HS256).
- A valid token whose user was deleted is **401, not 404** — a dead session, so
  the client logs out instead of retrying.
- `PATCH /me` validates auto-join early but writes it last: a request that
  later 409s on a taken username must not leave the user opted into every daily
  match. There is a test for exactly that ordering.
- Password rotation requires `currentPassword` even with a valid JWT, so a
  stolen token cannot lock the owner out.
