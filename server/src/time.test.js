import { test, expect, beforeEach, describe } from 'bun:test';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

process.env.DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'coffee-time-test-'));
process.env.JWT_SECRET = 'test-secret';

const db = require('./db');
require('./migrate')(db);

const {
  DEFAULT_TZ, isValidTz, localParts, localDateStr, localTodayStr,
  offsetMs, localWallInstant, localDayBounds, getUserTz,
} = require('./time');

// time.js is the single instant<->civil translation boundary for the whole app
// (docs/time-and-timezones.md) and had no direct test before this file — every
// assertion about it was incidental, inside competitions.test.js. Issue #16
// calls out "local, global timezones and a user which moves timezones" by name.
//
// Zones are picked to cover the shapes that break naive offset math:
//   - whole-hour with DST      Europe/Vienna (+1/+2), America/New_York (-5/-4)
//   - half-hour, never DST     Asia/Kolkata (+5:30)
//   - quarter-hour, never DST  Asia/Kathmandu (+5:45)
//   - extreme east / west      Pacific/Kiritimati (+14), Pacific/Niue (-11)
//   - southern-hemisphere DST  Australia/Sydney (+10/+11, inverted seasons)
//
// Fixed instants, never Date.now(), so a run in July asserts the same thing as
// a run in January.
const JAN = Date.parse('2026-01-15T12:00:00Z'); // northern winter
const JUL = Date.parse('2026-07-15T12:00:00Z'); // northern summer

const MINUTE = 60000;
const HOUR = 3600000;

function hoursIn(dateStr, tz) {
  const { start, end } = localDayBounds(dateStr, tz);
  return (end + 1 - start) / HOUR;
}

describe('isValidTz', () => {
  test('accepts IANA zone names', () => {
    for (const tz of ['UTC', 'Europe/Vienna', 'America/New_York', 'Asia/Kolkata',
      'Pacific/Kiritimati', 'Australia/Sydney', 'Etc/GMT+5']) {
      expect(isValidTz(tz)).toBe(true);
    }
  });

  // The spec is explicit that an offset or abbreviation must never reach
  // storage: an offset is a snapshot, the IANA name is the living DST ruleset.
  test('rejects abbreviations and garbage', () => {
    for (const tz of ['CET', 'CEST', 'EST5EDT?', 'Mars/Olympus', 'Not/AZone', '', '   ']) {
      expect(isValidTz(tz)).toBe(false);
    }
  });

  test('rejects non-strings', () => {
    for (const tz of [null, undefined, 0, 60, {}, [], true]) {
      expect(isValidTz(tz)).toBe(false);
    }
  });
});

describe('localParts / localDateStr across the globe', () => {
  test('one instant, many civil clocks', () => {
    // Same absolute moment, read in each zone.
    expect(localParts(JAN, 'UTC')).toMatchObject({ year: 2026, month: 1, day: 15, hour: 12 });
    expect(localParts(JAN, 'Europe/Vienna')).toMatchObject({ hour: 13 });      // CET  +1
    expect(localParts(JAN, 'America/New_York')).toMatchObject({ hour: 7 });    // EST  -5
    expect(localParts(JAN, 'Asia/Kolkata')).toMatchObject({ hour: 17, minute: 30 });
    expect(localParts(JAN, 'Asia/Kathmandu')).toMatchObject({ hour: 17, minute: 45 });
  });

  test('DST moves the same zone by an hour between January and July', () => {
    expect(localParts(JAN, 'Europe/Vienna').hour).toBe(13);   // +1
    expect(localParts(JUL, 'Europe/Vienna').hour).toBe(14);   // +2
    expect(localParts(JAN, 'America/New_York').hour).toBe(7); // -5
    expect(localParts(JUL, 'America/New_York').hour).toBe(8); // -4
  });

  test('southern hemisphere DST runs the other way', () => {
    // Sydney is +11 in the northern winter and +10 in the northern summer —
    // the opposite of Vienna, which is why "is it summer" is never a valid
    // substitute for asking the tz database.
    expect(localParts(JAN, 'Australia/Sydney').hour).toBe(23);
    expect(localParts(JUL, 'Australia/Sydney').hour).toBe(22);
  });

  test('zones far enough apart land on different calendar days', () => {
    // The whole reason civil logic cannot be done in UTC: one instant is three
    // different dates depending on who is asking.
    expect(localDateStr(JAN, 'Pacific/Kiritimati')).toBe('2026-01-16'); // +14
    expect(localDateStr(JAN, 'UTC')).toBe('2026-01-15');
    expect(localDateStr(JAN, 'Pacific/Niue')).toBe('2026-01-15');       // -11, 01:00

    // Push to an instant where the west side falls back a day.
    const lateUtc = Date.parse('2026-01-15T06:00:00Z');
    expect(localDateStr(lateUtc, 'Pacific/Niue')).toBe('2026-01-14');   // 19:00 prev day
    expect(localDateStr(lateUtc, 'Pacific/Kiritimati')).toBe('2026-01-15');
  });

  test('localTodayStr agrees with localDateStr(now)', () => {
    const now = Date.now();
    for (const tz of ['UTC', 'Europe/Vienna', 'Pacific/Kiritimati']) {
      expect([localDateStr(now, tz), localDateStr(Date.now(), tz)]).toContain(localTodayStr(tz));
    }
  });
});

