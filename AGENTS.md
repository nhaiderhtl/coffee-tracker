# Coffee Tracker — Agent Guide

Read this before changing anything. See [VALUES.md](./VALUES.md) for the
project's core values (priority-ordered). This file covers architecture,
workflows, and guardrails.

## No assigned issue? Start at the tracking issue

If the prompter assigned you a specific issue, work that and skip this section.

Otherwise — if you were asked to "do some issues" / "pick up work" with **no
issue assigned** — do **not** eyeball the issue list and guess. Fetch the
master tracking issue **#99** ("Backlog tracking & ordering"):

```
gh issue view 99
```

It holds the ordered backlog — the sequence to work issues in, at finer
resolution than the four `priority:` buckets allow. Take the next unclaimed
item from its ordered list, then follow the [claim protocol](#claim-protocol-so-parallel-agents-dont-collide)
before writing any code.

**Do not edit issue #99 unless the user explicitly tells you to edit this
issue.** Absent that instruction it is read-only: read its list and act on it,
nothing more. Even when told to edit it, if you lack edit permission on the
issue description, **back off immediately** — do not attempt a workaround. No
adding comments, no label changes, no closing, no anything to route around the
missing permission.

## Prompts have no hidden meaning

Do exactly and only what the prompt says. No subtext to infer, no unstated
follow-up to complete.

**An action cannot be derived from a question.** A question carries no
instruction to write, so answering it is the whole job. If the answer exposes
a gap, name it — that is the response, not a licence to fix it. Same for
anything noticed in passing: report it, don't fix it unless told to.

Write only on an explicit write verb — "add", "update", "fix", "put it in",
"commit". "Why", "what", "does", "how", "when" are not.

If the expected action is unclear, stop and make the user state it before
doing anything. Never guess, and never pick the more ambitious reading.

## Answering questions is not permission to start

Making a plan, asking clarifying questions, then immediately starting is an
**anti-pattern and not allowed.** Answering a question does not change the
interaction state — planning stays planning. The user should never have to say
"don't implement yet" after answering; that is the default.

When in planning and the plan changes (including because a clarification changed
it), present the **new brief plan** and stop. Do not begin work until the user
explicitly says to start.

You cannot circumvent this by ending on a "Start now?" question — a question
modifies the plan, and the user cannot confirm an unfinished plan through it.
Approval to build is a separate, explicit "start" from the user, given against a
plan that is already complete.

## Never remove one thing to achieve another

Do not delete, disable, or gut an existing feature as a means of reaching some
other goal. Fixing bug B is not a licence to remove working feature A. If the
only way you can see to get B is to sacrifice A, **you have hit a wall — stop and
say so.** Present the trade-off and let the user decide. Pushing back on a
crazy-looking demand is the job, not a failure to complete it.

- "Achieve X at all cost" is never the instruction, even when the user is
  clearly frustrated and pushing hard for X. Cost includes their existing work.
- A user saying "be ready to revert this later if we don't like it" is telling
  you the feature is on probation, decided **later, by them** — it is not
  pre-authorisation for you to remove it the moment it's inconvenient.
- Removing a feature the user added earlier in the same session is a red flag by
  default. It needs an explicit, current instruction to remove *that thing* —
  not merely a goal that would be easier without it.
- When two wants genuinely conflict (feature A vs fix B), the answer is to
  surface the conflict, not to silently pick a winner. See "Surface blockers"
  in the memory guidance: conflicts go to the user before acting.

The bar is not "did the user technically allow it" — it is "did the user ask for
*this removal*, right now, knowing what it costs." If not, don't.

## Architecture at a glance

- `server/` — Bun + Express API. `src/index.js` (boot: config check → migrate →
  routes → static frontend → graceful shutdown), `src/db.js` (open + pragmas),
  `src/migrate.js` + `src/migrations/`, `src/routes/*`, `src/data/*` (static
  seed data, read-only).
- `client/` — React 19 + Vite + TS. Built into the image, not deployed
  separately. `base: '/'`.
- DB persists on a named volume at `DB_DIR` (default `/app/data`).
- TLS is out of scope here — a reverse proxy in front terminates it.

<details>
<summary>Route surface (all under <code>/api</code>, JWT auth except register/login)</summary>

Gamification/reference data (achievements, badges, tasks) lives in
`server/src/data/*.js` (static). The **coffee catalog** and its **drink
categories** are data-driven (issue #77): coffees live in the `coffees` table
(migration 020) and categories in `coffee_classes` (migration 021), both read
through `server/src/coffees.js` (`listCoffees`, `getCoffee`, `coffeeCount`,
`listClasses`, `getClass`, and `scoreMgSql` — the last built live from the
`score_caffeine` competition override column) and edited by admins via the
`/api/admin/coffees` and `/api/admin/coffee-classes` routes. A coffee's `class`
must reference a real category (enforced in the admin routes, no SQL FK).
Endpoints:

- `auth` — `POST /register`, `POST /login`, `GET|PATCH /me`
- `coffees` — `GET /`, `GET /classes`, `GET|POST /entries`, `PATCH|DELETE /entries/:id`, `GET /stats`, `GET /dev-flags`
- `admin` — user management + catalog: `GET|POST /coffees`, `PATCH|DELETE /coffees/:id`, `GET|POST /coffee-classes`, `PATCH|DELETE /coffee-classes/:id`, `POST /coffee-classes/:id/move`
- `goals` — `GET /today`, `POST /complete`
- `achievements` `GET /` · `badges` `GET /` · `streaks` `GET /` · `rankings` `GET /` · `casualties` `GET /`
- `energy` — `GET /?hours=` (the derived Buzz score, see [docs/energy-score.md](./docs/energy-score.md))
- `challenges` — `GET /`, `POST /`, `GET /:id`, `POST /:id/join`
- `compare` — `GET /:username`
- `groups` — `GET /`, `GET /mine`, `POST /`, `POST /join`, `POST /leave`,
  `PATCH /:id`, `GET /:id` (competition groups; one per user at a time)
- `competitions` — `GET /`, `GET /leaderboard?scope=global|group`, `GET /history`,
  `POST /`, `POST /:id/join`, `POST /:id/leave`, `GET /:id`
  (see [docs/competitions-rating-v2.md](./docs/competitions-rating-v2.md); the
  superseded [docs/competitions-elo.md](./docs/competitions-elo.md) still
  describes how every match settled before v2 was scored)

Outside `/api/<area>` there is one more endpoint: **`GET /api/events`**, the SSE
stream every client holds open. It carries no data, only cache-invalidation
signals — see [docs/live-data-sse.md](./docs/live-data-sse.md).

Client pages in `client/src/pages/*` map 1:1 to these areas.
Test suites: `server/src/*.test.js` and `client/src/**/*.test.ts(x)`, run with
`bun run test` and `bun run test:client`. Server tests come in two kinds:
module tests that call the code directly, and `routes.*.test.js`, which mounts
a router on a real server and drives it over HTTP to cover validation and
access control.
</details>

## Commands

```bash
# Local dev (two processes)
cd server && bun install && bun --watch src/index.js     # API on :3001
# Add DEV_OVERRIDES=1 to that command to enable the debug toggles on the
# Profile page (currently: bypass the 5-minute coffee spacing rule).
cd client && bun install && bun run dev                  # Vite on :5173 (proxies /api)

# Production (single container)
cp .env.example .env            # set JWT_SECRET (>= 16 chars), optional PORT
docker compose up -d --build    # serves / and /api on http://localhost:${PORT:-8080}

# Tests and checks — from the repo root
bun run test            # server suite (unit + HTTP route tests)
bun run test:watch      # same, re-running on change
bun run test:client     # client suite (bun test + happy-dom, see client/bunfig.toml)
bun run typecheck:test  # type-checks the test files (tsconfig.test.json)
bun run lint            # client (oxlint)
bun run build           # client (tsc -b + vite build)
bun run check           # all of the above, mirroring .github/workflows/pr-checks.yaml

# The same scripts exist in server/ and client/ if you are already there
cd server && bun run test
```

`bun install` inside `client/` can fail on Windows with
`EPERM … NtSetInformationFile` while a dev server holds `node_modules`. Do not
kill that server — if the dependencies in `package.json` have not changed, the
existing `bun.lock` is already correct and needs no regeneration.

## Session log

Every session **must** maintain one file in `sessions/` — one file per session,
e.g. `sessions/YYYY-MM-DD-<short-slug>.md`. Hard cap: **100 lines, never
exceed.** If you approach the limit, tighten existing lines; don't spill.

What goes in it: only high-value context **not recorded anywhere else** — bug
catches, gotchas, non-obvious findings, dead ends, decisions that will help a
future agent. Not a diary. Skip anything derivable from code, git history, or
other docs. Underuse over overuse — most lines are noise; keep the signal.

Each file starts with frontmatter listing the **topics** it covers. A session
usually spans many topics, so this is the index: a new agent reads only the
frontmatter across `sessions/*.md` to decide which file is relevant, instead of
guessing from filenames.

```markdown
---
topics: [theme-switch, docker-volume, jwt-expiry-bug, migration-0007]
---
```

## Discovering new core values

This core-values system was added by **JakobHuemer** to keep a fast-moving
project consistent. When a prompt leads to a big change that implies a new
standing rule — e.g. adopting a new technology in a specific way — write it
directly into `VALUES.md` in its own separate commit. Note it in one inline
sentence so the user sees it happened; don't block work or ask for an approval
loop. Never write values into AGENTS.md.

## Notification & event payloads must embed everything

A notification — and any immutable, append-only event row — is self-contained:
the renderer never reads back into live tables, so **every field the UI shows
must live in the payload**, not just ids. When building or extending such a
schema, do not be sloppy:

- **Verify against the LIVE schema, not memory.** Introspect the real tables
  (`PRAGMA table_info(<t>)`) and account for every display-relevant column. A
  match, for example, carries `title` **and** `period_key` **and** group
  linkage — and the group's name lives in `competition_groups`, not `matches`.
- **Embed names next to ids.** An id-only payload contradicts immutability (it
  forces a later fetch that may find the source renamed or deleted). Store both.
- **Omit a field only on purpose, and say why in the spec** (e.g. v2 dropped
  team mode, so `side` / `contribution_share` are intentionally left out).

A silent omission here is a data-loss bug: the fact is gone from a row that can
never be recomputed. See [docs/notifications.md](./docs/notifications.md).

## Badges travel with the profile (issues #73, #80)

A user's identity is one thing shown in many places — a feed post header, the
Compare view, a competition roster, the leaderboard, and their public profile
page. **Wherever that identity appears, their badges appear with it.** Badges
are not a profile-page-only decoration; they are part of the profile.

**A profile shows every badge its owner has earned** — there is no "featured"
subset and no picker. Unlock a badge and it shows, ordered rarest first. (The
old feature let users pick up to 3 to feature; that selection, its
`users.featured_badges` column, and its edit UI were all removed. Do not
reintroduce a "featured"/pick-N concept.)

Concretely, when you add or touch any surface that renders a user's
name/avatar:

- **Client:** render it through the compound `<Profile>` component
  (`client/src/components/Profile.tsx`) and include the `<Profile.Badges>` slot,
  or drop a `<BadgeRow badges={…} />` (`client/src/components/Badge.tsx`) beside
  the name. Both draw the one badge glyph (`BadgeChip`) so the look never drifts.
  `<Profile>` is a *compound* component: it only supplies the user via context;
  you compose the visible slots (`Profile.Avatar`, `Profile.Name`,
  `Profile.Badges`, `Profile.Meta`) in whatever layout you want.
- **Server:** the row you send that surface must carry `badges`. Build it with
  `badgesForMany` (batched — never an N+1 per row) or `publicProfileFor` from
  `server/src/profile.js`, the single source for stats + badges (all resolved
  live from `user_badges`). `routes/feed.js`, `routes/competitions.js`,
  `routes/groups.js` and `routes/compare.js` already do this — match them.
- **Clicking a user** (name or avatar) anywhere goes to their public profile at
  `/u/:username`; Compare lives *inside* that page now, not as the entry point.

Badges render as tier-coloured Discord-style discs (colour = rarity, via
`client/src/rarity.ts`); every badge has its own unique icon. A boxed
"badge card" is the old look — do not reintroduce it.

**A badge nobody can earn is a bug, and it fails silently.** Requirements in
`server/src/data/badges.js` are declarative data: only `type: 'achievement'` and
`type: 'ranking'` have evaluators (in `achievements.js`), any other type is
inert, and a mistyped `achievementId` resolves to nothing. Neither typecheck nor
the suite will say a word. When you add or edit a badge, confirm its unlock path
actually runs. If a path is removed rather than replaced — as the Goals removal
(#83) did to `goal_getter` — mark the badge `retired: true` instead of deleting
it: the collection endpoints then hide it from everyone who has not earned it,
while users who did keep seeing it. Deleting the definition strips a badge from
people who already hold one.

**Info popover is the profile pages' alone.** Both profile pages (public
`/u/:username` and your own) pass `withInfo` to `<Profile.Badges>`/`<BadgeRow>`,
which makes each chip pop a name/rarity/description tooltip on hover (mouse,
300ms) or tap. Inline surfaces (posts, match rosters, leaderboard) render chips
display-only — do not turn `withInfo` on there.

**Secret badges leak nothing about how to get them.** A secret badge shows its
name + icon wherever its owner's profile appears (so you can see they earned it),
but its **description is withheld** from any viewer who hasn't earned it too.
`profile.js` (`badgesFor`/`badgesForMany`) does this by `viewerId` — every route
that builds badges passes the caller's id (see the threading in feed /
competitions / groups / compare / users). Only your own secrets, or ones you have
also unlocked, reveal their how-to. (On the badge *collection* page an
undiscovered secret is still a masked `???` with no description — that is the
owner's view of a badge they don't have yet.)

### Consult the user before placing any new admin feature

The admin panel lives at `/admin` (issue #68). Inline actions that operate
directly on content in context — like a delete-post button on a post — may
stay where they appear. Anything that is a *management* action (user controls,
configuration, bulk operations, catalog edits) belongs in the admin panel or a
sub-page under `/admin/`.

**Before writing any code for a new admin feature:** stop and present at least
two concrete placement options to the user (which page/section it would live
in, what the UI entry point would be). The user decides. Do **not** infer a
location and implement it; the outcome must be explicit before you start.

### Consult the user before adding any new notification

When a new feature would fire a **new** notification, do **not** decide its shape
yourself. Stop and ask the user first about:

- **What the notification is** — its nature: achievement-like, an action with a
  positive or negative effect, an informational event, etc.
- **How it surfaces — a toast or a fullscreen animation.** These are two
  distinct delivery surfaces:
  - **Toast** — the small transient popup. Examples: achievements, badges.
  - **Fullscreen animation** — a bigger, foreground moment. Examples: rank-up,
    Elo change, match win. (This surface is being built in this session.)

Only after the user answers both do you implement it. See
[docs/notifications-client.md](./docs/notifications-client.md) for how the client
surfaces (bell, page, toast) behave.

## Issues & labels

Every issue carries **one `priority:`**, **one `type:`**, and optionally
`effort:`, `status:`, and `agent`. Labels are the source of truth for what to
work on and whether it is safe to start.

**Priority** (importance — pick the highest that fits):

- `priority:show-stopper` — breaks a core flow or risks data loss. Drop everything.
- `priority:high` — important, do soon.
- `priority:standard` — normal backlog.
- `priority:minor` — nice-to-have, low urgency.

**Type** (classification): `type:bug`, `type:feature`, `type:enhancement`,
`type:infra`, `type:testing`, `type:docs`, `type:chore`.

**Effort** (rough size): `effort:trivial` (<1h) · `effort:small` (half a
session) · `effort:medium` (one session) · `effort:large` (multi-session, needs
a plan first).

**Status / claim**: `status:claimed`, `status:in-progress`, `status:blocked`,
`status:needs-discussion`. `agent` marks an issue safe for an autonomous agent.

### Claim protocol (so parallel agents don't collide)

Before touching any issue an agent **must**:

1. `gh issue view <N> --json labels,assignees,title` and check for a claim.
2. **If `status:claimed` or `status:in-progress` is present (or it is assigned
   to someone else): STOP. Do not start.** Report to the user that the issue is
   already claimed and pick something else or wait.
3. Otherwise **claim it before writing any code**:
   `gh issue edit <N> --add-label status:in-progress` and
   `gh issue comment <N> --body "Claimed by <agent-id> at <UTC time>."`
4. On finish, the closing PR clears it (the merge removes the issue). If you
   **abandon** the work: `gh issue edit <N> --remove-label status:in-progress`
   and comment why, so the next agent can take it.

The label claim is best-effort, not a lock — re-check labels right before you
start committing.

### PRs must reference their issue

If a PR resolves an existing issue, it **must** reference it with a closing
keyword in the PR body: `Fixes #<N>` / `Closes #<N>` (one per issue if it spans
several). Issue-less PRs are fine — a PR does **not** need an issue created for
it; only reference an issue if one already exists.

## Never kill a process you did not start

The developer runs their own `bun run dev` (Vite) and API server in this repo.
Agents have repeatedly killed those while cleaning up their own test servers.
**A dev server dying mid-session is never acceptable collateral.**

- **Never use a pattern-matching killer.** No `pkill -f …`, no
  `kill $(pgrep …)`, no `killall bun`. Every one of these matches the
  developer's processes — and often the agent's own shell, which is why these
  commands keep exiting 144. `bun run dev`, `bun src/index.js` and the wrapper
  shell all look alike to a pattern.
- **Record the PID when you start something, and kill only that PID.**

  ```bash
  bun src/index.js > "$SCRATCH/srv.log" 2>&1 &
  SRV=$!            # the only pid you are ever allowed to kill
  kill -TERM $SRV
  ```

- **Get isolation from a fresh environment, not from killing things.** Every
  test server gets its own **unused high port** and its own **`DB_DIR` under the
  scratchpad**, never the repo's `server/data` and never the default 3001/5173.
  Two servers coexisting is fine; that is the whole point.
- Leave a stray test server running rather than risk a broad kill. Say so in the
  summary and let the developer clear it.

## 🔴 The logo geometry lives in TWO files. Both must change together.

The app logo exists in two forms and **the shapes are duplicated on purpose**:

| File | What it holds |
| --- | --- |
| `client/public/favicon.svg` | The full-colour artwork. Its `<mask id="cup">` holds the authoritative shapes: cup body, handle, three drops. |
| `client/src/components/AppLogo.tsx` | A hand-copied duplicate of exactly those shapes, for the monochrome silhouette. |

`favicon.svg` is the **source of truth**. `AppLogo.tsx` is a copy that the build
cannot check. Nothing errors when they disagree — the app just renders two
different logos in different places, and it can ship that way unnoticed.

**So: any change to the logo's geometry MUST be applied to both files in the
same commit.** Geometry means the two `<path d="…">`, the three drop
`<ellipse>` (cx/cy/rx/ry/rotate), the fit transform
`translate(-0.383 0.842) scale(1.0718)`, and the `viewBox`. Colour, filters,
gradients and highlights live only in the SVG and are irrelevant here.

**If you ever find the two out of sync — STOP. This is a hard fail.**

- Do **not** guess which file is correct and quietly "fix" it.
- Do **not** carry on with the surrounding task and mention it at the end.
- Do **not** file it as a nit in a PR body.
- Tell the developer immediately, in chat, before doing anything else, and
  flag it as a **red / high-severity error**. It means a previous change
  shipped a broken logo. Which of the two is intended is the developer's call,
  not yours.

Why it was left duplicated rather than deduplicated: the alternatives were a
CSS `mask-image` of `favicon.svg` (single-source, but rasterises seven blur
filters just to keep the alpha, breaks in print and forced-colors, and locks
the silhouette to one flat alpha forever) or build-time extraction of `#cup`
(a generated artifact plus a build step that breaks silently if the mask is
renamed). The duplication was chosen with eyes open — this note is the thing
that makes it safe. Do not delete it.

## Guardrails

- **Never reference a symbol that doesn't exist** — a CSS variable / design
  token, function, variable, import, or export. This is VALUES.md rule 0, the
  top-priority hard gate: such a change is **rejected outright in review**,
  regardless of everything else in it. Before committing, run typecheck **and**
  build, and grep for the exact token/function/import you introduced to confirm
  it resolves. Unverified references are unacceptable.
- **Never change the logo geometry in only one of the two files.** See the
  section above. Out-of-sync shapes are a red/high hard fail, reported to the
  developer in chat before anything else.
- **No scale animations as basic-interaction feedback.** Do not reach for a
  `transform: scale()` pop/bounce as the reflex "satisfying" response to a
  button press, tap, hover, toggle, or an item being actioned (marked read,
  completed, added). These viby scale-pops on everything make the product look
  unpolished and over-animated — and a *slow* scale is the worst of all. Feedback
  for basic interactions should come from colour, opacity, or position
  (translate), or from nothing at all. A scale is allowed only when the size
  change *is* the content/meaning of the interaction (e.g. zoom, a drag handle
  actually resizing something) and is explicitly intended — never as a decorative
  add-on. When in doubt, ship it without the scale.
- **Every endpoint that mutates state must broadcast.** Nothing in this app
  polls (issue #54), so a write with no push leaves the screen wrong until the
  user reloads — indefinitely, not for one interval. Adding a `refetchInterval`
  to fix a stale screen is treating the symptom; the missing `broadcast` is the
  bug. Read [docs/live-data-sse.md](./docs/live-data-sse.md) before adding a
  route that writes, and check the key you push is one the client actually uses
  — a wrong key fails silently.
- Don't split the frontend back into its own image/service/proxy.
- Don't add schema changes outside `server/src/migrations/`.
- Don't introduce npm/yarn/pnpm or a second lockfile.
- Don't add cross-origin API calls / a hardcoded API base URL.
- Don't let the process start with missing config or a failed migration.
- Verify persistence + `integrity_check` after any change near the DB or Docker.
- **Prefer fetching over recall. Assume you know ~1% of any topic and that the
  rest of your "knowledge" is wrong.** Before designing, reviewing, or changing
  anything non-trivial (timezones, security, protocols, library behaviour,
  APIs), **look it up** — WebFetch/WebSearch the primary source, read the actual
  docs, or grep this repo — instead of answering from memory. State plainly when
  something is unverified recall vs. checked. Confident-sounding guesses are the
  failure mode here; a fetched citation beats a remembered "fact" every time.
- **Time / timezones:** follow [docs/time-and-timezones.md](./docs/time-and-timezones.md)
  and fetch its linked sources before touching time code.
