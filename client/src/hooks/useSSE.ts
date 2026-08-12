import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '../store/auth';

// Connects to the server-sent events stream and invalidates React Query cache
// entries on demand. The server sends `invalidate` events whose data is
// `{ keys: string[][] }` — each entry is a query key array to mark stale.
//
// Opens a new connection whenever the auth token changes (login/logout).
// EventSource auto-reconnects on network drops; exponential back-off is
// managed by the browser.
export function useSSE() {
  const qc = useQueryClient();
  const token = useAuthStore((s) => s.token);

  useEffect(() => {
    if (!token) return;

    const url = `/api/events?token=${encodeURIComponent(token)}`;
    const es = new EventSource(url);

    const onInvalidate = (e: MessageEvent) => {
      const { keys } = JSON.parse(e.data) as { keys: string[][] };
      for (const key of keys) {
        qc.invalidateQueries({ queryKey: key });
      }
    };

    // Anything that happened while the stream was down is simply gone — SSE has
    // no replay, and this app no longer polls, so a missed event would leave the
    // screen wrong until the user navigated. On every open, including each
    // automatic reconnect, treat the whole cache as stale: the client cannot
    // know what it missed, so it re-asks. React Query only refetches what is
    // actually mounted, so the cost is one round of the visible screen's
    // queries — and it is what makes dropping the polling safe.
    //
    // This also covers the first connect, where it is a cheap no-op: those
    // queries were just fetched and are inside their staleTime.
    const onOpen = () => { qc.invalidateQueries(); };

    es.addEventListener('invalidate', onInvalidate as EventListener);
    es.addEventListener('open', onOpen);

    return () => {
      es.removeEventListener('invalidate', onInvalidate as EventListener);
      es.removeEventListener('open', onOpen);
      es.close();
    };
  }, [qc, token]);
}
