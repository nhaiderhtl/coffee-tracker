import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAuthStore } from '../store/auth';
import { Icon } from './Icon';
import type { EnergyResponse, User } from '../types';

// Buzz — the caffeine battery. Everything shown here is derived server-side
// from the coffee log (GET /api/energy); nothing is stored, so it is always in
// sync with what the user actually posted.

const WINDOWS = [
  { hours: 24, label: '24h' },
  { hours: 168, label: '7d' },
];

// SVG user units. The viewBox is stretched to the card width, so strokes use
// vector-effect="non-scaling-stroke" to stay an even thickness.
const VB_W = 300;
const VB_H = 100;

function stateLabel(s: EnergyResponse['state']) {
  return { charging: 'Charging', draining: 'Draining', empty: 'Empty' }[s];
}

function timeLabel(t: number) {
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function dayLabel(t: number) {
  return new Date(t).toLocaleDateString([], { weekday: 'short' });
}

// "in 4h 20m" / "in 35m" for the moment the battery runs flat.
function untilLabel(from: number, to: number) {
  const mins = Math.max(0, Math.round((to - from) / 60000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// How fast caffeine leaves the body differs a lot between people (CYP1A2
// activity), so the decay half-life is per-user. Presets are phrased by how it
// feels, with the hours shown, and there is a box for anyone who knows their
// actual number. Collapsed behind a button that doubles as the current value,
// so a setting most people never touch isn't sitting open in the card.
const HALF_LIFE_PRESETS = [
  { hours: 3.5, label: 'Fast', sub: 'gone by evening' },
  { hours: 5, label: 'Normal', sub: 'most people' },
  { hours: 7, label: 'Slow', sub: 'keeps me up' },
];
const HALF_LIFE_MIN = 1.5;
const HALF_LIFE_MAX = 9.5;

function HalfLifeControl({ current }: { current: number }) {
  const qc = useQueryClient();
  const { setAuth } = useAuthStore();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(String(current));

  const mutation = useMutation({
    mutationFn: (hours: number) => api.patch<User>('/auth/me', { caffeine_half_life_h: hours }),
    onSuccess: (updated) => {
      setAuth(updated, localStorage.getItem('token')!);
      // The curve, the level and "until flat" all move with the half-life.
      qc.invalidateQueries({ queryKey: ['energy'] });
    },
  });

  function save(hours: number) {
    const clamped = Math.min(HALF_LIFE_MAX, Math.max(HALF_LIFE_MIN, hours));
    setDraft(String(clamped));
    if (clamped !== current) mutation.mutate(clamped);
  }

  // Only commit a typed value once it is a usable number; a half-finished entry
  // ("3.") should leave the stored value alone.
  function commitDraft() {
    const n = Number(draft);
    if (Number.isFinite(n) && n > 0) save(n);
    else setDraft(String(current));
  }

  return (
    <div className="buzz-hl">
      <button className="buzz-hl-btn" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        Half-life · {current}h
        <Icon name={open ? 'chevron-up' : 'chevron-down'} />
      </button>

      {open && (
        <div className="buzz-hl-panel">
          <div className="buzz-hl-presets">
            {HALF_LIFE_PRESETS.map(p => (
              <button key={p.hours}
                className={`buzz-hl-preset${current === p.hours ? ' active' : ''}`}
                onClick={() => save(p.hours)}
                disabled={mutation.isPending}>
                <span className="buzz-hl-preset-label">{p.label} · {p.hours}h</span>
                <span className="buzz-hl-preset-sub">{p.sub}</span>
              </button>
            ))}
          </div>
          <label className="buzz-hl-exact">
            <span>Know yours?</span>
            <input type="number" step="0.5" min={HALF_LIFE_MIN} max={HALF_LIFE_MAX}
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onBlur={commitDraft}
              onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
              disabled={mutation.isPending} />
            <span>h</span>
          </label>
          {mutation.isError && <div className="auth-error">{mutation.error.message}</div>}
        </div>
      )}
    </div>
  );
}

// Ticks on whole local clock hours. Minor ones are bare marks for reading a
// position off the curve; major ones are thicker and carry the axis label, and
// they are the only axis labels there are. At 7d there are 168 hours and the
// minor ticks would merge into a solid band, so each step widens until its
// marks are far enough apart — minors need room for a line, majors for text.
const HOUR_STEPS = [1, 3, 6, 12, 24];
const MIN_TICK_GAP = 5;   // viewBox user units
// Capped at 24 because getHours() only reaches 23: a larger step would silently
// mean "midnight" instead of "every other midnight". The window maxes out at
// 168 h, where 24 already clears MIN_MAJOR_GAP, so nothing bigger is needed.
const MAJOR_STEPS = [6, 12, 24];
const MIN_MAJOR_GAP = 36; // viewBox user units, room for "Mon" / "06:00"

function hourTicks(start: number, end: number) {
  const hours = (end - start) / 3600000;
  const per = (s: number) => (VB_W / hours) * s;
  const step = HOUR_STEPS.find(s => per(s) >= MIN_TICK_GAP) ?? 24;
  // Every major step is a multiple of every minor step it can pair with, so a
  // major always lands on a tick rather than between two.
  const majorStep = MAJOR_STEPS.find(s => per(s) >= MIN_MAJOR_GAP) ?? 24;

  // Walk forward to the first whole `step` hour at or after `start`. Stepping
  // with setHours (not by adding ms) keeps the ticks on the clock across a DST
  // change, which is the whole point of aligning them to hours.
  const cur = new Date(start);
  cur.setMinutes(0, 0, 0);
  while (cur.getTime() < start || cur.getHours() % step !== 0) cur.setHours(cur.getHours() + 1);

  const ticks: { t: number; major: boolean }[] = [];
  while (cur.getTime() <= end) {
    ticks.push({ t: cur.getTime(), major: cur.getHours() % majorStep === 0 });
    cur.setHours(cur.getHours() + step);
  }
  // A window short enough to contain no whole major hour would otherwise render
  // a bare axis; label what there is instead.
  if (!ticks.some(t => t.major)) for (const t of ticks) t.major = true;
  return { ticks, majorStep };
}

// Each coffee's tick carries its clock time. Two coffees close together would
// overprint on a single line, so labels stack into rows: a label takes the
// lowest row where it clears the last label already there, and a new row opens
// only once every existing one is still crowded. Nothing is dropped, and the
// bottom row is preferred but never required.
//
// How many rows that needs is a property of the data, not a constant: four
// coffees inside one MIN_LABEL_GAP need four rows. A fixed two-row cap silently
// overprinted everything past the second, which is exactly what a run like
// 09:00 / 09:05 / 09:15 / 09:20 produces.
const MIN_LABEL_GAP = 9; // % of chart width, about the width of "12:30"
const LABEL_ROW_H = 10; // px between stacked rows
const LABEL_BASE_BOTTOM = 14; // px, clears the coffee tick (12 user units tall)
const LABEL_H = 12; // px, a chip at 0.58rem/1.3
const PLOT_H = 110; // px — keep in sync with `.buzz-chart svg` in index.css
// Stack until the next row would push a chip out of the top of the plot. Past
// that there is nowhere left to go and labels have to share a row.
const MAX_LABEL_ROWS = Math.floor((PLOT_H - LABEL_BASE_BOTTOM - LABEL_H) / LABEL_ROW_H) + 1;
// Within this much of an edge a label is pinned to the border rather than
// centred on its tick: centring there would push it out of the card, and
// flipping it fully to the other side of the tick reads as the wrong tick.
const LABEL_EDGE = 4; // % of chart width

// Centred on the tick, except within LABEL_EDGE of a border, where the label
// hugs that border instead.
function labelPos(pct: number) {
  if (pct <= LABEL_EDGE) return { left: 0 };
  if (pct >= 100 - LABEL_EDGE) return { right: 0 };
  return { left: `${pct}%`, transform: 'translateX(-50%)' };
}

// `doses` arrives sorted by logged_at, so lastPct[row] is always behind the
// label being placed and one comparison per row settles it.
function doseLabels(doses: EnergyResponse['doses'], start: number, span: number) {
  const lastPct: number[] = []; // where the last label on each row ended
  return doses.map(d => {
    const pct = ((d.logged_at - start) / span) * 100;
    let row = lastPct.findIndex(p => pct - p >= MIN_LABEL_GAP);
    if (row === -1) {
      if (lastPct.length < MAX_LABEL_ROWS) {
        row = lastPct.length; // open a new row above the crowded ones
      } else {
        // Out of vertical room, so some overprint is now unavoidable. Give the
        // label to the row whose last entry is furthest back — the most space
        // available anywhere — rather than always dumping it on the bottom row.
        row = lastPct.reduce((best, p, i) => (p < lastPct[best] ? i : best), 0);
      }
    }
    lastPct[row] = pct;
    return { id: d.id, pct, row, text: timeLabel(d.logged_at) };
  });
}

function Chart({ data }: { data: EnergyResponse }) {
  const { series, doses, now, window_hours, full_mg } = data;
  const start = series[0].t;
  const span = Math.max(1, now - start);
  const x = (t: number) => ((t - start) / span) * VB_W;
  const y = (level: number) => VB_H - (level / 100) * VB_H;

  // Plot from active_mg, not from `level`. `level` is rounded to whole percent
  // for the battery readout, which is only 101 distinct heights — about 1px
  // apart on this chart — so drawing it gives a visibly stepped curve. This is
  // the same number before that rounding, capped the way levelFromMg caps it.
  const pct = (mg: number) => Math.min(100, (mg / full_mg) * 100);

  // The API reaches back past the window so old coffee still shows as residual
  // level at the left edge. Those doses have no tick position on this chart.
  const shown = doses.filter(d => d.logged_at >= start && d.logged_at <= now);
  const labels = doseLabels(shown, start, span);

  const line = series.map(p => `${x(p.t).toFixed(2)},${y(pct(p.active_mg)).toFixed(2)}`).join(' ');
  const area = `${x(start).toFixed(2)},${VB_H} ${line} ${VB_W},${VB_H}`;

  const { ticks, majorStep } = hourTicks(start, now);
  // Once the majors are a day apart the clock time on each is always 00:00, so
  // the weekday is the only part that carries information.
  const fmt = majorStep >= 24 ? dayLabel : timeLabel;

  return (
    <div className="buzz-chart">
      <div className="buzz-plot">
        <svg viewBox={`0 0 ${VB_W} ${VB_H}`} preserveAspectRatio="none" role="img"
          aria-label={`Buzz level over the last ${window_hours} hours`}>
          <defs>
            <linearGradient id="buzz-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.45" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.03" />
            </linearGradient>
          </defs>

          {/* 25 / 50 / 75% guides */}
          {[25, 50, 75].map(v => (
            <line key={v} x1="0" x2={VB_W} y1={y(v)} y2={y(v)}
              stroke="var(--grid)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          ))}

          {/* Hour marks, for reading a position off the curve. Muted rather
              than --grid (the horizontal guides) so they stay legible over the
              fill, but still clearly quieter than a coffee tick. Majors are the
              ones the axis labels below belong to, so they read as anchors. */}
          {ticks.map(m => (
            <line key={m.t} x1={x(m.t)} x2={x(m.t)} y1={VB_H} y2={VB_H - (m.major ? 11 : 5)}
              stroke="var(--text-muted)" strokeOpacity={m.major ? 0.9 : 0.5}
              strokeWidth={m.major ? 2 : 1} vectorEffect="non-scaling-stroke" />
          ))}

          {/* One tick per coffee, at the instant it was logged. Accent-coloured
              to read as an event on the curve, not as another axis mark. */}
          {shown.map(d => (
            <line key={d.id} x1={x(d.logged_at)} x2={x(d.logged_at)} y1={VB_H} y2={VB_H - 12}
              stroke="var(--accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
          ))}

          <polygon points={area} fill="url(#buzz-fill)" />
          <polyline points={line} fill="none" stroke="var(--accent)" strokeWidth="1.5"
            strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        </svg>

        {/* HTML, not SVG <text>: the viewBox is stretched to the card width and
            would squash the glyphs with it. The svg already carries the label for
            screen readers, so these are decoration on top of it. */}
        <div className="buzz-dose-labels" aria-hidden="true">
          {labels.map(l => (
            <span key={l.id} className="buzz-dose-label"
              style={{ bottom: `${LABEL_BASE_BOTTOM + l.row * LABEL_ROW_H}px`, ...labelPos(l.pct) }}>
              {l.text}
            </span>
          ))}
        </div>
      </div>
      {/* The axis is exactly the major ticks — no fixed start/middle/now marks,
          so every label sits under a mark you can actually line the curve up
          against. Positioned to match those ticks, hence absolute. */}
      <div className="buzz-axis" aria-hidden="true">
        {ticks.filter(m => m.major).map(m => (
          <span key={m.t} className="buzz-axis-label"
            style={labelPos((x(m.t) / VB_W) * 100)}>{fmt(m.t)}</span>
        ))}
      </div>
    </div>
  );
}

export function BuzzWidget() {
  const [hours, setHours] = useState(24);
  const { data, isLoading, error } = useQuery<EnergyResponse>({
    queryKey: ['energy', hours],
    queryFn: () => api.get(`/energy?hours=${hours}`),
  });

  return (
    <div className="card buzz-card">
      <div className="buzz-head">
        <div className="section-label">Buzz</div>
        <div className="buzz-range">
          {WINDOWS.map(w => (
            <button key={w.hours}
              className={`buzz-range-btn${hours === w.hours ? ' active' : ''}`}
              onClick={() => setHours(w.hours)}>{w.label}</button>
          ))}
        </div>
      </div>

      {isLoading && <div className="profile-placeholder-body">Loading…</div>}
      {error && <div className="auth-error">{error.message}</div>}

      {data && (
        <>
          <div className="buzz-readout">
            <div className="buzz-gauge">
              <div className={`buzz-gauge-fill buzz-${data.state}`} style={{ width: `${data.level}%` }} />
            </div>
            <div className="buzz-figure">
              <span className="buzz-level">{data.level}%</span>
              <span className={`buzz-state buzz-${data.state}`}>
                <Icon name={data.state === 'charging' ? 'bolt' : 'battery'} /> {stateLabel(data.state)}
              </span>
            </div>
          </div>

          <Chart data={data} />

          <div className="buzz-facts">
            <div className="buzz-fact">
              <span className="buzz-fact-val">{Math.round(data.active_mg)} mg</span>
              <span className="buzz-fact-key">active now</span>
            </div>
            <div className="buzz-fact">
              <span className="buzz-fact-val">{data.peak.level}%</span>
              <span className="buzz-fact-key">peak this window</span>
            </div>
            <div className="buzz-fact">
              <span className="buzz-fact-val">
                {data.empty_at ? untilLabel(data.now, data.empty_at) : '—'}
              </span>
              <span className="buzz-fact-key">until flat</span>
            </div>
          </div>

          <p className="buzz-note">
            100% = {data.full_mg} mg of caffeine active in your body, halving every{' '}
            {data.half_life_h} hours.
          </p>

          <HalfLifeControl current={data.half_life_h} />
        </>
      )}
    </div>
  );
}
