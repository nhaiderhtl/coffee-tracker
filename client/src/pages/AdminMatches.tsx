import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAuthStore } from '../store/auth';
import { AppHeader } from '../components/AppHeader';
import { Icon } from '../components/Icon';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { MatchCard, MODE_ICON, MODE_LABEL } from './Compete';
import type { AdminMatch, AdminMatchesResponse } from '../types';

// Total rating a match moved: the sum of its positive deltas (a settlement is
// zero-sum, so this is the magnitude, not a signed total). Cancelled/invalidated
// matches moved nothing.
function eloMoved(m: AdminMatch): number {
  return m.participants.reduce((s, p) => (p.delta && p.delta > 0 ? s + p.delta : s), 0);
}

function pointsTotal(m: AdminMatch): number {
  return m.participants.reduce((s, p) => s + (p.points ?? 0), 0);
}

function fmtDuration(ms: number): string {
  const days = Math.round(ms / 86400000);
  if (days >= 1) return days === 1 ? '1 day' : `${days} days`;
  const hours = Math.round(ms / 3600000);
  if (hours >= 1) return hours === 1 ? '1 hour' : `${hours} hours`;
  const mins = Math.max(1, Math.round(ms / 60000));
  return mins === 1 ? '1 min' : `${mins} min`;
}

// One row: a compact summary line that expands to the full match card and, for a
// settled match still within the depth cap, the invalidate action.
function MatchRow({ m, now }: { m: AdminMatch; now: number }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');

  const invalidate = useMutation({
    mutationFn: () => api.post(`/admin/matches/${m.id}/invalidate`),
    onSuccess: () => {
      // The replay rewrote ledgers and ratings across the app — refetch anything
      // that shows a match or a rating. The ['competitions'] prefix covers the
      // match list, the leaderboard and history.
      qc.invalidateQueries({ queryKey: ['admin-matches'] });
      qc.invalidateQueries({ queryKey: ['competitions'] });
      setConfirming(false);
      setError('');
    },
    onError: (e: Error) => setError(e.message),
  });

  const stateLabel = m.state === 'invalidated' ? 'invalidated' : m.state;
  // Why the invalidate button is disabled, if it is (settled only, within cap).
  const blockedReason = m.state !== 'settled'
    ? `Already ${stateLabel}`
    : !m.invalidatable
      ? `${m.settled_after} matches settled after this — too many to invalidate`
      : null;

  return (
    <div className={`admin-acc${open ? ' open' : ''}`}>
      <button className="admin-acc-head admin-match-head" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={14} className="admin-acc-chev" />
        <Icon name={MODE_ICON[m.mode]} size={13} />
        <span className="admin-match-name">{m.title || MODE_LABEL[m.mode]}</span>
        <span className={`cmp-state ${m.state}`}>{stateLabel}</span>
        <span className="admin-match-metrics">
          <span title="Rating moved"><Icon name="scale" size={11} /> {eloMoved(m)}</span>
          <span title="Points scored"><Icon name="bolt" size={11} /> {pointsTotal(m)}</span>
          <span title="Duration"><Icon name="clock" size={11} /> {fmtDuration(m.scope_end - m.scope_start)}</span>
        </span>
      </button>

      {open && (
        <div className="admin-match-body">
          <MatchCard match={m} now={now} />
          <div className="admin-match-actions">
            {blockedReason
              ? <span className="field-hint">{blockedReason}</span>
              : <button className="btn-danger" onClick={() => { setError(''); setConfirming(true); }}>
                  Invalidate match
                </button>}
          </div>
        </div>
      )}

      {confirming && (
        <ConfirmDialog
          title="Invalidate this match?"
          message={`Every match settled after it (${m.settled_after}) is recalculated. This cannot be undone.`}
          confirmLabel="Invalidate"
          busy={invalidate.isPending}
          error={error || undefined}
          onConfirm={() => invalidate.mutate()}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}

export function AdminMatches() {
  const navigate = useNavigate();
  // Match invalidation is super-admin only, so the whole page is. `user` is null
  // for a moment on a hard load — only bounce once we KNOW they aren't super.
  const user = useAuthStore(s => s.user);
  const isSuper = user?.is_super_admin === 1;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (user && !isSuper) navigate('/profile', { replace: true });
  }, [user, isSuper, navigate]);

  // The cards read `now` to label a window; a slow clock is fine here (finished
  // matches don't change), so a coarse tick keeps them fresh without churn.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);

  const { data, isLoading, error } = useQuery<AdminMatchesResponse>({
    queryKey: ['admin-matches'],
    queryFn: () => api.get<AdminMatchesResponse>('/admin/matches'),
    enabled: isSuper,
  });

  if (!isSuper) {
    return (
      <div className="page">
        <AppHeader />
        {!user && <div className="page-loading">Loading…</div>}
      </div>
    );
  }

  const matches = data?.matches ?? [];

  return (
    <div className="page">
      <AppHeader />
      <div className="page-header">
        <h2>Matches</h2>
      </div>

      <main className="stats-tab-body">
        {error && <div className="card error-card">{(error as Error).message}</div>}
        {isLoading && <div className="page-loading">Loading…</div>}
        <div className="card admin-acc-card">
          {matches.map(m => <MatchRow key={m.id} m={m} now={now} />)}
          {!isLoading && matches.length === 0 && <div className="empty-state">No finished matches yet.</div>}
        </div>
      </main>
    </div>
  );
}
