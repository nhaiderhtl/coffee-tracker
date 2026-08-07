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

    es.addEventListener('invalidate', onInvalidate as EventListener);

    return () => {
      es.removeEventListener('invalidate', onInvalidate as EventListener);
      es.close();
    };
  }, [qc, token]);
}
