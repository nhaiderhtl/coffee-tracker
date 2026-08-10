import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { useNotifications } from '../hooks/useNotifications';
import { toastFor, renderNotification } from '../notifications/catalog';
import { useReveals } from '../notifications/RevealProvider';
import type { AppNotification } from '../types';

// Transient toasts for newly-arrived notifications. Global, mounted once.
// Achievements/badges toast normally. A match_end shows a GENERIC, tappable
// toast that opens its fullscreen reveal (it never spoils the result). While a
// reveal is on screen every toast is held back — reveals drain first
// (docs/notifications-reveals.md).
const TOAST_MS = 4500;

interface ToastItem { key: string; icon: string; title: string; body: ReactNode; reveal?: AppNotification }

export function NotificationToaster() {
  const { data } = useNotifications();
  const { playOne, revealing } = useReveals();
  const seen = useRef<Set<string>>(new Set());
  const seeded = useRef(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  useEffect(() => {
    const list = data?.notifications;
    if (!list) return;

    // First fetch seeds the "already seen" set so existing history never toasts;
    // only notifications that appear on a later poll are new.
    if (!seeded.current) {
      for (const n of list) seen.current.add(n.id);
      seeded.current = true;
      return;
    }

    const fresh: ToastItem[] = [];
    for (const n of list) {
      if (seen.current.has(n.id)) continue;
      seen.current.add(n.id);
      if (n.read_at !== null) continue; // already read elsewhere → don't toast
      if (n.type === 'match_end') {
        // Generic, tappable → opens the reveal. On return/fresh-open the reveal
        // auto-plays instead (those are not "fresh" here), so this is only the
        // in-app arrival path.
        const r = renderNotification(n);
        const body = r.kind === 'match' ? `${r.context} · tap to reveal` : 'tap to reveal';
        fresh.push({ key: n.id, icon: 'trophy', title: 'Match result', body, reveal: n });
        continue;
      }
      const t = toastFor(n); // catalog decides eligibility
      if (t) fresh.push({ key: n.id, ...t });
    }
    if (fresh.length) setToasts((prev) => [...prev, ...fresh]);
  }, [data]);

  // Hold every toast while a reveal owns the screen; they flush (timers start on
  // mount) once it is dismissed.
  if (revealing || toasts.length === 0) return null;

  return (
    <div className="ntf-toast-wrap">
      {toasts.map((t) => (
        <Toast key={t.key} t={t}
          onTap={t.reveal ? () => playOne(t.reveal!) : undefined}
          onDone={() => setToasts((prev) => prev.filter((x) => x.key !== t.key))} />
      ))}
    </div>
  );
}

function Toast({ t, onDone, onTap }: { t: ToastItem; onDone: () => void; onTap?: () => void }) {
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    const id = setTimeout(() => done.current(), TOAST_MS);
    return () => clearTimeout(id);
  }, []);
  const click = () => { if (onTap) onTap(); done.current(); };
  return (
    <div className="ntf-toast" data-reveal={t.reveal ? 'true' : undefined} role="status" onClick={click}>
      <span className="ntf-toast-icon"><Icon name={t.icon} size={20} /></span>
      <div className="ntf-toast-body">
        <div className="ntf-toast-title">{t.title}</div>
        <div className="ntf-toast-text">{t.body}</div>
      </div>
    </div>
  );
}
