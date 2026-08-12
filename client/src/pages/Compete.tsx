import { useState, useRef, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, LayoutGroup, motion } from 'motion/react';
import { DayPicker, type DateRange } from 'react-day-picker';
import 'react-day-picker/style.css';
import { api } from '../api/client';
import { AppHeader } from '../components/AppHeader';
import { ResponsiveImage } from '../components/ResponsiveImage';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Icon } from '../components/Icon';
import { BadgeRow } from '../components/Badge';
import { TimezonePicker } from '../components/TimezonePicker';
import { useAuthStore } from '../store/auth';
import type {
  CompeteScope, CompetitionsResponse, CompetitionHistoryResponse, GroupsResponse, GroupDetailResponse,
  LeaderboardEntry, LeaderboardResponse, Match, MatchMode, MatchParticipant, PersonalHistoryEntry, User, ImageField,
} from '../types';

// Global vs Group is the top-level split (issue #53): it scopes WHICH matches,
// players and history the page is about. Rating itself is one global number and
// is deliberately identical in both scopes.
type Section = 'matches' | 'ranking' | 'history' | 'preferences';

const SECTIONS: Record<CompeteScope, { id: Section; label: string }[]> = {
  global: [
    { id: 'matches', label: 'Matches' },
    { id: 'ranking', label: 'Ranking' },
    { id: 'history', label: 'History' },
    // Community challenges used to sit here (issue #51) but nothing about a
    // shared cooperative target is competitive — they are their own page at
    // /challenges now (issue #63).
  ],
  // Auto-join and the group's own settings are the only preferences that exist,
  // and both are group-scoped — hence no Preferences section under Global.
  group: [
    { id: 'matches', label: 'Matches' },
    { id: 'ranking', label: 'Ranking' },
    { id: 'history', label: 'History' },
    { id: 'preferences', label: 'Preferences' },
  ],
};

export const MODE_LABEL: Record<MatchMode, string> = {
  daily: 'Daily', weekly: 'Weekly', ondemand: 'Free-for-all', '1v1': '1v1',
};

export const MODE_ICON: Record<MatchMode, string> = {
  daily: 'calendar', weekly: 'calendar', ondemand: 'bolt', '1v1': 'scale',
};

// Modes a player can open themselves. daily and weekly are opened by the server
// for the whole group, on its own schedule.
const USER_MODES: MatchMode[] = ['1v1', 'ondemand'];

const HOUR = 3600000;

// A once-a-second clock so cards re-render as their scheduled start/end instants
// pass, without waiting for the 60s data refetch. This is what lets the client
// predict a match's next state the moment it is due (issue #65): the server
// still owns the real transition, the tick only keeps the displayed prediction
// honest between refetches.
function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function fmtDateTime(ts: number) {
  return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// Coarse "in 3h" / "2d ago". Duration arithmetic only — no timezone involved.
function fmtRelative(ts: number, now = Date.now()) {
  const diff = ts - now;
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  let value: string;
  if (mins < 1) value = 'less than a minute';
  else if (mins < 60) value = `${mins}m`;
  else if (abs < 48 * HOUR) value = `${Math.round(abs / HOUR)}h`;
  else value = `${Math.round(abs / (24 * HOUR))}d`;
  return diff >= 0 ? `in ${value}` : `${value} ago`;
}

function fmtRating(rating: number) {
  return Math.round(rating);
}

function fmtDelta(delta: number | null) {
  if (delta === null || delta === undefined) return '—';
  const rounded = Math.round(delta * 10) / 10;
  return `${rounded > 0 ? '+' : ''}${rounded}`;
}

function deltaClass(delta: number | null) {
  if (delta === null || delta === undefined || Math.abs(delta) < 0.05) return 'cmp-delta';
  return delta > 0 ? 'cmp-delta up' : 'cmp-delta down';
}

// datetime-local speaks the device's wall clock, which is exactly what the user
// means when they type a start time. Convert at the edge; the API only ever
// sees epoch ms.
function toLocalInput(ts: number) {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Visibility switch for a group. Same control as everything else in the app.
function PublicToggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <ToggleRow
      label="Listed publicly"
      sub="Anyone can find and join"
      value={value}
      onChange={onChange}
    />
  );
}

// Generic toggle row, matching the log form and the Profile debug card.
function ToggleRow({ label, sub, value, onChange, disabled }: {
  label: string; sub: string; value: boolean; onChange: (v: boolean) => void; disabled?: boolean;
}) {
  return (
    <div className="log-share-row">
      <div>
        <div className="log-share-label">{label}</div>
        <div className="log-share-sub">{sub}</div>
      </div>
      <button
        className={`log-toggle${value ? ' on' : ''}`}
        onClick={() => onChange(!value)}
        aria-pressed={value}
        aria-label={label}
        disabled={disabled}
      >
        <span className="log-toggle-knob" />
      </button>
    </div>
  );
}

// Circular single-letter day toggles. This list is in fixed Monday..Sunday
// order and each column carries its own bit (bit0 = Mon ... bit6 = Sun), so the
// mask stays Monday-anchored to match the weekly window and the server. The
// COLUMN order shown to the user is a locale rotation of this list
// (ORDERED_WEEKDAY_CELLS below), so Monday is not necessarily the first column.
const WEEKDAY_CELLS = [
  { label: 'M', bit: 0, name: 'Monday' },
  { label: 'T', bit: 1, name: 'Tuesday' },
  { label: 'W', bit: 2, name: 'Wednesday' },
  { label: 'T', bit: 3, name: 'Thursday' },
  { label: 'F', bit: 4, name: 'Friday' },
  { label: 'S', bit: 5, name: 'Saturday' },
  { label: 'S', bit: 6, name: 'Sunday' },
];

