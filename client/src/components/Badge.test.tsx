import { test, expect, describe } from 'bun:test';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { BadgeChip, BadgeRow, BadgeMedal } from './Badge';
import type { Badge as BadgeT, ProfileBadge } from '../types';

// Badge.tsx is THE badge glyph — every surface showing a profile renders
// through it so the look cannot drift (AGENTS.md, "Badges travel with the
// profile"). The rules worth pinning are the ones a refactor could quietly
// break: an empty row renders nothing, and `withInfo` is opt-in so inline
// surfaces stay display-only.

const pb = (over: Partial<ProfileBadge> = {}): ProfileBadge => ({
  id: 'b1', name: 'First Sip', icon: 'coffee', rarity: 'common',
  description: 'Log your first coffee', ...over,
} as ProfileBadge);

describe('BadgeChip', () => {
  test('renders one accessible glyph carrying name and rarity', () => {
    render(<BadgeChip badge={pb()} />);
    const chip = screen.getByRole('img');
    expect(chip.getAttribute('aria-label')).toBe('First Sip, Common badge');
    expect(chip.getAttribute('title')).toBe('First Sip · Common');
  });

  test('the tier colour drives the ring, so rarity reads without a label', () => {
    const { container } = render(<BadgeChip badge={pb({ rarity: 'legendary' })} />);
    const chip = container.querySelector('.badge-chip') as HTMLElement;
    // rarityColor('legendary') — kept in sync via rarity.ts, tested there.
    expect(chip.style.borderColor).toBeTruthy();
    expect(chip.getAttribute('title')).toContain('Legendary');
  });

  test('a secret badge shows ??? as its rarity', () => {
    render(<BadgeChip badge={pb({ rarity: 'secret', name: 'Night Owl' })} />);
    expect(screen.getByRole('img').getAttribute('title')).toBe('Night Owl · ???');
  });

  test('size drives the rendered box', () => {
    const { container } = render(<BadgeChip badge={pb()} size={48} />);
    const chip = container.querySelector('.badge-chip') as HTMLElement;
    expect(chip.style.width).toBe('48px');
    expect(chip.style.height).toBe('48px');
  });
});

