import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuthStore } from '../store/auth';
import { AppHeader } from '../components/AppHeader';
import { Icon } from '../components/Icon';
import { CompareContent } from './Compare';
import type {
  StreaksResponse,
  RankingEntry, Stats as StatsData,
} from '../types';

// ── Shared helpers ────────────────────────────────────────────────────────────

interface RankingsResponse { rankings: RankingEntry[]; my_rank: RankingEntry | null; }

type Tab = 'rankings' | 'compare';

// ── Tab: Rankings ─────────────────────────────────────────────────────────────

function RankingsTab() {
  const [period, setPeriod] = useState<'daily' | 'weekly' | 'alltime'>('weekly');
  const navigate = useNavigate();
  const { user } = useAuthStore();

  const { data, isLoading } = useQuery<RankingsResponse>({
    queryKey: ['rankings', period],
    queryFn: () => api.get(`/rankings?period=${period}`),
    refetchInterval: 60000,
  });

  const { data: casualties } = useQuery({
    queryKey: ['casualties'], queryFn: () => api.get<{ global_count: number; heart_attack_risk: number; disclaimer: string }>('/casualties'), refetchInterval: 30000,
  });
  const risk = (casualties as any)?.heart_attack_risk ?? 0;
  const riskColor = risk < 20 ? '#4CAF50' : risk < 45 ? '#FF9800' : risk < 70 ? '#FF5722' : '#E53935';

  return (
    <div className="stats-tab-body">
      <div className="card casualties-card">
        <div className="section-label"><Icon name="skull" /> Coffee Casualties This Month</div>
        <div className="casualties-count">{((casualties as any)?.global_count ?? 0).toLocaleString()}</div>
        <div className="casualties-sub">fellow caffeine enthusiasts who crossed the 400mg threshold</div>
        <div className="casualties-disclaimer"><Icon name="warning" /> Entertainment only. Not real medical data.</div>
        <div className="risk-section">
          <div className="risk-label">Your Heart Attack Risk Today™</div>
          <div className="risk-bar-wrap">
            <div className="risk-bar" style={{ width: `${risk}%`, backgroundColor: riskColor }} />
          </div>
          <div className="risk-value" style={{ color: riskColor }}>
            {risk}% — {risk < 10 ? 'Your heart is fine' : risk < 30 ? 'Getting caffeinated' : risk < 50 ? 'Heart says slow down' : risk < 75 ? 'Doctor on speed dial' : 'Please drink water'}
          </div>
          <div className="risk-disclaimer">(For entertainment only. Please do not call an ambulance.)</div>
        </div>
      </div>

      <div className="tab-row">
        {(['daily', 'weekly', 'alltime'] as const).map(p => (
          <button key={p} className={`tab-btn${period === p ? ' active' : ''}`} onClick={() => setPeriod(p)}>
            {p === 'daily' ? 'Today' : p === 'weekly' ? 'This Week' : 'All Time'}
          </button>
        ))}
      </div>

      {data?.my_rank && (
        <div className="card my-rank-card">
          <div className="my-rank-label">Your rank</div>
          <div className="my-rank-row">
            <div className="rank-num">{data.my_rank.matches === 0 ? '—' : `#${data.my_rank.rank}`}</div>
            <div className="rank-user">
              <span className="rank-avatar">{data.my_rank.avatar}</span>
              <span className="rank-username">{data.my_rank.username}</span>
            </div>
            <div className="rank-stats">
              <span className="rank-caf">{Math.round(data.my_rank.rating)} Elo</span>
              <span>{data.my_rank.cups} cups · {data.my_rank.total_caffeine}mg</span>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <div className="section-label">Elo Ladder</div>
        {isLoading ? <div className="load-text">Loading…</div> : (
          <div className="leaderboard">
            {(data?.rankings ?? []).map((r, i) => (
              <div key={r.id} className={`lb-row${r.id === user?.id ? ' me' : ''}`}
                onClick={() => r.id !== user?.id && navigate(`/compare/${r.username}`)}
                style={{ cursor: r.id !== user?.id ? 'pointer' : 'default' }}>
                {/* Unrated players (no settled match) sort last and show no rank
                    — a medal or #n would imply they earned the spot. */}
                <div className="lb-rank">{r.matches === 0 ? '—' : i < 3 ? <Icon name="medal" className={`lb-medal lb-medal-${i}`} /> : `#${r.rank}`}</div>
                <div className="lb-user">
                  <span className="lb-avatar">{r.avatar}</span>
                  <span className="lb-userinfo">
                    <span className="lb-username">{r.username}</span>
                    <span className="lb-substat">{r.group_name ?? 'No group'} · {r.cups} cups · {r.total_caffeine}mg</span>
                  </span>
                </div>
                <div className="lb-stats">
                  <span className="lb-caf">{Math.round(r.rating)}</span>
                  <span>Elo</span>
                </div>
              </div>
            ))}
            {(data?.rankings ?? []).length === 0 && <div className="load-text">No data yet. Be the first to brew!</div>}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main Stats page ───────────────────────────────────────────────────────────

export function Stats() {
  const [activeTab, setActiveTab] = useState<Tab>('rankings');

  const { data: stats } = useQuery<StatsData>({
    queryKey: ['stats'], queryFn: () => api.get('/coffees/stats'), refetchInterval: 30000,
  });
  const { data: streaks } = useQuery<StreaksResponse>({
    queryKey: ['streaks'], queryFn: () => api.get('/streaks'),
  });
  const { data: alltimeRank } = useQuery<RankingsResponse>({
    queryKey: ['rankings', 'alltime'], queryFn: () => api.get('/rankings?period=alltime'),
  });

  const todayCaf = stats?.today_caffeine || 0;
  const pct = todayCaf / 400;
  const safeColor = !todayCaf ? 'var(--text-muted)' : pct < 0.75 ? '#4CAF50' : pct < 1 ? '#FF9800' : '#E53935';

  const TABS: { id: Tab; label: string; icon: string }[] = [
    { id: 'rankings',   label: 'Rankings',   icon: 'trophy' },
    { id: 'compare',    label: 'Compare',    icon: 'scale' },
  ];

  return (
    <div className="page">
      <AppHeader />

      <div className="page-header">
        <h2>Stats</h2>
        <p className="page-sub">Your coffee journey at a glance</p>
      </div>

      {/* Top hero — global rank, streak, daily stats */}
      <div className="stats-hero">
        <div className="stats-hero-top">
          <div className="stats-rank-tile">
            <div className="stats-rank-num">
              {alltimeRank?.my_rank && alltimeRank.my_rank.matches > 0 ? `#${alltimeRank.my_rank.rank}` : '—'}
            </div>
            <div className="stats-rank-label">Global Rank</div>
          </div>
          <div className="stats-streak-tile">
            <div className="stats-streak-num">{streaks?.streak?.current_streak ?? 0} <Icon name="fire" /></div>
            <div className="stats-streak-label">Day Streak</div>
          </div>
        </div>

        <div className="hero-row" style={{ margin: 0 }}>
          <div className="hero-tile">
            <div className="hero-value">{stats?.today_cups ?? 0}</div>
            <div className="hero-label">Today's cups</div>
          </div>
          <div className="hero-tile">
            <div className="hero-value" style={{ color: safeColor }}>{todayCaf}mg</div>
            <div className="hero-label">Caffeine today</div>
          </div>
          <div className="hero-tile">
            <div className="hero-value">{stats?.seven_day_avg ?? '0.0'}</div>
            <div className="hero-label">7-day avg</div>
          </div>
        </div>
      </div>

      {/* Tab navigation */}
      <div className="stats-tabs">
        {TABS.map(t => (
          <button key={t.id} className={`stats-tab-btn${activeTab === t.id ? ' active' : ''}`} onClick={() => setActiveTab(t.id)}>
            <span><Icon name={t.icon} /></span> {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'rankings' && <RankingsTab />}
      {activeTab === 'compare'  && <div className="stats-tab-body"><CompareContent /></div>}
    </div>
  );
}
