import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { AppHeader } from '../components/AppHeader';
import { Icon } from '../components/Icon';
import type { Challenge } from '../types';

// Community challenges are a shared, cooperative target — nothing about them is
// competitive, so they do not belong under Compete (issue #63). They live on
// their own page again, reached from Profile alongside Badges and Milestones.
// Personal challenges were removed entirely back in issue #51.

const CHALLENGE_METRIC_LABEL: Record<string, string> = {
  total_cups: 'Total Cups',
  caffeine: 'Total Caffeine (mg)',
  espresso_cups: 'Espresso Cups',
  unique_types: 'Unique Coffee Types',
};
function challengeMetricLabel(m: string) { return CHALLENGE_METRIC_LABEL[m] ?? m; }
function challengePct(current: number, target: number) { return Math.min(100, Math.round((current / target) * 100)); }

export function Challenges() {
  const qc = useQueryClient();

  const { data: challenges = [], isLoading } = useQuery<Challenge[]>({
    queryKey: ['challenges'], queryFn: () => api.get('/challenges'), refetchInterval: 60000,
  });

  const join = useMutation({
    mutationFn: (id: string) => api.post<{ ok: boolean }>(`/challenges/${id}/join`),
    onSuccess: () => {
      for (const key of ['challenges', 'badges', 'achievements']) {
        qc.invalidateQueries({ queryKey: [key] });
      }
    },
  });

  const community = challenges.filter(c => c.type === 'community');

  return (
    <div className="page">
      <AppHeader />
      <div className="page-header">
        <h2>Challenges</h2>
        <p className="page-sub">Everyone contributes to one shared target</p>
      </div>

      <main className="stats-tab-body">
        {isLoading ? (
          <div className="page-loading">Loading…</div>
        ) : community.length === 0 ? (
          <div className="card"><div className="empty-state">No community challenges right now.</div></div>
        ) : (
          community.map(c => {
            const pct = challengePct(c.community_progress, c.target);
            return (
              <div key={c.id} className="card">
                <div className="ch-header">
                  <div><div className="ch-name">{c.name}</div><div className="ch-desc">{c.description}</div></div>
                  <div className="ch-badge community">Community</div>
                </div>
                <div className="ch-progress-label">
                  <span>{challengeMetricLabel(c.metric)}</span>
                  <span>{c.community_progress.toLocaleString()} / {c.target.toLocaleString()}</span>
                </div>
                <div className="ch-progress-wrap"><div className="ch-progress-bar" style={{ width: `${pct}%` }} /></div>
                <div className="ch-meta">
                  <span><Icon name="users" /> {c.participants_count} participants</span>
                  <span><Icon name="calendar" /> Ends {new Date(c.end_date).toLocaleDateString()}</span>
                </div>
                {c.joined ? (
                  <div className="ch-joined"><Icon name="check-circle" /> Joined · Your contribution: {c.my_progress?.toLocaleString() ?? 0}</div>
                ) : (
                  <button className="btn-primary" onClick={() => join.mutate(c.id)} disabled={join.isPending}>Join Challenge</button>
                )}
              </div>
            );
          })
        )}
      </main>
    </div>
  );
}
