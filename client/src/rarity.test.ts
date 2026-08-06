import { test, expect, describe } from 'bun:test';
import { rarityLabel, rarityColor, byUnlockedThenRarity } from './rarity';

// rarity.ts exists because these tables were copy-pasted into four pages and
// drifted (issue #30). The sort is the part worth pinning: it is not a single
// ordering, it flips direction between the unlocked and locked groups.

const b = (rarity: string, unlocked = false) => ({ rarity, unlocked });
const order = (xs: { rarity: string; unlocked: boolean }[]) =>
  [...xs].sort(byUnlockedThenRarity).map(x => `${x.unlocked ? '+' : '-'}${x.rarity}`);

describe('rarityLabel', () => {
  test('names each known tier', () => {
    expect(rarityLabel('common')).toBe('Common');
    expect(rarityLabel('legendary')).toBe('Legendary');
  });

  test('masks secret rather than naming it', () => {
    expect(rarityLabel('secret')).toBe('???');
  });

  test('falls through to the raw value for an unknown tier', () => {
    // A rarity added server-side must stay legible before the client catches
    // up — blank would be worse than the raw key.
    expect(rarityLabel('mythic')).toBe('mythic');
  });
});

describe('rarityColor', () => {
  test('gives each known tier its colour', () => {
    expect(rarityColor('common')).toBe('#9E9E9E');
    expect(rarityColor('secret')).toBe('#FF1744');
  });

  test('falls back to grey for an unknown tier', () => {
    expect(rarityColor('mythic')).toBe('#999');
    expect(rarityColor('')).toBe('#999');
  });
});

describe('byUnlockedThenRarity', () => {
  test('unlocked badges always come before locked ones', () => {
    const sorted = order([b('common', false), b('legendary', false), b('common', true)]);
    expect(sorted[0]).toBe('+common');
  });

  test('within unlocked, rarest first — you show off the best', () => {
    expect(order([
      b('common', true), b('legendary', true), b('rare', true), b('epic', true),
    ])).toEqual(['+legendary', '+epic', '+rare', '+common']);
  });

  test('within locked, commonest first — the ladder still to climb', () => {
    // Deliberately the opposite direction to the unlocked group.
    expect(order([
      b('legendary'), b('common'), b('epic'), b('uncommon'),
    ])).toEqual(['-common', '-uncommon', '-epic', '-legendary']);
  });

  test('both groups at once', () => {
    expect(order([
      b('rare'), b('legendary', true), b('common'), b('common', true),
    ])).toEqual(['+legendary', '+common', '-common', '-rare']);
  });

  test('secret sorts last among unlocked and first-from-the-end among locked', () => {
    // 'secret' is the highest index in RARITY_ORDER, so unlocked it leads and
    // locked it trails. Pinning this stops a reordering of the tier list from
    // silently moving secrets around the grid.
    expect(order([b('secret', true), b('legendary', true)])).toEqual(['+secret', '+legendary']);
    expect(order([b('secret'), b('legendary')])).toEqual(['-legendary', '-secret']);
  });

  test('an unknown tier does not throw and lands consistently', () => {
    // indexOf returns -1, which must not produce NaN or an unstable compare.
    const sorted = order([b('mythic'), b('common'), b('legendary')]);
    expect(sorted).toHaveLength(3);
    expect(sorted[0]).toBe('-mythic'); // -1 sorts ahead of every real tier
  });

  test('is a stable, self-consistent comparator', () => {
    const xs = [b('epic', true), b('common'), b('rare', true), b('legendary'), b('common', true)];
    expect(order(xs)).toEqual(order([...xs].reverse()));
  });
});
