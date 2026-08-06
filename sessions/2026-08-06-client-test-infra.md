---
topics: [issue-16-testing, client-test-runner, happy-dom, testing-library, bunfig-preload]
---

# Client test infrastructure (#16, phase 2)

The client had **zero** test infrastructure before this — no runner, no DOM, no
`test` script, 56 source files uncovered.

## Runner choice: `bun test`, not vitest

The server already runs `bun test`, and VALUES.md rule 5 is "Bun everywhere".
One runner for the repo beats a second concept; `bun test` handles TSX natively
so no transform config is needed.

## The one real trap: preload ordering

`@testing-library/dom` captures `document.body` **at module-eval time** to build
`screen`. Static ESM imports are hoisted, so a setup file written the obvious
way —

```ts
import { cleanup } from '@testing-library/react';  // hoisted, runs FIRST
GlobalRegistrator.register();                      // too late
```

— leaves every `screen.*` query throwing *"For queries bound to document.body a
global document has to be available"*. Tests using `render(...).container` still
pass, which makes it look like a partial/flaky failure rather than an ordering
bug. **Testing-library must be pulled in with `await import()` after
`GlobalRegistrator.register()`.** See `client/src/test/setup.ts`.

happy-dom over jsdom: markedly faster, and nothing here needs jsdom's deeper
emulation.

## Typecheck without touching the production build

Test files are **excluded** from `tsconfig.app.json`, so `tsc -b` (and therefore
`bun run build`) compiles exactly the app as before with no bun globals in
scope. A separate `tsconfig.test.json` covers them, run via
`bun run test:types` — deliberately **not** referenced from `tsconfig.json`, or
`tsc -b` would pull it into the production build.

## Wiring

`client/bunfig.toml` sets `preload`. Scripts: `test`, `test:watch`,
`test:types` in `client/`; `test:client`, `typecheck:test` at the root, all
folded into `bun run check`. CI's `frontend` job gained Test + Typecheck steps.
New devDeps must be in `client/bun.lock` — CI installs `--frozen-lockfile`.

## Covered so far

`rarity.ts` (the sort flips direction between unlocked and locked groups —
worth pinning), `api/client.ts` (401 drops the session **except** on
login/register, `uploadUrl` token param), `components/Badge.tsx` (empty row
renders nothing, `withInfo` is opt-in so inline surfaces stay display-only,
popover open/close paths incl. the touch-vs-mouse pointer gate).