describe('offsetMs', () => {
  test('whole, half and quarter hour offsets', () => {
    expect(offsetMs(JAN, 'UTC')).toBe(0);
    expect(offsetMs(JAN, 'Europe/Vienna')).toBe(1 * HOUR);
    expect(offsetMs(JAN, 'America/New_York')).toBe(-5 * HOUR);
    expect(offsetMs(JAN, 'Asia/Kolkata')).toBe(5 * HOUR + 30 * MINUTE);
    expect(offsetMs(JAN, 'Asia/Kathmandu')).toBe(5 * HOUR + 45 * MINUTE);
    expect(offsetMs(JAN, 'Pacific/Kiritimati')).toBe(14 * HOUR);
    expect(offsetMs(JAN, 'Pacific/Niue')).toBe(-11 * HOUR);
  });

  test('is derived per instant, so DST is automatic', () => {
    expect(offsetMs(JUL, 'Europe/Vienna')).toBe(2 * HOUR);
    expect(offsetMs(JUL, 'America/New_York')).toBe(-4 * HOUR);
    // A zone without DST does not move.
    expect(offsetMs(JUL, 'Asia/Kolkata')).toBe(offsetMs(JAN, 'Asia/Kolkata'));
  });
});

describe('localWallInstant', () => {
  test('round-trips a wall clock back to the same civil parts', () => {
    for (const tz of ['UTC', 'Europe/Vienna', 'America/New_York', 'Asia/Kathmandu', 'Pacific/Kiritimati']) {
      const inst = localWallInstant('2026-06-10', '09:30:00', tz);
      const p = localParts(inst, tz);
      expect(`${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`).toBe('2026-6-10 9:30');
    }
  });

  test('midnight in a far-east zone is the previous UTC day', () => {
    const inst = localWallInstant('2026-01-16', '00:00:00', 'Pacific/Kiritimati');
    expect(localDateStr(inst, 'UTC')).toBe('2026-01-15');
  });

  // The two-pass resolution exists for these: a single-pass conversion takes
  // the offset on the wrong side of the transition and lands an hour out.
  test('resolves across the spring-forward gap', () => {
    // Europe/Vienna 2026-03-29: 02:00 CET jumps straight to 03:00 CEST, so
    // 02:30 local never happens. It must still resolve to a real instant
    // rather than NaN, and must not travel to a different day.
    const inst = localWallInstant('2026-03-29', '02:30:00', 'Europe/Vienna');
    expect(Number.isFinite(inst)).toBe(true);
    expect(localDateStr(inst, 'Europe/Vienna')).toBe('2026-03-29');
  });

  test('resolves across the fall-back overlap', () => {
    // 2026-10-25 02:30 local happens twice in Vienna. Either is defensible;
    // what matters is that it is a real instant on the right day.
    const inst = localWallInstant('2026-10-25', '02:30:00', 'Europe/Vienna');
    expect(Number.isFinite(inst)).toBe(true);
    expect(localDateStr(inst, 'Europe/Vienna')).toBe('2026-10-25');
  });
});

