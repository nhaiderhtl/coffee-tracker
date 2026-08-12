# Notification client interaction (issue #32)

How notifications behave and read on the client. This is the living source of
truth for the **interaction and presentation** layer; when a fix is agreed, it
is written here first.

Implementation details — table, migration, emit sites, API contract, types,
query-hook config, file paths — stay in [notifications.md](./notifications.md).
Where this spec and notifications.md §6 disagree on behaviour, **this spec
wins** (it supersedes the original "marks all read on open" line).

Big `match_end` events don't land as a card or toast — they get a **fullscreen
reveal**, specced in [notifications-reveals.md](./notifications-reveals.md),
which owns when the reveal fires and how it animates. This doc still owns the
`match_end` *card* (its generic-vs-detailed states) and the generic tap-to-open
toast that launches the reveal.

## Surfaces

Two, both global:

- **Bell** in the app header, on every main page. Shows an unread count badge
  when there are unread notifications. Tapping it opens the notifications page.
- **Notifications page** (`/notifications`) — the full history, newest first.

## Read model

A notification is **unread until the user explicitly reads it.** Opening the
page does **not** mark anything read — the user must be able to see at a glance
which are new. The unread badge on the bell reflects the unread count and only
drops when notifications are actually marked read.

Two ways to mark read:

- **Drag a card either way.** Unread cards only. A custom horizontal
  pointer-drag: the card follows the finger 1:1, revealing a "✓ Read" pane on the
  side it leaves. **The read state is never touched mid-drag** — the card is only
  moved, never modified under the finger — and **only the release decides.**

  - While dragging, once the card passes the **threshold (34% of card width)**
    the pane pops from neutral/grey to **green with the check scaled up**, the
    "release here = read" cue. Drag back under the threshold and it reverts.
  - **On release past the threshold:** the card **springs back to centre** and
    **fades from its unread tint to the read style** (both animated), and the row
    is marked read. **Under the threshold:** it springs back unchanged.
  - The mark is applied optimistically, so the bell badge and read styling update
    at once, before the network round-trip.

  **The snap-back is a real spring, not a fixed-duration curve.** It integrates a
  damped harmonic oscillator (Hooke's law + viscous damping) frame by frame in
  JS, seeded with the card's release velocity, so the settle time is emergent:
  a few-mm throw settles in well under 200 ms, a few-cm throw in 200 ms or more,
  and the motion is spring-shaped, never linear. It is never a single-frame snap.

  Why a custom drag and not native scroll-snap: scroll-snap moves and commits the
  card *as you scroll* and only reports on `scrollend`, which both modifies the
  card under the finger and — because a snap-settle animation stays a live scroll
  track — captured the *next* card's touch, breaking fast bottom-to-top marking.
  A pointer-drag with a JS spring gives release-only commit and leaves no live
  scroll track between cards.

  The card clips its own rounded rectangle with the pane behind it, so nothing
  rounded seams against a bordered parent (the corner-seam problem an earlier
  hand-rolled version had). The "✓ Read" pane is a real, focusable button too, so
  mouse/keyboard users mark read without dragging (focus reveals it; click marks).
- **"Mark all read" pill** at the top-right of the page header (mail-app style).
  Disabled when nothing is unread.

Unread cards are visually distinct from read ones (tinted background + accent
edge + a dot), so new vs. old is obvious without reading a word.

## Toasts

A newly-arrived notification pops a transient toast, so an unlock is felt
without opening the bell. Rules:

- **Only some types toast.** The catalog decides per type (one place).
  Achievements and badges toast; unknown/raw types stay out — a toast is only for
  a type that presents cleanly.
- **`match_end` is special:** in-session it shows a **generic, tappable** toast
  ("Match result") that **launches the fullscreen reveal** on tap — it does not
  spoil the result and it is not the usual auto-dismiss info toast. See
  [notifications-reveals.md](./notifications-reveals.md). On return/fresh open the
  reveal auto-plays instead, and **no toast is shown while a reveal is on screen**
  (reveals drain before toasts).
- **One animation** for every ordinary toast — a single entrance. No per-type
  variety.
- Toasts auto-dismiss after a few seconds and can be dismissed by tapping (the
  generic `match_end` toast is the exception: tapping it opens the reveal).
- Only genuinely new notifications toast: existing history on first load never
  pops. A toast never marks anything read — the bell and page still own the
  read state.

## No navigation

Notification cards are **display-only**. Tapping a card does nothing — it never
navigates anywhere. (An earlier click-to-jump behaviour was removed; it was
never a planned feature and it fought the swipe gesture.)

**One exception:** an *unrevealed* (generic) `match_end` card is tappable — it
launches the fullscreen reveal (see
[notifications-reveals.md](./notifications-reveals.md)). Once revealed (read) it
reverts to display-only like every other card. Tapping never navigates; it only
plays the reveal.

## Presentation — data-forward, per type

The backend never writes a sentence. All copy and layout live in a frontend
catalog keyed by `type`; changing wording or layout is a one-place edit that
applies to every row, past and present.

The catalog must **not** flatten every type into the same rigid
icon + title + description + time row. That layout buries the data: for a match
result, the placing and the rating change are the whole point and must read
instantly, not hide inside a sentence. Each type renders a layout built around
its own key figures, with eye-catching elements that communicate the data
before the words are read.

Per-type intent:

- **match_end** — two-stage, gated on read state (see
  [notifications-reveals.md](./notifications-reveals.md)):
  - **Generic (unread / unrevealed):** "Match result", neutral icon, **no
    outcome shown** — the reveal has not disclosed it yet. Tappable to reveal.
  - **Detailed (read / revealed):** the result is the headline — **Won / Lost /
    Tied**, coloured (green win, red loss) — with the two figures that matter as
    their own prominent elements, not prose:
    - **placing** as a rank element, e.g. `1st of 6`,
    - **rating change** as a coloured delta chip, e.g. `+18` (green) / `−12`
      (red).
    Group / scope is quiet context.
- **achievement / badge** — icon + name are the emphasis, with a small
  "Achievement" / "Badge" tag and the description as secondary text.
- **unknown type** (default renderer, required) — a server type shipped ahead
  of the frontend must still render: generic bell icon, the raw `type` as the
  title, and the payload shown as key/value lines. Never nothing.

### Copy rules

Plain and short. No em-dashes, no filler, no "this is X and it does Y"
phrasing. State the fact.

### Colour / tone

- gain / win → `--success-fg` (green)
- loss → `--danger-fg` (red)
- neutral → `--accent`

Always theme variables, never hard-coded hex, so light and dark both hold up.

## Refresh cadence (user-visible)

Notifications and the bell badge update as good as immediately: the server
pushes an invalidation the moment the row is written (#54), and the window
regaining focus refetches as well. Nothing polls. See
[live-data-sse.md](./live-data-sse.md) for the connection itself.
