import { useEffect, useRef, useState } from 'react';
import { AppHeader } from '../components/AppHeader';
import { Icon } from '../components/Icon';
import { useNotifications, useMarkNotificationsRead } from '../hooks/useNotifications';
import { renderNotification, ordinal, highlight, type RenderedNotification } from '../notifications/catalog';
import { useReveals } from '../notifications/RevealProvider';
import type { AppNotification } from '../types';

function when(ms: number): string {
  return new Date(ms).toLocaleString([], {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

// Type-aware card body. Every kind uses the same building blocks (badge, title,
// time, pills, description) so the types read as one system.
function CardBody({ r, time, generic }: { r: RenderedNotification; time: string; generic?: boolean }) {
  // A match_end stays generic until its fullscreen reveal has disclosed it —
  // no result, no numbers, just an invitation to open it (docs/notifications-reveals.md).
  if (generic && r.kind === 'match') {
    return (
      <>
        <span className="ntf-badge" data-tone="neutral"><Icon name="trophy" size={20} /></span>
        <div className="ntf-main">
          <div className="ntf-head">
            <span className="ntf-title">Match result</span>
            <span className="ntf-time">{time}</span>
          </div>
          <div className="ntf-desc">{r.context} · tap to reveal</div>
        </div>
      </>
    );
  }
  if (r.kind === 'match') {
    const sign = r.delta > 0 ? '+' : r.delta < 0 ? '−' : '';
    return (
      <>
        <span className="ntf-badge" data-tone={r.tone}><Icon name={r.icon} size={20} /></span>
        <div className="ntf-main">
          <div className="ntf-head">
            <span className="ntf-title"><span data-tone={r.tone}>{r.result}</span> your {r.mode} match</span>
            <span className="ntf-time">{time}</span>
          </div>
          <div className="ntf-meta">
            <span className="ntf-pill">{ordinal(r.rank)} of {r.count}</span>
            <span className="ntf-pill" data-tone={r.tone}>{sign}{Math.abs(r.delta)}</span>
            <span className="ntf-context">{r.context}</span>
          </div>
        </div>
      </>
    );
  }
  if (r.kind === 'simple') {
    return (
      <>
        <span className="ntf-badge" data-tone="neutral"><Icon name={r.icon} size={20} /></span>
        <div className="ntf-main">
          <div className="ntf-head">
            <span className="ntf-title">{r.name}</span>
            <span className="ntf-pill" data-variant="tag">{r.tag}</span>
            <span className="ntf-time">{time}</span>
          </div>
          <div className="ntf-desc">{r.description}</div>
        </div>
      </>
    );
  }
  if (r.kind === 'recompute') {
    return (
      <>
        <span className="ntf-badge" data-tone="warn"><Icon name={r.icon} size={20} /></span>
        <div className="ntf-main">
          <div className="ntf-head">
            <span className="ntf-title">{r.title}</span>
            <span className="ntf-time">{time}</span>
          </div>
          <div className="ntf-desc">
            {highlight(`**${r.invalidatedTitle}** was removed by an admin. Your rating changed from **${r.oldRating}** to **${r.newRating}**.`)}
          </div>
        </div>
      </>
    );
  }
  return (
    <>
      <span className="ntf-badge" data-tone="neutral"><Icon name={r.icon} size={20} /></span>
      <div className="ntf-main">
        <div className="ntf-head">
          <span className="ntf-title">{r.title}</span>
          <span className="ntf-time">{time}</span>
        </div>
        <div className="ntf-desc">{r.rows.map(([k, v]) => `${k}: ${v}`).join('\n')}</div>
      </div>
    </>
  );
}

// Snap-back = a real spring, not a fixed-duration curve. We integrate a damped
// harmonic oscillator (Hooke's law + viscous damping — the model react-spring /
// Framer use) frame by frame toward x=0, seeded with the card's release
// velocity. Settle time is emergent from the displacement + that velocity, so a
// few-mm throw settles in well under 200ms while a few-cm throw takes 200ms or
// more, and the motion is spring-shaped, never linear.
const SPRING = { stiffness: 900, damping: 50, mass: 1 }; // slightly underdamped
const REST_X = 0.2;   // px — settle when this close to centre
const REST_V = 4;     // px/s — …and this slow

function springHome(from: number, velocity: number, onFrame: (x: number) => void): () => void {
  const { stiffness: k, damping: c, mass: m } = SPRING;
  let x = from, v = velocity, last = performance.now(), raf = 0;
  const step = (now: number) => {
    const dt = Math.min((now - last) / 1000, 0.032); // clamp a tab-switch stall
    last = now;
    const a = (-k * x - c * v) / m;
    v += a * dt;
    x += v * dt;
    if (Math.abs(x) < REST_X && Math.abs(v) < REST_V) { onFrame(0); return; }
    onFrame(x);
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return () => cancelAnimationFrame(raf);
}

const THRESHOLD = 0.34; // fraction of card width the drag must pass to commit

// One notification. Unread cards are draggable to mark read:
//
// - The card follows the finger 1:1 (transform written straight to the node —
//   no React re-render per frame, and the read state is NEVER touched mid-drag,
//   so the card is never modified under the finger). Behind it a "✓ Read" pane
//   is revealed on the side the card leaves; crossing the threshold pops it green
//   so you can see "release here = read" before letting go.
// - Only the release decides. Past threshold → the card springs home and the
//   card fades from its unread tint to the read style; under threshold → it just
//   springs home, unchanged. The spring is JS (see springHome); it can't be
//   interrupted under the finger because a fresh pointerdown cancels it.
// - The "✓ Read" pane is a real button too, so mouse/keyboard users mark read
//   without dragging.
function NotificationRow(
  { n, onRead, onReveal }:
  { n: AppNotification; onRead: (id: string) => void; onReveal?: (n: AppNotification) => void },
) {
  const r = renderNotification(n);
  const unread = n.read_at === null;
  // An unread match_end is generic and tappable — a tap opens its reveal.
  const genericMatch = unread && n.type === 'match_end';
  const [reading, setReading] = useState(false); // playing the unread→read fade
  const rowRef = useRef<HTMLLIElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLButtonElement>(null);
  const d = useRef({ id: -1, x0: 0, y0: 0, axis: 'u' as 'u' | 'x' | 'y',
    dx: 0, lx: 0, lt: 0, v: 0, over: false, w: 1, dragged: false, stop: () => {} });

  const setX = (x: number) => {
    const card = cardRef.current;
    if (card) card.style.transform = x ? `translateX(${x}px)` : '';
  };
  const setOver = (over: boolean) => {
    if (d.current.over === over) return;
    d.current.over = over;
    rowRef.current?.setAttribute('data-over', String(over));
  };

  const commit = () => {
    if (reading || !unread) return;
    setReading(true);
    onRead(n.id);
  };

  useEffect(() => () => d.current.stop(), []); // cancel a spring on unmount

  const onDown = (e: React.PointerEvent) => {
    if (!unread || reading || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const s = d.current;
    s.stop();                                     // interrupt an in-flight spring
    s.id = e.pointerId; s.axis = 'u'; s.dx = 0; s.v = 0; s.dragged = false;
    s.x0 = e.clientX; s.y0 = e.clientY; s.lx = e.clientX; s.lt = e.timeStamp;
    s.w = cardRef.current?.clientWidth ?? 1;
  };

  const onMove = (e: React.PointerEvent) => {
    const s = d.current;
    if (s.id !== e.pointerId) return;
    const dx = e.clientX - s.x0, dy = e.clientY - s.y0;
    if (s.axis === 'u') {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;   // wait for a clear axis
      s.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (s.axis === 'x') { s.dragged = true; cardRef.current?.setPointerCapture(e.pointerId); }
      else { s.id = -1; return; }                          // vertical → page scrolls
    }
    if (s.axis !== 'x') return;
    const dt = e.timeStamp - s.lt;
    if (dt > 0) s.v = Math.max(-2500, Math.min(2500, (e.clientX - s.lx) / dt * 1000));
    s.lx = e.clientX; s.lt = e.timeStamp;
    s.dx = dx;
    rowRef.current?.setAttribute('data-side', dx >= 0 ? 'left' : 'right');
    setX(dx);
    setOver(Math.abs(dx) > s.w * THRESHOLD);
  };

  const onUp = (e: React.PointerEvent) => {
    const s = d.current;
    if (s.id !== e.pointerId) { s.id = -1; return; }
    const wasDrag = s.axis === 'x';
    const past = wasDrag && Math.abs(s.dx) > s.w * THRESHOLD;
    s.id = -1; s.axis = 'u';
    setOver(false);
    if (wasDrag) { s.stop = springHome(s.dx, s.v, setX); if (past) commit(); } // release decides
  };

  // Open the reveal on a real click (not a drag). A click event targets the
  // card, so it never leaks through to the just-mounted reveal overlay — which
  // is what made the reveal skip straight to its end when opened from here.
  const onCardClick = () => {
    if (genericMatch && onReveal && !d.current.dragged) onReveal(n);
  };

  const time = when(n.created_at);

  // Read (and mid-fade) rows are not draggable. During the fade we keep
  // data-unread so the tint is present, then animate it away to the read style.
  if (!unread || reading) {
    return (
      <li ref={rowRef} className="ntf" data-unread={unread} data-fading={reading || undefined}>
        <div ref={cardRef} className="ntf-card"
             onAnimationEnd={reading ? () => setReading(false) : undefined}>
          <CardBody r={r} time={time} />
        </div>
      </li>
    );
  }

  return (
    <li ref={rowRef} className="ntf" data-unread={true} data-side="left">
      <button ref={paneRef} className="ntf-pane" onClick={commit} aria-label="Mark read">
        <span className="ntf-pane-check"><Icon name="check" size={16} /></span> Read
      </button>
      <div ref={cardRef} className="ntf-card ntf-card-drag" data-reveal={genericMatch || undefined}
           onPointerDown={onDown} onPointerMove={onMove}
           onPointerUp={onUp} onPointerCancel={onUp} onClick={onCardClick}>
        <CardBody r={r} time={time} generic={genericMatch} />
      </div>
    </li>
  );
}

export function Notifications() {
  const { data, isLoading } = useNotifications();
  const markRead = useMarkNotificationsRead();
  const { playOne } = useReveals();
  const list = data?.notifications ?? [];
  const unread = data?.unread_count ?? 0;

  return (
    <div className="page">
      <AppHeader />
      <div className="page-header">
        <div className="notif-head-row">
          <h2>Notifications</h2>
          <button className="notif-markall" disabled={unread === 0} onClick={() => markRead.mutate({ all: true })}>
            <Icon name="check" size={14} /> Mark all read
          </button>
        </div>
      </div>

      <ul className="notif-list">
        {isLoading && <div className="notif-empty">Loading…</div>}
        {!isLoading && list.length === 0 && <div className="notif-empty">No notifications yet.</div>}
        {list.map((n) => (
          <NotificationRow key={n.id} n={n} onRead={(id) => markRead.mutate({ ids: [id] })} onReveal={playOne} />
        ))}
      </ul>
    </div>
  );
}
