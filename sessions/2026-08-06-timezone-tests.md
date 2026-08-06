---
topics: [issue-16-testing, time-js-tests, timezone-dst, users-timezone-not-null]
---

# Direct tests for time.js (#16, phase 1)

`server/src/time.js` is the single instant↔civil boundary for the whole app and
had **no direct test** before this. The only tz assertions anywhere were
incidental, inside `competitions.test.js` (`dailyWindow`/`weeklyWindow`).

## `users.timezone` cannot be null

Migration 008 added it as `TEXT NOT NULL DEFAULT 'UTC'`, so `getUserTz`'s
`row && isValidTz(...)` null branch is **unreachable through the schema** — an
INSERT of null throws first. Found by writing the test and watching it fail.
Kept as belt-and-braces and pinned with a test that asserts the constraint
itself (`PRAGMA table_info`), so the guard doesn't read as dead code and the
test fails loudly if a migration ever drops NOT NULL.

## DST dates used (verified by running, not recalled)

EU transitions 2026: **2026-03-29** (23h day) and **2026-10-25** (25h day).
US transitions 2026: **2026-03-08** (23h) and **2026-11-01** (25h).
`localDayBounds` duration is the cheapest way to assert a transition without
hardcoding offsets.

## Zone shapes worth keeping in any tz test

Whole-hour+DST (`Europe/Vienna`, `America/New_York`), half-hour no-DST
(`Asia/Kolkata` +5:30), quarter-hour (`Asia/Kathmandu` +5:45), extremes
(`Pacific/Kiritimati` +14, `Pacific/Niue` −11), and **southern-hemisphere DST**
(`Australia/Sydney`, which is +11 in January and +10 in July — the inverse of
Vienna, so "is it summer" is never a substitute for asking the tz database).

Fixed instants only — never `Date.now()` — or the suite asserts something
different in July than in January.

## Still open on #16

Client has **zero** test infrastructure (no runner, no jsdom/happy-dom, no
testing-library, no `test` script). No E2E. Server gaps: `routes/auth.js`
register/login/JWT, `feed.js`, `goals.js`, `streaks.js`, `challenges.js`,
`compare.js`, `badges.js`, `achievements.js`, `casualties.js`, and `index.js`
entirely (the `/uploads/:filename` auth gate lives there, so no route test can
currently reach it).