describe('BadgeRow', () => {
  // Callers drop this in unconditionally beside a name/avatar, so the empty
  // cases must produce no stray wrapper.
  test('renders nothing for an empty or missing list', () => {
    const { container: a } = render(<BadgeRow badges={[]} />);
    expect(a.querySelector('.badge-row')).toBeNull();
    const { container: b } = render(<BadgeRow badges={undefined} />);
    expect(b.querySelector('.badge-row')).toBeNull();
  });

  test('renders one chip per badge, in the order given', () => {
    render(<BadgeRow badges={[
      pb({ id: '1', name: 'Alpha' }),
      pb({ id: '2', name: 'Beta' }),
      pb({ id: '3', name: 'Gamma' }),
    ]} />);
    const names = screen.getAllByRole('img').map(n => n.getAttribute('aria-label')?.split(',')[0]);
    expect(names).toEqual(['Alpha', 'Beta', 'Gamma']);
  });

  test('is display-only by default — no info trigger', () => {
    // Inline surfaces (feed post, match roster, leaderboard) must not get the
    // popover; only the profile pages pass withInfo.
    const { container } = render(<BadgeRow badges={[pb()]} />);
    expect(container.querySelector('.badge-info-trigger')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  test('withInfo turns each chip into a button', () => {
    render(<BadgeRow badges={[pb()]} withInfo />);
    const btn = screen.getByRole('button');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.getAttribute('aria-label')).toBe('First Sip badge — details');
  });

  test('passes className through', () => {
    const { container } = render(<BadgeRow badges={[pb()]} className="profile-head-badges" />);
    expect(container.querySelector('.badge-row')?.className).toBe('badge-row profile-head-badges');
  });
});

describe('InfoBadge popover (withInfo)', () => {
  test('a click opens it and shows name, rarity and description', () => {
    render(<BadgeRow badges={[pb({ description: 'Log your first coffee' })]} withInfo />);
    fireEvent.click(screen.getByRole('button'));

    const tip = screen.getByRole('tooltip');
    expect(tip.textContent).toContain('First Sip');
    expect(tip.textContent).toContain('Common');
    expect(tip.textContent).toContain('Log your first coffee');
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('true');
  });

  test('clicking again closes it', () => {
    render(<BadgeRow badges={[pb()]} withInfo />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.queryByRole('tooltip')).not.toBeNull();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  test('Escape closes it — a touch user has no hover to leave', () => {
    render(<BadgeRow badges={[pb()]} withInfo />);
    fireEvent.click(screen.getByRole('button'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  test('a tap outside closes it', () => {
    render(<BadgeRow badges={[pb()]} withInfo />);
    fireEvent.click(screen.getByRole('button'));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  test('a secret badge with no description shows no description line', () => {
    // profile.js withholds the description from a viewer who has not earned the
    // secret; the chip must degrade to name + rarity, not render an empty node.
    render(<BadgeRow badges={[pb({ rarity: 'secret', name: 'Night Owl', description: '' })]} withInfo />);
    fireEvent.click(screen.getByRole('button'));
    const tip = screen.getByRole('tooltip');
    expect(tip.textContent).toContain('Night Owl');
    expect(tip.textContent).toContain('???');
    expect(tip.querySelector('.badge-popover-desc')).toBeNull();
  });

  test('touch pointer-enter does not open it', () => {
    // The browser fires synthetic enter/leave on touch; letting those through
    // made a tap open-then-immediately-close.
    render(<BadgeRow badges={[pb()]} withInfo />);
    fireEvent.pointerEnter(screen.getByRole('button').parentElement!, { pointerType: 'touch' });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  test('mouse hover opens it only after the 300ms delay', async () => {
    render(<BadgeRow badges={[pb()]} withInfo />);
    const wrap = screen.getByRole('button').parentElement!;

    fireEvent.pointerEnter(wrap, { pointerType: 'mouse' });
    expect(screen.queryByRole('tooltip')).toBeNull(); // not yet

    await act(async () => { await new Promise(r => setTimeout(r, 350)); });
    expect(screen.queryByRole('tooltip')).not.toBeNull();
  });

  test('leaving before the delay cancels the pending open', async () => {
    render(<BadgeRow badges={[pb()]} withInfo />);
    const wrap = screen.getByRole('button').parentElement!;

    fireEvent.pointerEnter(wrap, { pointerType: 'mouse' });
    fireEvent.pointerLeave(wrap, { pointerType: 'mouse' });

    await act(async () => { await new Promise(r => setTimeout(r, 350)); });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});

describe('BadgeMedal', () => {
  const bt = (over: Partial<BadgeT> = {}): BadgeT => ({
    id: 'm1', name: 'Centurion', icon: 'century', rarity: 'epic',
    description: '100 cups', unlocked: false, unlocked_at: null, ...over,
  } as BadgeT);

  test('locked badges get the locked class and no date', () => {
    const { container } = render(<BadgeMedal badge={bt()} />);
    const medal = container.querySelector('.badge-medal') as HTMLElement;
    expect(medal.className).toContain('locked');
    expect(medal.className).not.toContain('unlocked');
    expect(container.querySelector('.badge-medal-date')).toBeNull();
  });

  test('unlocked badges get the unlocked class and show the date', () => {
    const { container } = render(
      <BadgeMedal badge={bt({ unlocked: true, unlocked_at: Date.parse('2026-01-15T12:00:00Z') })} />,
    );
    expect((container.querySelector('.badge-medal') as HTMLElement).className).toContain('unlocked');
    expect(container.querySelector('.badge-medal-date')?.textContent).toBeTruthy();
  });

  test('an unlocked badge with no timestamp shows no date', () => {
    const { container } = render(<BadgeMedal badge={bt({ unlocked: true, unlocked_at: null })} />);
    expect(container.querySelector('.badge-medal-date')).toBeNull();
  });

  test('name and rarity are rendered', () => {
    const { container } = render(<BadgeMedal badge={bt()} />);
    expect(container.querySelector('.badge-medal-name')?.textContent).toBe('Centurion');
    expect(container.querySelector('.badge-medal-rarity')?.textContent).toBe('Epic');
  });
});