describe('localDayBounds', () => {
  test('a normal day is exactly 24h and end is the last millisecond', () => {
    const { start, end } = localDayBounds('2026-06-10', 'Europe/Vienna');
    expect(end - start).toBe(24 * HOUR - 1);
    expect(localDateStr(start, 'Europe/Vienna')).toBe('2026-06-10');
    expect(localDateStr(end, 'Europe/Vienna')).toBe('2026-06-10');
    // The very next millisecond belongs to the next day — no gap, no overlap.
    expect(localDateStr(end + 1, 'Europe/Vienna')).toBe('2026-06-11');
  });

  test('spring-forward days are 23h, fall-back days are 25h', () => {
    // This is the case that makes duration-based "is it the same day?" wrong,
    // and why the spec compares date strings instead.
    expect(hoursIn('2026-03-29', 'Europe/Vienna')).toBe(23);
    expect(hoursIn('2026-10-25', 'Europe/Vienna')).toBe(25);
    expect(hoursIn('2026-03-08', 'America/New_York')).toBe(23);
    expect(hoursIn('2026-11-01', 'America/New_York')).toBe(25);
    // A zone without DST never varies.
    expect(hoursIn('2026-03-29', 'Asia/Kolkata')).toBe(24);
    expect(hoursIn('2026-10-25', 'Asia/Kolkata')).toBe(24);
  });

  test('bounds contain every instant of that local day and nothing else', () => {
    const tz = 'America/New_York';
    const { start, end } = localDayBounds('2026-11-01', tz); // the 25h day
    expect(localDateStr(start - 1, tz)).toBe('2026-10-31');
    expect(localDateStr(end + 1, tz)).toBe('2026-11-02');
    for (let t = start; t <= end; t += 90 * MINUTE) {
      expect(localDateStr(t, tz)).toBe('2026-11-01');
    }
  });
});

