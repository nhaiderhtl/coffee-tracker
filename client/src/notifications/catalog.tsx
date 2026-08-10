import type { ReactNode } from 'react';
import type { AppNotification } from '../types';

// Render a template with **bold** spans into React nodes — the app's highlight
// style for the key values in a message (ratings, names). Plain text elsewhere.
export function highlight(template: string): ReactNode[] {
  return template.split(/(\*\*[^*]+\*\*)/).map((seg, i) =>
    (seg.startsWith('**') && seg.endsWith('**'))
      ? <strong key={i}>{seg.slice(2, -2)}</strong>
      : <span key={i}>{seg}</span>,
  );
}

// Turns a stored notification payload into a display descriptor, keyed by type.
// Text and layout live here, never in the backend, so a change applies to every
// row. Each type gets a shape built around its own key figures — not one rigid
// row — so the data reads at a glance.
export type Tone = 'up' | 'down' | 'neutral';

// achievement / badge: icon + name lead, description secondary.
interface SimpleRender {
  kind: 'simple';
  icon: string;
  tag: string;   // "Achievement" | "Badge"
  name: string;
  description: string;
}

// match_end: the result leads; placing and rating change are discrete chips.
// ratingBefore/ratingAfter drive the fullscreen reveal's count-up (the card
// itself only needs the delta chip). See docs/notifications-reveals.md.
interface MatchRender {
  kind: 'match';
  icon: string;
  result: 'Won' | 'Lost' | 'Tied';
  tone: Tone;
  mode: string;    // "daily" | "weekly" | …, for the sentence
  rank: number;
  count: number;
  delta: number;
  ratingBefore: number;
  ratingAfter: number;
  context: string; // group name or "Global"
}

// match_recomputed: an admin invalidated a match, so this one's rating was
// recalculated. Info nature — carries the old vs new rating for the count.
interface RecomputeRender {
  kind: 'recompute';
  icon: string;
  title: string;         // toast/card title
  invalidatedTitle: string;
  oldRating: number;
  newRating: number;
}

// unknown type: raw fallback so a server type ahead of the frontend still shows.
interface RawRender {
  kind: 'raw';
  icon: string;
  title: string;
  rows: [string, string][];
}

export type RenderedNotification = SimpleRender | MatchRender | RecomputeRender | RawRender;

interface AchievementPayload { id: string; name: string; icon: string; description: string }
interface MatchEndPayload {
  match_id: string; title: string | null; group_name: string | null;
  mode: string; rank: number; participant_count: number;
  score: number; delta: number;
  rating_before: number; rating_after: number;
}
interface MatchRecomputedPayload {
  match_id: string; title: string | null;
  invalidated: boolean; invalidated_match_id: string; invalidated_title: string | null;
  old_rating: number; new_rating: number; old_delta: number; new_delta: number;
}

const catalog: Record<string, (p: never) => RenderedNotification> = {
  achievement: (p: AchievementPayload): SimpleRender => ({
    kind: 'simple', icon: p.icon || 'medal', tag: 'Achievement', name: p.name, description: p.description,
  }),
  badge: (p: AchievementPayload): SimpleRender => ({
    kind: 'simple', icon: p.icon || 'award', tag: 'Badge', name: p.name, description: p.description,
  }),
  match_end: (p: MatchEndPayload): MatchRender => ({
    kind: 'match',
    icon: 'trophy',
    result: p.delta > 0 ? 'Won' : p.delta < 0 ? 'Lost' : 'Tied',
    tone: p.delta > 0 ? 'up' : p.delta < 0 ? 'down' : 'neutral',
    mode: p.mode,
    rank: p.rank,
    count: p.participant_count,
    delta: p.delta,
    ratingBefore: p.rating_before,
    ratingAfter: p.rating_after,
    context: p.group_name ?? 'Global',
  }),
  match_recomputed: (p: MatchRecomputedPayload): RecomputeRender => ({
    kind: 'recompute',
    icon: 'info',
    title: 'Match invalidated',
    invalidatedTitle: p.invalidated_title ?? 'a match',
    oldRating: p.old_rating,
    newRating: p.new_rating,
  }),
} as Record<string, (p: never) => RenderedNotification>;

function renderDefault(n: AppNotification): RawRender {
  const p = n.payload;
  const rows: [string, string][] = p && typeof p === 'object'
    ? Object.entries(p as Record<string, unknown>).map(([k, v]) => [k, String(v)])
    : [['value', String(p)]];
  return { kind: 'raw', icon: 'bell', title: n.type, rows };
}

export function renderNotification(n: AppNotification): RenderedNotification {
  const entry = catalog[n.type];
  return entry ? entry(n.payload as never) : renderDefault(n);
}

// Toast opt-in. Returns the compact toast content for a notification, or null
// for types that must NOT pop a toast. Match results are intentionally excluded
// (they have their own plans), and unknown/raw types stay out too — a toast is
// only for a type we can present cleanly. This is the single place that decides
// what toasts.
export function toastFor(n: AppNotification): { icon: string; title: string; body: ReactNode; tone?: 'warn' } | null {
  const r = renderNotification(n);
  if (r.kind === 'simple') return { icon: r.icon, title: r.name, body: r.description };
  if (r.kind === 'recompute') {
    return {
      icon: r.icon,
      title: r.title,
      // Invalidation context: warn tone, kept low-key (icon tint only).
      tone: 'warn',
      body: highlight(`**${r.invalidatedTitle}** was removed by an admin. Your rating changed from **${r.oldRating}** to **${r.newRating}**.`),
    };
  }
  return null; // match, raw → no toast
}

// 1st / 2nd / 3rd / 4th … for the rank pill.
export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
