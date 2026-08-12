# Coffee Tracker — Core Values

Priority order. Read before making changes. This file is the source of truth
for project values; AGENTS.md covers architecture and workflows.

0. **Never reference symbols that do not exist. (Hard gate — outranks
   everything below.)** Code that references something that isn't defined — a
   CSS variable / design token, a function, a variable, an import or export —
   is **rejected outright in review, with zero consideration of any other code
   in the change.** No exceptions. Examples of what gets a change thrown out:
   `var(--text)` when only `--text-primary` exists; calling a helper that was
   never defined; importing a module or symbol that isn't exported. This is the
   single most unacceptable class of error — it means the code was never run or
   checked. Before committing, prove every referenced symbol resolves:
   typecheck **and** build must pass, and grep for the exact token/function/
   import you introduced to confirm it exists. If you cannot confirm it exists,
   do not reference it.

0.4. **A refactor is not done until every dependent is updated to match — no
   stale logic left alive anywhere.** When behavior/a rule changes anywhere
   (a backend endpoint, a shared function, a constant, a type), every other
   place that assumed the old behavior must be found and updated in the same
   change: UI labels and copy ("optional", disabled-state hints, validation
   messages, placeholders), other call sites, duplicated/parallel logic
   elsewhere in the same layer, docs, tests. This is not only a backend→
   frontend concern — a rule can drift within a single file or across several
   frontend components with no backend involved at all. A disabled control
   with no explanation of why, or copy that contradicts actual behavior, is a
   bug, not a minor gap. Do not ship a change that leaves the codebase telling
   two different stories. This costs more tokens per change — pay it. Grep for
   the old wording/constant/behavior across the whole affected surface before
   calling a refactor finished.

0.5. **No emojis in the UI — use real icons.** Every glyph in the interface is a
   proper icon from a single library (`react-icons`, Font Awesome set), never an
   emoji. This keeps rendering consistent across platforms/fonts (emoji look
   different on every OS) and the visual language uniform. The **only** exception
   is the user's profile "image": the avatar picker (`Profile.tsx` `AVATARS`) is
   deliberately an emoji chooser, and that emoji is rendered as the user's avatar
   wherever their identity appears (feed headers, compare, profile). No other
   emoji — not in buttons, labels, empty states, toasts, tabs, status text, or
   coffee-type icons. When you need a glyph, import an icon; do not paste an emoji.

0.6. **UI copy is terse. Nobody reads a paragraph in an app.** Every piece of
   user-facing text — hints, empty states, dialogs, toggle sub-labels, error
   messages — is **one short line**. If a rule genuinely needs a paragraph to
   explain, the interface is wrong; fix the interface, don't caption it. Some
   specifics:
   - **Never restate the control.** A hint reading "Players can join until the
     match starts" under a field labelled *Starts* is noise.
   - **Say the constraint, not the reasoning.** "Min 2 per side." — not "at
     least 2, because a side of one is a 1v1, not a team." The reasoning
     belongs in a code comment, where the next developer needs it and the user
     never sees it.
   - **Don't reassure.** Confirmation dialogs state what happens, once.
   - Long explanations push the actual controls off the screen, and the text
     that matters gets skipped along with the text that doesn't.

   This applies to the UI only. **Code comments, commit messages and docs stay
   as thorough as they need to be** — different readers, opposite rules.

1. **Stability & consistency above all.** This app should just run, for a long
   time, without surprises. Prefer boring, proven approaches over clever ones.
   "Code quality" polish is not a goal in itself — a stable, predictable system
   is. Keep behavior consistent across restarts, rebuilds, and releases.

2. **Never lose committed data.** The SQLite DB is the source of truth and must
   survive crashes, restarts, redeploys, and hard kills.
   - SQLite runs in **WAL mode** (`server/src/db.js`).
   - The process handles **SIGTERM/SIGINT** gracefully (closes server + DB) so
     restarts are clean (`server/src/index.js`).
   - Any change touching persistence must preserve: `PRAGMA integrity_check` =
     `ok` after a `docker kill -9`, and zero loss of committed rows.

3. **DB migrations for every schema change.** Never hand-edit the schema or add
   inline `ALTER`/`CREATE` at boot. All schema lives in numbered migrations.
   - Runner: `server/src/migrate.js` (runs on boot, before routes mount).
   - Migrations: `server/src/migrations/NNN_description.js`, each exporting
     `up(db)`. Applied in ascending numeric order, each recorded atomically in
     `schema_migrations`. A failed migration aborts the process (fail-fast).
   - **To add a schema change:** create the next-numbered file (e.g.
     `004_add_x.js`) with an `up(db)`. Make it idempotent/guarded where
     reasonable. If it must control its own transaction or toggle PRAGMAs (like
     `003_drop_email_column.js` does for `foreign_keys`), set
     `exports.manualTransaction = true`. Never renumber or edit an
     already-shipped migration — only add new ones.

4. **Single Docker container.** One image serves BOTH the frontend (`/`) and the
   API (`/api`). No separate frontend image, no proxy container.
   - `server/Dockerfile` is multi-stage, built from the **repo root**: stage 1
     builds the Vite client → `/client/dist`; stage 2 (Bun/Express) copies it to
     `./public` and serves it with an SPA fallback.
   - One compose service (`docker-compose.yaml`), one published port. Don't
     reintroduce a second service/image for the frontend.

5. **Bun everywhere.** The server runs on Bun (required for `bun:sqlite`), and
   the client is built with Bun. Use `bun install` / `bun run`, not npm/yarn/pnpm.
   Do not add `package-lock.json`/`yarn.lock`; `bun.lock` is the lockfile.

6. **Same-origin, no CORS.** Frontend and API share one origin/port, so the
   client calls `/api` relatively (`client/src/api/client.ts`). Do not
   reintroduce a cross-origin setup or a baked-in absolute API URL. Keep it
   same-origin so there is no CORS surface to manage.

7. **Fail-fast on bad config.** Refuse to start rather than run degraded:
   missing/weak `JWT_SECRET` exits (`server/src/index.js`); a failed migration
   exits; compose requires `JWT_SECRET` via `${JWT_SECRET:?...}`. Preserve this —
   never silently fall back to insecure or half-migrated states.

8. **Live data is pushed, never polled.** Shared state reaches the client over
   the SSE stream (`GET /api/events`), which carries cache-invalidation signals
   only — never data, so visibility stays decided by the GET handlers. There is
   no `refetchInterval` in the client and none should return.
   - **Every endpoint that mutates state broadcasts.** Because nothing polls, a
     write with no push leaves the screen wrong until a reload — indefinitely,
     not for one interval. A stale screen is a missing `broadcast`, and adding a
     poll to paper over it is the wrong fix.
   - **A reconnect re-asks rather than replays.** SSE has no backlog, so the
     client invalidates its whole cache on every stream open. Never narrow that
     to a subset: what could have changed during a gap is everything.
   - Details and the rules for adding a push:
     [docs/live-data-sse.md](./docs/live-data-sse.md).