// First day of the week for the viewer's locale, as react-day-picker's
// weekStartsOn (0 = Sun ... 6 = Sat). Storage/scoring stay Monday-anchored — this
// only rotates what the user sees. Falls back to Monday where Intl weekInfo is
// unavailable.
function localeWeekStartsOn(): 0 | 1 | 2 | 3 | 4 | 5 | 6 {
  try {
    const loc = new Intl.Locale(navigator.language) as Intl.Locale & {
      weekInfo?: { firstDay?: number };
      getWeekInfo?: () => { firstDay?: number };
    };
    const first = (loc.getWeekInfo?.() ?? loc.weekInfo)?.firstDay; // ISO: 1 = Mon ... 7 = Sun
    if (first) return (first % 7) as 0 | 1 | 2 | 3 | 4 | 5 | 6;
  } catch { /* Intl.Locale weekInfo not supported — keep Monday */ }
  return 1;
}
const WEEK_STARTS_ON = localeWeekStartsOn();
// WEEKDAY_CELLS rotated so the viewer's first weekday leads. (weekStartsOn + 6) % 7
// converts the date-fns dow (0 = Sun) to this list's Monday-anchored index.
const ORDERED_WEEKDAY_CELLS = WEEKDAY_CELLS.map(
  (_, i) => WEEKDAY_CELLS[((WEEK_STARTS_ON + 6) % 7 + i) % 7],
);
function WeekdayPicker({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="cmp-weekday-row" role="group" aria-label="Active days">
      {ORDERED_WEEKDAY_CELLS.map(({ label, bit, name }) => {
        const on = (value & (1 << bit)) !== 0;
        return (
          <button
            key={name}
            type="button"
            className={`cmp-weekday${on ? ' on' : ''}`}
            aria-pressed={on}
            aria-label={name}
            onClick={() => onChange(value ^ (1 << bit))}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

// Civil date <-> string, using the LOCAL calendar fields only (never a UTC
// parse), so a YYYY-MM-DD round-trips unshifted regardless of browser zone. The
// pause is a set of civil dates, so no instant/zone conversion belongs here.
function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function parseYmd(s: string) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function fmtDate(s: string) {
  return parseYmd(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Pause control (issue #18): a trigger row that opens a modal calendar rather
// than leaving the grid sitting in the form. from/to are civil-date strings;
// empty = not paused.
function PausePicker({ from, to, onChange }: {
  from: string; to: string; onChange: (from: string, to: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const set = !!from;
  return (
    <>
      <button type="button" className="cmp-pause-row" onClick={() => setOpen(true)}>
        <span className="cmp-pause-row-label">
          <Icon name="clock" size={16} />
          {set ? (to && to !== from ? `${fmtDate(from)} – ${fmtDate(to)}` : fmtDate(from)) : 'Pause schedule'}
        </span>
        {set
          ? <span className="cmp-pause-x" role="button" aria-label="Cancel pause"
                  onClick={e => { e.stopPropagation(); onChange('', ''); }}><Icon name="close" size={16} /></span>
          : <span className="cmp-pause-add" aria-hidden="true"><Icon name="plus" size={16} /></span>}
      </button>
      {open && (
        <PauseDialog
          from={from}
          to={to}
          onCancel={() => setOpen(false)}
          onSave={(f, t) => { onChange(f, t); setOpen(false); }}
        />
      )}
    </>
  );
}

// The modal: pick a start then an end on one month grid, OK commits, Cancel or
// the backdrop discards. Range lives in draft state so a cancel changes nothing.
function PauseDialog({ from, to, onCancel, onSave }: {
  from: string; to: string; onCancel: () => void; onSave: (from: string, to: string) => void;
}) {
  const [range, setRange] = useState<DateRange | undefined>(
    from ? { from: parseYmd(from), to: to ? parseYmd(to) : undefined } : undefined,
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onCancel(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const f = range?.from ? ymd(range.from) : '';
  const t = range?.to ? ymd(range.to) : '';
  const header = f && t ? `${fmtDate(f)} – ${fmtDate(t)}` : f ? fmtDate(f) : 'Select dates';

  return (
    <div className="confirm-backdrop" onClick={onCancel} role="dialog" aria-modal="true" aria-label="Pause dates">
      <div className="confirm-box cmp-pause-box" onClick={e => e.stopPropagation()}>
        <div className="cmp-pause-head">Select the dates to pause</div>
        <div className="cmp-pause-range">{header}</div>
        <DayPicker
          mode="range"
          weekStartsOn={WEEK_STARTS_ON}
          defaultMonth={range?.from ?? new Date()}
          selected={range}
          onSelect={setRange}
          formatters={{ formatWeekdayName: (d) => d.toLocaleDateString(undefined, { weekday: 'narrow' }) }}
        />
        <div className="cmp-pause-actions">
          <button type="button" className="cmp-pause-text" onClick={onCancel}>Cancel</button>
          {/* A single tap is a one-day pause: from with no to. */}
          <button type="button" className="cmp-pause-text cmp-pause-ok" onClick={() => onSave(f, f && !t ? f : t)}>OK</button>
        </div>
      </div>
    </div>
  );
}

// The only mechanism that puts a player on a recurring roster without them
// pressing join. Off by default, per user, and it only affects matches opened
// after it is switched on — an already-open lobby still has to be joined.
function AutoJoinCard() {
  const user = useAuthStore(s => s.user);
  const token = useAuthStore(s => s.token);
  const setAuth = useAuthStore(s => s.setAuth);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (body: { auto_join_daily?: boolean; auto_join_weekly?: boolean }) =>
      api.patch<User>('/auth/me', body),
    onSuccess: (updated) => { if (token) setAuth(updated, token); },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <div className="card cmp-form">
      <div className="section-label">Auto-join</div>
      <ToggleRow
        label="Daily matches"
        sub="Join every daily automatically"
        value={user?.auto_join_daily === 1}
        disabled={save.isPending}
        onChange={v => { setError(null); save.mutate({ auto_join_daily: v }); }}
      />
      <ToggleRow
        label="Weekly matches"
        sub="Join every weekly automatically"
        value={user?.auto_join_weekly === 1}
        disabled={save.isPending}
        onChange={v => { setError(null); save.mutate({ auto_join_weekly: v }); }}
      />
      <div className="field-hint">Applies to matches opened from now on.</div>
      {error && <div className="auth-error">{error}</div>}
    </div>
  );
}

// Copy `text`, reporting whether it actually worked.
//
// navigator.clipboard only exists in a SECURE CONTEXT. Served over plain http
// on a LAN address — which is how this app gets opened on a phone during
// development — it is undefined, so it cannot be the only path. The deprecated
// execCommand route still works there and is the fallback.
async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch { /* blocked or unavailable — try the fallback */ }
  }
  try {
    const field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    // Off-screen but still focusable: display:none or visibility:hidden would
    // make the selection (and so the copy) fail.
    field.style.position = 'fixed';
    field.style.top = '0';
    field.style.opacity = '0';
    document.body.appendChild(field);
    field.focus();
    field.select();
    field.setSelectionRange(0, text.length); // iOS ignores select() alone
    const ok = document.execCommand('copy');
    document.body.removeChild(field);
    return ok;
  } catch {
    return false;
  }
}

function selectElementText(el: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(el);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

// The invite code, with a copy button. State is never assumed: the tick only
// appears once a copy actually succeeded, and if both routes fail the code is
// selected instead so it can still be copied by hand.
function InviteCode({ code }: { code: string }) {
  const valueRef = useRef<HTMLSpanElement>(null);
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  async function copy() {
    const ok = await copyText(code);
    if (!ok && valueRef.current) selectElementText(valueRef.current);
    setState(ok ? 'copied' : 'failed');
    setTimeout(() => setState('idle'), 2500);
  }

  return (
    <>
      <div className="cmp-code">
        <span className="cmp-code-label">Invite code</span>
        <span className="cmp-code-value" ref={valueRef}>{code}</span>
        <button
          className="cmp-copy-btn"
          onClick={copy}
          aria-label={state === 'copied' ? 'Copied' : 'Copy invite code'}
        >
          <Icon name={state === 'copied' ? 'check' : 'copy'} size={15} />
        </button>
      </div>
      {state === 'failed' && <div className="field-hint">Selected — long-press to copy.</div>}
    </>
  );
}

function Avatar({ p }: { p: { avatar: string; profile_photo_url: string | null; profile_image?: ImageField | null; username: string } }) {
  return p.profile_image || p.profile_photo_url
    ? <ResponsiveImage className="cmp-avatar-img" image={p.profile_image} fallback={p.profile_photo_url} alt="" sizes="40px" />
    : <span className="cmp-avatar">{p.avatar}</span>;
}

/* ── standings ─────────────────────────────────────────────────────────────── */

function Standing({ p, settled, rank }: { p: MatchParticipant; settled: boolean; rank: number }) {
  const navigate = useNavigate();
  return (
    <div className="cmp-standing">
      <span className="cmp-standing-rank">{rank}</span>
      <Avatar p={p} />
      <span
        className="cmp-standing-name cmp-name-link"
        role="button" tabIndex={0}
        onClick={() => navigate(`/u/${p.username}`)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(`/u/${p.username}`); } }}
      >{p.username}</span>
      {/* Badges travel with the profile (issue #80). */}
      <BadgeRow badges={p.badges} size={16} />
      <span className="cmp-standing-points">{p.points} pts</span>
      {settled
        ? <span className={deltaClass(p.delta)}>{fmtDelta(p.delta)}</span>
        : <span className="cmp-standing-rating">{fmtRating(p.current_rating)}</span>}
    </div>
  );
}

function MatchStandings({ match }: { match: Match }) {
  const settled = match.state === 'settled';

  return (
    <div className="cmp-standings">
      {match.participants.map((p, i) => (
        <Standing key={p.user_id} p={p} settled={settled} rank={i + 1} />
      ))}
      {/* A lobby nobody has joined would otherwise render an empty gap. */}
      {match.participants.length === 0 && (
        <div className="cmp-side-empty">Nobody in the pot — be the first.</div>
      )}
    </div>
  );
}

// A small warning marker with a popover on a match card whose ledger was
// rewritten by a replay (recomputed_at set). Same interaction as the badge info
// popover (InfoBadge in Badge.tsx) and reuses its `.badge-popover` styling, so
// hover (mouse, 300ms), tap-to-toggle, and outside/Escape-to-close all behave
// identically and the edge-safe positioning is maintained in one place.
function InfoMarker({ text }: { text: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const clearTimer = () => { if (timer.current) { clearTimeout(timer.current); timer.current = undefined; } };

  // A tap elsewhere, or Escape, closes it — a touch user has no hover to leave.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: Event) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  useEffect(() => clearTimer, []);

  // Hover is mouse-only (touch also fires synthetic enter/leave, which would
  // open-then-close a tap); touch goes through the click toggle instead.
  function handleEnter(e: React.PointerEvent) {
    if (e.pointerType !== 'mouse') return;
    clearTimer();
    timer.current = setTimeout(() => setOpen(true), 300);
  }
  function handleLeave(e: React.PointerEvent) {
    if (e.pointerType !== 'mouse') return;
    clearTimer();
    setOpen(false);
  }
  function handleClick(e: React.MouseEvent) {
    e.stopPropagation();
    clearTimer();
    setOpen(o => !o);
  }

  return (
    <span className="cmp-info" ref={ref} onPointerEnter={handleEnter} onPointerLeave={handleLeave}>
      <button
        type="button"
        className="cmp-info-btn"
        aria-label="Why this match changed"
        aria-expanded={open}
        onClick={handleClick}
      >
        <Icon name="warning" size={13} />
      </button>
      {open && <span className="badge-popover cmp-info-pop" role="tooltip">{text}</span>}
    </span>
  );
}

/* ── one match card ────────────────────────────────────────────────────────── */

export function MatchCard({ match, now, onJoin, onLeave, busy }: {
  match: Match;
  // The parent's single ticking clock (issue #65). One clock for the whole list
  // so a card's predicted state and the section it is bucketed into can never
  // disagree by a boundary second.
  now: number;
  onJoin?: () => void;
  onLeave?: () => void;
  busy?: boolean;
}) {
  const userId = useAuthStore(s => s.user?.id);
  const inMatch = match.participants.some(p => p.user_id === userId);
  const started = match.scope_start <= now;
  const ended = match.scope_end <= now;
  const isDone = match.state === 'settled' || match.state === 'cancelled' || match.state === 'invalidated';

  // Transitions the client predicts while the server's scheduler is still catching
  // up (issue #65). Both are shown with a spinning pill so it reads as "moving",
  // and both are corrected on the next refetch once the server actually commits.
  //
  // settling: its window has ended but it is not settled yet — it WILL settle
  //   regardless of mode, so predict 'settled' and drop the broken "Ends … ago"
  //   wording. This is the state that used to read "Ended in less than a minute".
  // locking: a non-weekly lobby whose start passed but that is not locked yet.
  //   A weekly stays a genuine, joinable lobby through its first day (issue #44),
  //   so it is never treated as locking — its start passing is not a server lag.
  const settling = (match.state === 'pending' || match.state === 'open') && ended;
  const locking = match.state === 'open' && started && !ended && match.mode !== 'weekly';

  // Running: window started, not yet ended, not done. Drives the "live" badge and
  // the "Ends …" line so a running match never shows an "open" badge or a
  // "Starts …" time while it sits in the Live now section.
  const isRunning = (match.state === 'pending' || match.state === 'open') && started && !ended;
  const isLobby = match.state === 'open' && !ended;
  const transitioning = settling || locking;

  const pillClass = settling ? 'settled' : (isRunning || locking) ? 'pending' : match.state;
  const pillLabel = settling ? 'settling' : (isRunning || locking) ? 'live' : match.state;

  return (
    // layoutId lets Motion slide this exact card between sections when the client
    // repredicts its state (waiting → live → finished, issue #65) instead of
    // snapping. layout="position" animates only the card's position, not its
    // size: when a row is added/removed (e.g. the join button) the height snaps
    // and neighbours slide, instead of Motion scaleY-squashing the whole card
    // from its old height to the new one. It also avoids the scale-vs-layout
    // transform conflict with the enter/exit scale below.
    // Enter/exit fade+scale is driven by the AnimatePresence around each list.
    <motion.div
      className="card cmp-match"
      layout="position"
      layoutId={match.id}
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
    >
      <div className="cmp-match-head">
        <span className="cmp-mode">
          <Icon name={MODE_ICON[match.mode]} size={13} /> {MODE_LABEL[match.mode]}
        </span>
        {match.title && <span className="cmp-match-title">{match.title}</span>}
        {match.recomputed_at != null && (
          <InfoMarker text="This match's rating was recalculated after a match was invalidated." />
        )}
        <span className={`cmp-state ${pillClass}`}>
          {transitioning && <Icon name="spinner" size={10} className="cmp-state-spin" />}
          {pillLabel}
        </span>
      </div>

      <div className="cmp-match-when">
        {isDone
          ? <>{fmtDateTime(match.scope_start)} — {fmtDateTime(match.scope_end)}</>
          : settling
            ? <>Ending… · {fmtDateTime(match.scope_end)}</>
            : isRunning
              ? <>Ends {fmtRelative(match.scope_end, now)} · {fmtDateTime(match.scope_end)}</>
              : <>Starts {fmtRelative(match.scope_start, now)} · {fmtDateTime(match.scope_start)}</>}
      </div>

      {match.state === 'cancelled' ? (
        <div className="cmp-cancelled">Cancelled — too few players. No rating moved.</div>
      ) : (
        <MatchStandings match={match} />
      )}

      {/* Collapse the actions row by animating its OWN height, so the card's
          height reduces for real instead of the box being scaled. marginTop
          cancels the parent's 10px flex gap as it collapses, so no residual gap
          is left behind. layout="position" on the card then just slides the
          neighbours up. */}
      <AnimatePresence initial={false}>
        {isLobby && (
          <motion.div
            key="lobby"
            className="cmp-lobby-actions"
            style={{ overflow: 'hidden' }}
            initial={{ height: 0, opacity: 0, marginTop: -10 }}
            animate={{ height: 'auto', opacity: 1, marginTop: 0 }}
            exit={{ height: 0, opacity: 0, marginTop: -10 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
          >
            {inMatch ? (
              <button className="btn-secondary" disabled={busy} onClick={() => onLeave && onLeave()}>
                Leave match
              </button>
            ) : (
              <button
                className="btn-primary"
                disabled={busy || (match.mode === '1v1' && match.participant_count >= 2)}
                onClick={() => onJoin && onJoin()}
              >
                {/* Once the window has opened the lobby is still joinable but the
                    match is already starting/running, so the label makes the
                    urgency explicit instead of reading like a normal open lobby. */}
                {match.mode === '1v1' && match.participant_count >= 2
                  ? 'Match is full'
                  : started ? 'Join last minute' : 'Join match'}
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

/* ── new match form ────────────────────────────────────────────────────────── */

function NewMatchForm({ onDone, global = false }: { onDone: () => void; global?: boolean }) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<MatchMode>('1v1');
  const [title, setTitle] = useState('');
  // Default to a match that opens in an hour and runs for a day: long enough
  // for people to actually see the lobby and join it.
  const [start, setStart] = useState(() => toLocalInput(Date.now() + HOUR));
  const [end, setEnd] = useState(() => toLocalInput(Date.now() + 25 * HOUR));
  const [error, setError] = useState<string | null>(null);
  const [joinCode, setJoinCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const create = useMutation({
    mutationFn: () => api.post<{ match: Match }>('/competitions', {
      mode,
      title: title.trim() || null,
      scope_start: new Date(start).getTime(),
      scope_end: new Date(end).getTime(),
      ...(global ? { global: true } : {}),
    }),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['competitions'] });
      if (data?.match?.join_code) {
        setJoinCode(data.match.join_code);
      } else {
        onDone();
      }
    },
    onError: (e: Error) => setError(e.message),
  });

  if (joinCode) {
    return (
      <div className="card cmp-form">
        <div className="section-label">Match created!</div>
        <p className="field-hint">Share this code with your opponent — they'll need it to join.</p>
        <div className="cmp-join-code-display">
          <span className="cmp-join-code">{joinCode}</span>
          <button
            className="btn-secondary cmp-copy-btn"
            onClick={async () => { await copyText(joinCode); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
          >
            {copied ? <Icon name="check-circle" size={14} /> : <Icon name="copy" size={14} />}
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
        <button className="btn-primary" style={{ marginTop: 8 }} onClick={onDone}>Done</button>
      </div>
    );
  }

  return (
    <div className="card cmp-form">
      <div className="section-label">New match</div>

      <div className="cmp-mode-picker">
        {USER_MODES.map(m => (
          <button
            key={m}
            className={`cmp-mode-opt${mode === m ? ' active' : ''}`}
            onClick={() => setMode(m)}
          >
            <Icon name={MODE_ICON[m]} size={14} /> {MODE_LABEL[m]}
          </button>
        ))}
      </div>

      <div className="field">
        <label htmlFor="cmp-title">Title (optional)</label>
        <input
          id="cmp-title" className="search-input" value={title} maxLength={60}
          placeholder="Friday showdown" onChange={e => setTitle(e.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="cmp-start">Starts</label>
        <input id="cmp-start" className="search-input" type="datetime-local" value={start} onChange={e => setStart(e.target.value)} />
        <div className="field-hint">Open to join until it starts.</div>
      </div>

      <div className="field">
        <label htmlFor="cmp-end">Ends</label>
        <input id="cmp-end" className="search-input" type="datetime-local" value={end} onChange={e => setEnd(e.target.value)} />
        <div className="field-hint">Max 90 days. Settles when it ends.</div>
      </div>

      {global && <div className="field-hint"><Icon name="lock" size={12} /> Match is private — your opponent joins with the code you'll receive after creating.</div>}

      {error && <div className="auth-error">{error}</div>}

      <div className="cmp-form-actions">
        <button className="btn-primary" disabled={create.isPending} onClick={() => { setError(null); create.mutate(); }}>
          {create.isPending ? 'Creating…' : 'Create match'}
        </button>
        <button className="btn-secondary" onClick={onDone}>Cancel</button>
      </div>
    </div>
  );
}

/* ── tabs ──────────────────────────────────────────────────────────────────── */

function RatingCard({ rating, matches }: { rating: number; matches: number }) {
  return (
    <div className="cmp-rating-card card">
      <div className="cmp-rating-num">{fmtRating(rating)}</div>
      <div className="cmp-rating-label">
        Your rating · {matches} {matches === 1 ? 'match' : 'matches'} settled
      </div>
    </div>
  );
}

// The open/live/settled match columns, shared by the group tab and the global
// tab. `global` only changes the creation flag and the empty-state copy —
// join/leave and the rating cache are the same for both (issue #35).
//
// `finished` shows the settled column. The group tab turns it off because its
// finished matches live in the History tab instead (issue #34); the global tab
// has no history pill, so it keeps its own finished list inline.
function JoinByCodeCard({ onSuccess }: { onSuccess: () => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const join = useMutation({
    mutationFn: () => api.post<{ match: Match }>('/competitions/join-by-code', { code: code.trim().toUpperCase() }),
    onSuccess,
    onError: (e: Error) => setError(e.message),
  });
  return (
    <div className="card cmp-form">
      <div className="section-label"><Icon name="lock" size={14} /> Join a private match</div>
      <div className="field">
        <input
          className="search-input"
          value={code}
          onChange={e => setCode(e.target.value.toUpperCase())}
          placeholder="Enter 6-character code"
          maxLength={6}
        />
      </div>
      {error && <div className="auth-error">{error}</div>}
      <button
        className="btn-primary"
        onClick={() => { setError(null); join.mutate(); }}
        disabled={!code.trim() || join.isPending}
      >
        {join.isPending ? 'Joining…' : 'Join by code'}
      </button>
    </div>
  );
}

function MatchList({ open, live, settled, global = false, finished = true }: {
  open: Match[]; live: Match[]; settled: Match[]; global?: boolean; finished?: boolean;
}) {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [joiningByCode, setJoiningByCode] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ['competitions'] });

  const join = useMutation({
    mutationFn: (id: string) => api.post(`/competitions/${id}/join`),
    onSuccess: refresh,
    onError: (e: Error) => setError(e.message),
  });
  const leave = useMutation({
    mutationFn: (id: string) => api.post(`/competitions/${id}/leave`),
    onSuccess: refresh,
    onError: (e: Error) => setError(e.message),
  });

  const busy = join.isPending || leave.isPending;

  // A match whose window has already started is live — even while it is still an
  // open, joinable lobby (a weekly stays joinable through its first day, issue
  // #44). Only matches that have not started yet are "waiting to start". `now`
  // ticks (issue #65) so a lobby crosses into Live now the second it is due,
  // without waiting for the refetch.
  const now = useNow();
  const openStarted = [...open].filter(m => m.scope_start <= now).sort((a, b) => a.scope_start - b.scope_start);
  const upcoming = [...open].filter(m => m.scope_start > now).sort((a, b) => a.scope_start - b.scope_start);
  const joinCard = (m: Match) => (
    <MatchCard
      key={m.id} match={m} now={now} busy={busy}
      onJoin={() => { setError(null); join.mutate(m.id); }}
      onLeave={() => { setError(null); leave.mutate(m.id); }}
    />
  );

  return (
    <>
      {error && <div className="auth-error">{error}</div>}

      {creating
        ? <NewMatchForm global={global} onDone={() => setCreating(false)} />
        : joiningByCode
        ? <JoinByCodeCard onSuccess={() => { setJoiningByCode(false); refresh(); }} />
        : (
          <div className="cmp-action-row">
            <button className="btn-primary cmp-new-btn" onClick={() => setCreating(true)}>
              <Icon name="plus" size={14} /> New match
            </button>
            {global && (
              <button className="btn-secondary cmp-new-btn" onClick={() => setJoiningByCode(true)}>
                <Icon name="lock" size={14} /> Join by code
              </button>
            )}
          </div>
        )}

      {/* One LayoutGroup so a card keeps its layoutId identity while it moves
          between the sections below — Motion slides it across instead of letting
          it vanish here and reappear there. initial={false} keeps the first
          paint still; only later add/remove/reorder animates. */}
      <LayoutGroup>
        <div className="section-label">Live now</div>
        {live.length === 0 && openStarted.length === 0
          ? <div className="cmp-empty">{global ? 'Nothing percolating globally.' : 'Nothing percolating yet.'}</div>
          /* Running matches: locked ones (pending) first, then any still-joinable
             lobby whose window has already started. */
          : <AnimatePresence initial={false}>
              {live.map(m => <MatchCard key={m.id} match={m} now={now} />)}
              {openStarted.map(joinCard)}
            </AnimatePresence>}

        <div className="section-label">{global ? 'Open lobbies' : 'Waiting to start'}</div>
        {upcoming.length === 0
          ? <div className="cmp-empty">{global ? 'No global matches brewing — start one.' : 'Nothing on the drip. Daily opens a day ahead, weekly two.'}</div>
          /* Soonest first. */
          : <AnimatePresence initial={false}>{upcoming.map(joinCard)}</AnimatePresence>}

        {finished && (
          <>
            <div className="section-label">Finished</div>
            {settled.length === 0
              ? <div className="cmp-empty">The grounds haven’t settled yet.</div>
              : <AnimatePresence initial={false}>{settled.map(m => <MatchCard key={m.id} match={m} now={now} />)}</AnimatePresence>}
          </>
        )}
      </LayoutGroup>
    </>
  );
}

// Both scopes render the same rating card, because the rating IS the same
// number — only the pool of matches below it changes (issue #53). Finished
// matches live in the History section (issue #34), not here.
function MatchesSection({ scope, data }: { scope: CompeteScope; data: CompetitionsResponse }) {
  const global = scope === 'global';
  const buckets = global ? data.global : data;

  return (
    <>
      <RatingCard rating={data.my_rating} matches={data.my_matches} />
      {global && <div className="field-hint">Open to anyone — no group needed.</div>}
      <MatchList
        open={buckets.open} live={buckets.live} settled={buckets.settled}
        global={global} finished={false}
      />
    </>
  );
}

function LeaderboardRow({ r, me }: { r: LeaderboardEntry; me: boolean }) {
  const navigate = useNavigate();
  return (
    <div className={`lb-row${me ? ' me' : ''}`}>
      <span className="lb-rank">{r.matches === 0 ? '—' : `#${r.rank}`}</span>
      <Avatar p={r} />
      <span className="lb-user">
        <span className="lb-user-line">
          <span
            className="lb-username cmp-name-link"
            role="button" tabIndex={0}
            onClick={() => navigate(`/u/${r.username}`)}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(`/u/${r.username}`); } }}
          >{r.username}</span>
          <BadgeRow badges={r.badges} size={15} />
        </span>
        <span className="lb-stats">
          {r.matches === 0 ? 'no matches yet' : `${r.matches} ${r.matches === 1 ? 'match' : 'matches'}`}
        </span>
      </span>
      <span className="lb-caf">{fmtRating(r.rating)}</span>
    </div>
  );
}

// One board, two windows onto it. The rank shown is the player's global rank in
// both scopes; Group only narrows the list down to the people in it.
function RankingSection({ scope }: { scope: CompeteScope }) {
  const userId = useAuthStore(s => s.user?.id);

  const { data, isLoading } = useQuery<LeaderboardResponse>({
    queryKey: ['competitions', 'leaderboard', scope],
    queryFn: () => api.get(`/competitions/leaderboard?scope=${scope}`),
  });

  if (isLoading) return <div className="page-loading">Loading…</div>;
  const rows = data?.leaderboard ?? [];
  // The global board ships a page, so a player below the cut would otherwise
  // not appear on their own leaderboard at all.
  const me = data?.me ?? null;
  const meListed = !!me && rows.some(r => r.id === me.id);

  return (
    <>
      {/* The one thing that is not self-evident: a group's ranks are the global
          ones, so they are not 1..n. */}
      {scope === 'group' && <div className="field-hint">Global rank, group members only.</div>}

      {rows.length === 0
        ? <div className="cmp-empty">{scope === 'global' ? 'Nobody in the pot yet.' : 'Nobody in the blend yet.'}</div>
        : (
          <div className="leaderboard">
            {rows.map(r => <LeaderboardRow key={r.id} r={r} me={r.id === userId} />)}
          </div>
        )}

      {me && !meListed && (
        <>
          <div className="section-label">Your standing</div>
          <div className="leaderboard"><LeaderboardRow r={me} me /></div>
        </>
      )}
    </>
  );
}

/* ── history (issue #34) ─────────────────────────────────────────────────────── */

const HISTORY_WINDOWS = [
  { days: 1, label: '24h' },
  { days: 7, label: '7d' },
  { days: 30, label: '30d' },
];

// SVG user units, stretched to the card width — strokes use
// vector-effect="non-scaling-stroke" to stay even, same as the Buzz chart.
const GRAPH_VB_W = 300;
const GRAPH_VB_H = 100;

// A window's end labels: clock time inside a day, calendar date beyond it.
function fmtAxis(t: number, days: number) {
  const d = new Date(t);
  return days <= 1
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// Rating over time for the selected window. The line runs from the rating the
// player carried INTO the window, through every settlement inside it, to the
// current rating at "now". The whole personal list is windowed here rather than
// on the server, so one payload feeds 24h/7d/30d.
function RatingGraph({ personal, currentRating }: {
  personal: PersonalHistoryEntry[]; currentRating: number;
}) {
  const [days, setDays] = useState(7);
  const now = Date.now();
  const start = now - days * 24 * HOUR;

  const asc = [...personal].sort((a, b) => a.settled_at - b.settled_at);
  const windowEntries = asc.filter(e => e.settled_at >= start);
  const prior = asc.filter(e => e.settled_at < start);

  // The rating entering the window: the last settlement before it, or — when the
  // window reaches back past the player's first ever match — the rating they took
  // into that first match (stored on the entry, so there is no 1000 literal to
  // drift from the server's BASE_RATING). With no matches at all it is just the
  // current rating, giving a flat line.
  const startRating = prior.length
    ? prior[prior.length - 1].rating_after
    : windowEntries.length
      ? windowEntries[0].rating_before
      : currentRating;

  const points = [
    { t: start, r: startRating },
    ...windowEntries.map(e => ({ t: e.settled_at, r: e.rating_after })),
    { t: now, r: currentRating },
  ];

  const ratings = points.map(p => p.r);
  const min = Math.min(...ratings);
  const max = Math.max(...ratings);
  // A flat line would divide by zero without a fixed pad; otherwise pad the range
  // so the curve never rides the top or bottom edge.
  const pad = max === min ? 10 : (max - min) * 0.15;
  const lo = min - pad;
  const hi = max + pad;

  const span = now - start;
  const x = (t: number) => ((t - start) / span) * GRAPH_VB_W;
  const y = (r: number) => GRAPH_VB_H - ((r - lo) / (hi - lo)) * GRAPH_VB_H;

  const line = points.map(p => `${x(p.t).toFixed(2)},${y(p.r).toFixed(2)}`).join(' ');
  const area = `${x(start).toFixed(2)},${GRAPH_VB_H} ${line} ${GRAPH_VB_W},${GRAPH_VB_H}`;

  const net = currentRating - startRating;
  const windowLabel = HISTORY_WINDOWS.find(w => w.days === days)!.label;

  return (
    <div className="card buzz-card">
      <div className="buzz-head">
        <div className="section-label">Rating</div>
        <div className="buzz-range">
          {HISTORY_WINDOWS.map(w => (
            <button key={w.days}
              className={`buzz-range-btn${days === w.days ? ' active' : ''}`}
              onClick={() => setDays(w.days)}>{w.label}</button>
          ))}
        </div>
      </div>

      <div className="cmp-hist-figure">
        <span className="cmp-hist-now">{fmtRating(currentRating)}</span>
        <span className={deltaClass(net)}>{fmtDelta(net)} · {windowLabel}</span>
      </div>

      <div className="buzz-chart">
        <div className="buzz-plot">
          <svg viewBox={`0 0 ${GRAPH_VB_W} ${GRAPH_VB_H}`} preserveAspectRatio="none" role="img"
            aria-label={`Rating over the last ${days === 1 ? '24 hours' : `${days} days`}`}>
            <defs>
              <linearGradient id="cmp-hist-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.4" />
                <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.03" />
              </linearGradient>
            </defs>
            <polygon points={area} fill="url(#cmp-hist-fill)" />
            <polyline points={line} fill="none" stroke="var(--accent)" strokeWidth="1.5"
              strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          </svg>
        </div>
        <div className="buzz-axis">
          <span className="buzz-axis-label" style={{ left: 0 }}>{fmtAxis(start, days)}</span>
          <span className="buzz-axis-label" style={{ right: 0 }}>{fmtAxis(now, days)}</span>
        </div>
      </div>

      {windowEntries.length === 0 && <p className="buzz-note">No rated matches in this pour.</p>}
    </div>
  );
}

// One settled match the caller played, as an elo-change row.
function HistoryRow({ e }: { e: PersonalHistoryEntry }) {
  return (
    <div className="cmp-hist-row">
      <span className="cmp-hist-mode"><Icon name={MODE_ICON[e.mode]} size={13} /></span>
      <div className="cmp-hist-main">
        <span className="cmp-hist-title">{e.title || MODE_LABEL[e.mode]}</span>
        <span className="cmp-hist-when">{fmtDateTime(e.settled_at)}</span>
      </div>
      <span className="cmp-hist-rating">{fmtRating(e.rating_after)}</span>
      <span className={deltaClass(e.delta)}>{fmtDelta(e.delta)}</span>
    </div>
  );
}

// Personal rating history (graph + elo-change list) and the scope's finished
// matches as end-match cards (issue #34).
//
// The graph is NOT scoped: it plots the one global rating, so it is the same
// curve under both tabs (issue #53). Only the lists below it are scoped — the
// elo changes to the matches of this scope, and the finished-match cards to the
// group's history or the caller's global matches.
function HistorySection({ scope, globalSettled }: { scope: CompeteScope; globalSettled: Match[] }) {
  const { data, isLoading } = useQuery<CompetitionHistoryResponse>({
    queryKey: ['competitions', 'history'],
    queryFn: () => api.get('/competitions/history'),
  });

  if (isLoading || !data) return <div className="page-loading">Loading…</div>;

  const global = scope === 'global';
  // The two filters are complements, so every settled match the caller played
  // appears under exactly one tab. Matching on the CURRENT group id instead
  // would black-hole the matches they played in a group they have since left —
  // the rating those matches moved is still in the graph above.
  const changes = data.personal.filter(e => (e.group_id === null) === global);
  const finished = global ? globalSettled : data.group_history;

  return (
    <>
      <RatingGraph personal={data.personal} currentRating={data.my_rating} />

      <div className="section-label">Your elo changes</div>
      {changes.length === 0
        ? <div className="cmp-empty">{global ? 'No global grounds have settled yet.' : 'No group grounds have settled yet.'}</div>
        : <div className="cmp-hist-list">{changes.map(e => <HistoryRow key={e.match_id} e={e} />)}</div>}

      <div className="section-label">{global ? 'Your global matches' : 'Group history'}</div>
      {finished.length === 0
        ? <div className="cmp-empty">Nothing’s finished steeping yet.</div>
        /* Done matches only — `now` never drives a settled/cancelled card, so a
           static clock is fine here (no tick needed). */
        : finished.map(m => <MatchCard key={m.id} match={m} now={Date.now()} />)}
    </>
  );
}

// The group's schedule as every member sees it (issue #18): which days are on,
// and whether it is paused. Read-only — only the owner edits it (GroupSettings).
// It reads straight from the group query, the single source of truth, so it can
// never disagree with the owner's form once a save lands.
function ScheduleView({ group }: { group: NonNullable<GroupDetailResponse['group']> }) {
  const mask = group.active_weekdays ?? 127;
  const paused = group.pause_from && group.pause_to;
  return (
    <div className="card cmp-schedule">
      <div className="section-label">Schedule</div>
      <div className="cmp-weekday-row cmp-weekday-ro" role="group" aria-label="Active days">
        {ORDERED_WEEKDAY_CELLS.map(({ label, bit, name }) => (
          <span key={name} className={`cmp-weekday${(mask & (1 << bit)) ? ' on' : ''}`} aria-label={name}>
            {label}
          </span>
        ))}
      </div>
      <div className="field-hint">
        {paused
          ? `Paused ${fmtDate(group.pause_from!)} – ${fmtDate(group.pause_to!)}`
          : 'Not paused'}
      </div>
    </div>
  );
}

// The group itself: what it is, how to get into it, and the preferences that
// only mean anything inside one (auto-join, and the owner's group settings).
// The member list is not repeated here — Ranking is the member list now.
function PreferencesSection() {
  const qc = useQueryClient();
  const userId = useAuthStore(s => s.user?.id);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useQuery<GroupDetailResponse>({
    queryKey: ['groups', 'mine'],
    queryFn: () => api.get('/groups/mine'),
  });

  const leave = useMutation({
    mutationFn: () => api.post('/groups/leave'),
    onSuccess: () => {
      setConfirmLeave(false);
      qc.invalidateQueries({ queryKey: ['groups'] });
      qc.invalidateQueries({ queryKey: ['competitions'] });
    },
    onError: (e: Error) => setError(e.message),
  });

  if (isLoading) return <div className="page-loading">Loading…</div>;
  const group = data?.group;
  if (!group) return <div className="cmp-empty">You are not in a group.</div>;

  const isOwner = group.owner_id === userId;
  // Ranking replaced the member list, and it has no notion of an owner — so the
  // group card is now the only place a non-owner can see whose group this is.
  const owner = (data?.members ?? []).find(m => m.id === group.owner_id);

  return (
    <>
      <div className="card cmp-group-card">
        <div className="cmp-group-name">{group.name}</div>
        {group.description && <div className="cmp-group-desc">{group.description}</div>}
        <div className="cmp-group-meta">
          <span><Icon name="users" size={12} /> {group.member_count} members</span>
          {owner && <span><Icon name="crown" size={12} /> {owner.username}</span>}
          <span><Icon name="clock" size={12} /> {group.timezone}</span>
          <span>{group.is_public ? 'Public' : <><Icon name="lock" size={12} /> Private</>}</span>
        </div>
        {group.join_code && (
          <InviteCode code={group.join_code} />
        )}
        <div className="field-hint">
          Days and weeks run on {group.timezone}. One group at a time — joining
          another leaves this one.
        </div>
      </div>

      <ScheduleView group={group} />

      <AutoJoinCard />

      {isOwner && <GroupSettings group={group} />}

      {error && <div className="auth-error">{error}</div>}

      <button className="btn-danger cmp-leave-btn" onClick={() => setConfirmLeave(true)}>
        Leave group
      </button>

      {confirmLeave && (
        <ConfirmDialog
          title={`Leave ${group.name}?`}
          message="Matches already running still settle. Your rating stays with you."
          confirmLabel="Leave group"
          error={error}
          onConfirm={() => { setError(null); leave.mutate(); }}
          onCancel={() => setConfirmLeave(false)}
        />
      )}
    </>
  );
}

function GroupSettings({ group }: { group: NonNullable<GroupDetailResponse['group']> }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(group.name);
  const [description, setDescription] = useState(group.description ?? '');
  const [timezone, setTimezone] = useState(group.timezone);
  const [isPublic, setIsPublic] = useState(group.is_public === 1);
  const [activeWeekdays, setActiveWeekdays] = useState(group.active_weekdays ?? 127);
  const [pauseFrom, setPauseFrom] = useState(group.pause_from ?? '');
  const [pauseTo, setPauseTo] = useState(group.pause_to ?? '');
  const [error, setError] = useState<string | null>(null);

  // The form stays mounted while closed, so its state outlives a cancel unless
  // it is put back deliberately. Called on cancel AND on open: the second one
  // also picks up a change made elsewhere (or by another member) while the form
  // sat closed, so what is shown is always what the server holds.
  function resetToServer() {
    setName(group.name);
    setDescription(group.description ?? '');
    setTimezone(group.timezone);
    setIsPublic(group.is_public === 1);
    setActiveWeekdays(group.active_weekdays ?? 127);
    setPauseFrom(group.pause_from ?? '');
    setPauseTo(group.pause_to ?? '');
    setError(null);
  }

  const save = useMutation({
    mutationFn: () => api.patch<GroupDetailResponse>(`/groups/${group.id}`, {
      name, description: description.trim() || null, timezone, is_public: isPublic,
      active_weekdays: activeWeekdays,
      // A one-tap selection is a single-day pause (from === to); no selection
      // clears the pause (both null).
      pause_from: pauseFrom || null,
      pause_to: pauseFrom ? (pauseTo || pauseFrom) : null,
    }),
    onSuccess: (res) => {
      setOpen(false);
      // Write the server's own updated group into the query that the member-
      // visible schedule reads from, so the display and the (re-opened) form
      // can never show two different states after a save. Competitions still
      // refetch because the schedule changes which matches open/score.
      qc.setQueryData(['groups', 'mine'], res);
      qc.invalidateQueries({ queryKey: ['groups'] });
      qc.invalidateQueries({ queryKey: ['competitions'] });
    },
    onError: (e: Error) => setError(e.message),
  });

  if (!open) {
    return (
      <button className="btn-secondary cmp-settings-btn" onClick={() => { resetToServer(); setOpen(true); }}>
        Group settings
      </button>
    );
  }

  return (
    <div className="card cmp-form">
      <div className="section-label">Group settings</div>

      <div className="field">
        <label htmlFor="cmp-gname">Name</label>
        <input id="cmp-gname" className="search-input" value={name} maxLength={31} onChange={e => setName(e.target.value)} />
      </div>

      <div className="field">
        <label htmlFor="cmp-gdesc">Description</label>
        <input id="cmp-gdesc" className="search-input" value={description} maxLength={200} onChange={e => setDescription(e.target.value)} />
      </div>

      <div className="field">
        <label htmlFor="cmp-gtz">Timezone</label>
        <TimezonePicker id="cmp-gtz" value={timezone} onChange={setTimezone} />
        <div className="field-hint">Applies from the next day and week.</div>
      </div>

      <div className="field">
        <label>Active days</label>
        <WeekdayPicker value={activeWeekdays} onChange={setActiveWeekdays} />
        <div className="field-hint">Off days aren’t scored.</div>
      </div>

      <PausePicker from={pauseFrom} to={pauseTo} onChange={(f, t) => { setPauseFrom(f); setPauseTo(t); }} />

      <PublicToggle value={isPublic} onChange={setIsPublic} />

      {error && <div className="auth-error">{error}</div>}

      <div className="cmp-form-actions">
        <button className="btn-primary" disabled={save.isPending} onClick={() => { setError(null); save.mutate(); }}>
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
        <button className="btn-secondary" onClick={() => { resetToServer(); setOpen(false); }}>Cancel</button>
      </div>
    </div>
  );
}

/* ── no group yet ──────────────────────────────────────────────────────────── */

function GroupGate() {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isPublic, setIsPublic] = useState(true);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { data } = useQuery<GroupsResponse>({
    queryKey: ['groups'],
    queryFn: () => api.get('/groups'),
  });

  const done = () => {
    qc.invalidateQueries({ queryKey: ['groups'] });
    qc.invalidateQueries({ queryKey: ['competitions'] });
  };

  const create = useMutation({
    mutationFn: () => api.post<GroupDetailResponse>('/groups', {
      name, description: description.trim() || null, is_public: isPublic,
    }),
    onSuccess: done,
    onError: (e: Error) => setError(e.message),
  });
  const join = useMutation({
    mutationFn: (body: { code?: string; group_id?: string }) =>
      api.post<GroupDetailResponse>('/groups/join', body),
    onSuccess: done,
    onError: (e: Error) => setError(e.message),
  });

  const busy = create.isPending || join.isPending;

  return (
    <>
      <div className="empty-state">Competitions need a crew — join a group to play.</div>

      {error && <div className="auth-error">{error}</div>}

      <div className="card cmp-form">
        <div className="section-label">Join with a code</div>
        <div className="field">
          <label htmlFor="cmp-code">Invite code</label>
          <input
            id="cmp-code" className="search-input" value={code} maxLength={6}
            placeholder="ABC123" onChange={e => setCode(e.target.value.toUpperCase())}
          />
        </div>
        <button className="btn-primary" disabled={busy || !code.trim()} onClick={() => { setError(null); join.mutate({ code }); }}>
          Join group
        </button>
      </div>

      <div className="card cmp-form">
        <div className="section-label">Create a group</div>
        <div className="field">
          <label htmlFor="cmp-newname">Name</label>
          <input
            id="cmp-newname" className="search-input" value={name} maxLength={31}
            placeholder="Bean Team" onChange={e => setName(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="cmp-newdesc">Description (optional)</label>
          <input
            id="cmp-newdesc" className="search-input" value={description} maxLength={200}
            onChange={e => setDescription(e.target.value)}
          />
        </div>
        <PublicToggle value={isPublic} onChange={setIsPublic} />
        <div className="field-hint">Uses your timezone. Changeable later.</div>
        <button className="btn-primary" disabled={busy || !name.trim()} onClick={() => { setError(null); create.mutate(); }}>
          Create group
        </button>
      </div>

      <div className="section-label">Public groups</div>
      {(data?.groups ?? []).length === 0
        ? <div className="cmp-empty">No public blends yet — start the first one.</div>
        : (data?.groups ?? []).map(g => (
          <div key={g.id} className="card cmp-group-row">
            <div>
              <div className="cmp-group-name">{g.name}</div>
              {g.description && <div className="cmp-group-desc">{g.description}</div>}
              <div className="cmp-group-meta">
                <span><Icon name="users" size={12} /> {g.member_count}</span>
                <span><Icon name="clock" size={12} /> {g.timezone}</span>
              </div>
            </div>
            <button className="btn-secondary" disabled={busy} onClick={() => { setError(null); join.mutate({ group_id: g.id }); }}>
              Join
            </button>
          </div>
        ))}
    </>
  );
}

/* ── page ──────────────────────────────────────────────────────────────────── */

const SCOPES: { id: CompeteScope; label: string; icon: string }[] = [
  { id: 'global', label: 'Global', icon: 'globe' },
  { id: 'group', label: 'Group', icon: 'users' },
];

function isScope(v: string | undefined): v is CompeteScope {
  return v === 'global' || v === 'group';
}

export function Compete() {
  // Scope and section live in the path (/compete/group/ranking) so a refresh or
  // a shared link lands on the same tab instead of snapping back to
  // Group/Matches. Bare or invalid paths fall back to the load-time default.
  const { scope: scopeParam, section: sectionParam } = useParams();
  const navigate = useNavigate();

  const { data, isLoading } = useQuery<CompetitionsResponse>({
    queryKey: ['competitions'],
    queryFn: () => api.get('/competitions'),
  });

  const hasGroup = !!data?.group;
  // Someone in a group is here for their group; someone without one has nothing
  // to show under Group but the invitation to join one, so Global leads.
  const activeScope: CompeteScope = isScope(scopeParam) ? scopeParam : (hasGroup ? 'group' : 'global');

  const sections = SECTIONS[activeScope];
  // The section segment can name a section the current scope does not have (a
  // stale link, or a scope switch), so fall back to the first for rendering.
  const activeSection: Section = sections.some(s => s.id === sectionParam)
    ? (sectionParam as Section)
    : sections[0].id;

  // Keep the address bar naming the view actually shown: bare /compete, an
  // unknown scope, or a section the scope lacks all rewrite to the resolved
  // path once data has loaded. replace: true — a canonicalising rewrite is not
  // a navigation the back button should have to walk through.
  useEffect(() => {
    if (isLoading) return;
    if (scopeParam !== activeScope || sectionParam !== activeSection) {
      navigate(`/compete/${activeScope}/${activeSection}`, { replace: true });
    }
  }, [isLoading, scopeParam, sectionParam, activeScope, activeSection, navigate]);

  function pickScope(next: CompeteScope) {
    // Keep the section when the new scope also has it, so switching scope
    // compares like with like; otherwise land on that scope's first section so
    // the URL and the rendered tab never disagree.
    const nextSection = SECTIONS[next].some(s => s.id === activeSection) ? activeSection : SECTIONS[next][0].id;
    navigate(`/compete/${next}/${nextSection}`, { replace: true });
  }

  function pickSection(next: Section) {
    navigate(`/compete/${activeScope}/${next}`, { replace: true });
  }

  return (
    <div className="page">
      <AppHeader />

      <div className="page-header">
        <h2>Compete</h2>
        <p className="page-sub">
          {activeScope === 'group' && data?.group ? data.group.name : 'Rated matches'}
        </p>
      </div>

      {isLoading || !data ? (
        <div className="page-loading">Loading…</div>
      ) : (
        <>
          <div className="cmp-scope-tabs" role="tablist">
            {SCOPES.map(s => (
              <button
                key={s.id}
                role="tab"
                aria-selected={activeScope === s.id}
                className={`cmp-scope-tab${activeScope === s.id ? ' active' : ''}`}
                onClick={() => pickScope(s.id)}
              >
                <Icon name={s.icon} size={14} /> {s.label}
              </button>
            ))}
          </div>

          <div className="stats-tab-body cmp-body">
            {/* Every group-scoped section needs a group. Without one the whole
                tab is the invitation to get into one. */}
            {activeScope === 'group' && !hasGroup ? <GroupGate /> : (
              <>
                <div className="tab-row">
                  {sections.map(s => (
                    <button
                      key={s.id}
                      className={`tab-btn${activeSection === s.id ? ' active' : ''}`}
                      onClick={() => pickSection(s.id)}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>

                {activeSection === 'matches' && <MatchesSection scope={activeScope} data={data} />}
                {activeSection === 'ranking' && <RankingSection scope={activeScope} />}
                {activeSection === 'history' && (
                  <HistorySection scope={activeScope} globalSettled={data.global.settled} />
                )}
                {activeSection === 'preferences' && <PreferencesSection />}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