describe('getUserTz', () => {
  beforeEach(() => {
    db.exec('DELETE FROM users;');
  });

  function makeUser(timezone) {
    const id = randomUUID();
    db.prepare('INSERT INTO users (id, username, password_hash, avatar, created_at, timezone) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, `u-${id.slice(0, 8)}`, 'x', '☕', Date.now(), timezone);
    return id;
  }

  test('returns the stored zone', () => {
    expect(getUserTz(db, makeUser('Europe/Vienna'))).toBe('Europe/Vienna');
    expect(getUserTz(db, makeUser('Asia/Kathmandu'))).toBe('Asia/Kathmandu');
  });

  test('falls back to UTC for an unknown user', () => {
    expect(getUserTz(db, 'no-such-user')).toBe(DEFAULT_TZ);
  });

  test('falls back to UTC for a corrupt stored zone', () => {
    // A stored abbreviation is corrupt data — it must not be handed to Intl,
    // which would throw deep inside civil logic instead of degrading to UTC.
    expect(getUserTz(db, makeUser('CEST'))).toBe(DEFAULT_TZ);
    expect(getUserTz(db, makeUser('Mars/Olympus'))).toBe(DEFAULT_TZ);
    expect(getUserTz(db, makeUser(''))).toBe(DEFAULT_TZ);
  });

  // getUserTz also guards `row.timezone == null`, which the schema makes
  // unreachable: migration 008 added the column as
  // `TEXT NOT NULL DEFAULT 'UTC'`, so an INSERT of null throws before the
  // read. Asserted here so the guard is understood as belt-and-braces rather
  // than dead code someone deletes, and so this test fails loudly if a future
  // migration ever drops the constraint.
  test('the schema forbids a null zone outright', () => {
    expect(() => makeUser(null)).toThrow(/NOT NULL constraint failed: users\.timezone/);
    const cols = db.prepare('PRAGMA table_info(users)').all();
    expect(cols.find(c => c.name === 'timezone')).toMatchObject({ notnull: 1, dflt_value: "'UTC'" });
  });

  test('DEFAULT_TZ is UTC', () => {
    expect(DEFAULT_TZ).toBe('UTC');
  });
});

// The scenario issue #16 names explicitly. The rule from the spec is that a
// timezone change applies GOING FORWARD ONLY — the stored instants are
// absolute and are never rewritten, but every civil question asked after the
// move is answered in the new zone.
describe('a user who moves timezones', () => {
  beforeEach(() => {
    db.exec('DELETE FROM coffee_entries; DELETE FROM users;');
  });

  function makeUser(timezone) {
    const id = randomUUID();
    db.prepare('INSERT INTO users (id, username, password_hash, avatar, created_at, timezone) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, `u-${id.slice(0, 8)}`, 'x', '☕', Date.now(), timezone);
    return id;
  }

  test('the stored instant never changes, only its civil reading', () => {
    const id = makeUser('Europe/Vienna');
    // 23:30 in Vienna on the 15th — late evening at home.
    const loggedAt = localWallInstant('2026-01-15', '23:30:00', 'Europe/Vienna');
    db.prepare('INSERT INTO coffee_entries (id, user_id, coffee_id, caffeine_mg, logged_at) VALUES (?, ?, ?, ?, ?)')
      .run(randomUUID(), id, 'espresso', 63, loggedAt);

    expect(localDateStr(loggedAt, getUserTz(db, id))).toBe('2026-01-15');

    // The user flies to New York; the client PATCHes the new zone.
    db.prepare('UPDATE users SET timezone = ? WHERE id = ?').run('America/New_York', id);

    const row = db.prepare('SELECT logged_at FROM coffee_entries WHERE user_id = ?').get(id);
    expect(row.logged_at).toBe(loggedAt); // untouched — instants are immutable

    // Same row, read in the new zone: 17:30 on the 15th. Same day here, but
    // the reading is genuinely recomputed, not snapshotted.
    expect(localParts(row.logged_at, getUserTz(db, id))).toMatchObject({ hour: 17, minute: 30 });
  });

  test('the same instant can be a different calendar day after the move', () => {
    const id = makeUser('Pacific/Kiritimati'); // +14
    const loggedAt = Date.parse('2026-01-15T12:00:00Z');
    db.prepare('INSERT INTO coffee_entries (id, user_id, coffee_id, caffeine_mg, logged_at) VALUES (?, ?, ?, ?, ?)')
      .run(randomUUID(), id, 'espresso', 63, loggedAt);

    expect(localDateStr(loggedAt, getUserTz(db, id))).toBe('2026-01-16');

    db.prepare('UPDATE users SET timezone = ? WHERE id = ?').run('Pacific/Niue', id); // -11
    expect(localDateStr(loggedAt, getUserTz(db, id))).toBe('2026-01-15');

    // A whole calendar day of difference from one profile update — which is
    // exactly why "today" is computed at evaluation time and never frozen
    // onto the row.
  });

  test('"today" follows the traveller, and day bounds move with them', () => {
    const id = makeUser('Europe/Vienna');
    const day = '2026-01-15';

    const vienna = localDayBounds(day, getUserTz(db, id));
    db.prepare('UPDATE users SET timezone = ? WHERE id = ?').run('America/New_York', id);
    const newYork = localDayBounds(day, getUserTz(db, id));

    // Both are 24h windows over the same label, offset by the 6h difference
    // between the zones on that date (+1 vs -5).
    expect(newYork.start - vienna.start).toBe(6 * HOUR);
    expect(newYork.end - vienna.end).toBe(6 * HOUR);

    // An 03:00 Vienna coffee falls inside the Vienna day but before the New
    // York one — the boundary genuinely moved under the same date string.
    const earlyMorning = localWallInstant(day, '03:00:00', 'Europe/Vienna');
    expect(earlyMorning >= vienna.start && earlyMorning <= vienna.end).toBe(true);
    expect(earlyMorning < newYork.start).toBe(true);
  });
});
