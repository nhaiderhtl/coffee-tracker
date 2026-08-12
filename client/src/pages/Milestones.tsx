import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { AppHeader } from '../components/AppHeader';
import { Icon } from '../components/Icon';
import type { Achievement, ProgressMetric, Stats as StatsData, StreaksResponse } from '../types';

// Personal-progress milestones, lifted out of the old Stats "Challenges" tab and
// reached from a Profile button now (issue #51).
export function Milestones() {
  const { data: stats } = useQuery<StatsData>({
    queryKey: ['stats'], queryFn: () => api.get('/coffees/stats'),
  });
  const { data: streaks } = useQuery<StreaksResponse>({
    queryKey: ['streaks'], queryFn: () => api.get('/streaks'),
  });
  const { data: achievements = [] } = useQuery<Achievement[]>({
    queryKey: ['achievements'], queryFn: () => api.get('/achievements'),
  });

  const uniqueTypes = Object.keys(stats?.by_type ?? {}).length;

  // Milestones, their thresholds and their wording all come from the server —
  // the client only supplies the running totals to measure against. Anything
  // restated here would be a second copy free to drift (issue #30).
  const metricValues: Record<ProgressMetric, number> = {
    total_cups: stats?.total_cups ?? 0,
    total_caffeine: stats?.total_caffeine ?? 0,
    unique_types: uniqueTypes,
    day_streak: streaks?.streak?.current_streak ?? 0,
  };

  const milestones = achievements
    .filter(a => a.progress)
    .map(a => {
      const { metric, target } = a.progress!;
      const current = metricValues[metric] ?? 0;
      const pct = target > 0 ? Math.min(100, Math.round((current / target) * 100)) : 0;
      return { id: a.id, label: a.description, target, current, unlocked: a.unlocked, pct };
    });

  return (
    <div className="page">
      <AppHeader />
      <div className="page-header">
        <h2>Milestones</h2>
        <p className="page-sub">Your progress toward the big ones</p>
      </div>

      <main className="stats-tab-body">
        <div className="card">
          <div className="milestone-list">
            {milestones.map(m => (
              <div key={m.id} className={`milestone-item${m.unlocked ? ' done' : ''}`}>
                <div className="milestone-label-row">
                  <span className="milestone-label">{m.label}</span>
                  <span className="milestone-count">
                    {m.unlocked
                      ? <><Icon name="check-circle" /> Done</>
                      : `${m.current.toLocaleString()} / ${m.target.toLocaleString()}`}
                  </span>
                </div>
                <div className="ch-progress-wrap" style={{ marginBottom: 0 }}>
                  <div
                    className={`ch-progress-bar${m.unlocked ? ' milestone-done' : ''}`}
                    style={{ width: `${m.pct}%` }}
                  />
                </div>
              </div>
            ))}
            {milestones.length === 0 && (
              <div className="empty-state">No milestones yet — keep brewing.</div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
