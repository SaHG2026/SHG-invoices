import { describe, expect, it } from 'vitest';
import {
  addDays,
  compareDates,
  daysBetween,
  formatDateTime,
  formatDay,
  formatDayWithYear,
  isDateStr,
  msUntilSydneyMidnight,
  sydneyDateOf,
  sydneyToday,
} from '@/lib/date';

/**
 * The bug this file exists to prevent, stated once:
 *
 * Sydney is UTC+10 (+11 in daylight saving). So for the first ten or eleven
 * hours of every Sydney day, UTC is still on yesterday's date. An invoice
 * logged at 9am in Hurstville is, in UTC, still the previous day. The previous
 * app filed those invoices into the wrong week. Every assertion below is a
 * version of that morning.
 */

describe('sydneyToday', () => {
  it('returns the Sydney date, not the UTC date, during the Sydney morning', () => {
    // 2026-08-28T23:00Z is 9am on Friday 29 August in Sydney (UTC+10).
    const morningInSydney = new Date('2026-08-28T23:00:00.000Z');
    expect(sydneyToday(morningInSydney)).toBe('2026-08-29');
    // The naive version — the actual mechanism of the previous bug.
    expect(morningInSydney.toISOString().slice(0, 10)).toBe('2026-08-28');
  });

  it('is correct at both ends of a Sydney day', () => {
    expect(sydneyToday(new Date('2026-08-28T14:00:00.000Z'))).toBe('2026-08-29'); // 00:00
    expect(sydneyToday(new Date('2026-08-29T13:59:59.000Z'))).toBe('2026-08-29'); // 23:59
    expect(sydneyToday(new Date('2026-08-29T14:00:00.000Z'))).toBe('2026-08-30'); // 00:00 next
  });

  it('is correct during daylight saving, when Sydney is UTC+11', () => {
    // January: AEDT, UTC+11. 13:00Z is midnight on the 16th.
    expect(sydneyToday(new Date('2026-01-15T13:00:00.000Z'))).toBe('2026-01-16');
    expect(sydneyToday(new Date('2026-01-15T12:59:00.000Z'))).toBe('2026-01-15');
  });

  it('does not depend on the machine running it', () => {
    // The suite is run under TZ=UTC, TZ=Australia/Sydney and TZ=Pacific/Kiritimati
    // (UTC+14) by `npm run test:tz`. Whichever one is active, this holds.
    expect(sydneyToday(new Date('2026-08-28T23:00:00.000Z'))).toBe('2026-08-29');
  });
});

describe('addDays', () => {
  it('adds calendar days', () => {
    expect(addDays('2026-08-28', 7)).toBe('2026-09-04');
    expect(addDays('2026-08-28', 14)).toBe('2026-09-11');
    expect(addDays('2026-08-28', 30)).toBe('2026-09-27');
    expect(addDays('2026-08-28', -12)).toBe('2026-08-16');
    expect(addDays('2026-08-28', 0)).toBe('2026-08-28');
  });

  it('crosses month, year and leap-day boundaries', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29'); // 2028 is a leap year
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
  });

  it('does not shift across the Sydney daylight-saving boundaries', () => {
    // DST starts 4 Oct 2026 and ends 5 Apr 2026. A local-midnight-based
    // implementation loses or gains an hour here and can land on the wrong day.
    expect(addDays('2026-10-03', 1)).toBe('2026-10-04');
    expect(addDays('2026-10-04', 1)).toBe('2026-10-05');
    expect(addDays('2026-04-04', 1)).toBe('2026-04-05');
    expect(addDays('2026-09-28', 14)).toBe('2026-10-12'); // spans the change
  });
});

describe('daysBetween', () => {
  it('counts whole days, signed', () => {
    expect(daysBetween('2026-08-28', '2026-09-04')).toBe(7);
    expect(daysBetween('2026-08-28', '2026-08-24')).toBe(-4);
    expect(daysBetween('2026-08-28', '2026-08-28')).toBe(0);
  });

  it('is exact across a daylight-saving change', () => {
    // 23 hours or 25 hours in local time; still exactly one day.
    expect(daysBetween('2026-10-03', '2026-10-04')).toBe(1);
    expect(daysBetween('2026-04-04', '2026-04-05')).toBe(1);
    expect(daysBetween('2026-01-01', '2027-01-01')).toBe(365);
  });
});

describe('compareDates', () => {
  it('orders chronologically', () => {
    expect(compareDates('2026-08-28', '2026-09-04')).toBe(-1);
    expect(compareDates('2026-09-04', '2026-08-28')).toBe(1);
    expect(compareDates('2026-08-28', '2026-08-28')).toBe(0);
    expect(compareDates('2026-09-01', '2026-10-01')).toBe(-1); // not a string trap
  });
});

describe('isDateStr', () => {
  it('accepts real dates and rejects everything else', () => {
    expect(isDateStr('2026-08-28')).toBe(true);
    expect(isDateStr('2028-02-29')).toBe(true);
    expect(isDateStr('2026-02-31')).toBe(false);
    expect(isDateStr('2026-13-01')).toBe(false);
    expect(isDateStr('28/08/2026')).toBe(false);
    expect(isDateStr('2026-8-28')).toBe(false);
    expect(isDateStr('2026-08-28T00:00:00Z')).toBe(false);
    expect(isDateStr(null)).toBe(false);
    expect(isDateStr(undefined)).toBe(false);
  });
});

describe('formatDay', () => {
  it('always carries the weekday — spec §8', () => {
    expect(formatDay('2026-09-11')).toBe('Fri 11 Sep');
    expect(formatDay('2026-08-28')).toBe('Fri 28 Aug');
    expect(formatDay('2026-08-31')).toBe('Mon 31 Aug');
    expect(formatDayWithYear('2026-09-11')).toBe('Fri 11 Sep 2026');
  });

  it('gives the weekday of the date itself, not of the reader', () => {
    // A date-only value has no timezone. Rendering it must not shift by one.
    expect(formatDay('2026-01-01')).toBe('Thu 1 Jan');
    expect(formatDay('2026-12-31')).toBe('Thu 31 Dec');
  });
});

describe('formatDateTime', () => {
  it('renders an instant in Sydney', () => {
    // 2026-09-10T22:30Z is 8:30am on Friday 11 September in Sydney.
    expect(formatDateTime('2026-09-10T22:30:00.000Z')).toBe('11 Sep, 8:30am');
  });

  it('handles afternoon and daylight saving', () => {
    expect(formatDateTime('2026-08-29T06:02:00.000Z')).toBe('29 Aug, 4:02pm');
    expect(formatDateTime('2026-01-15T02:00:00.000Z')).toBe('15 Jan, 1:00pm'); // UTC+11
  });
});

describe('sydneyDateOf', () => {
  it('maps a timestamp to the Sydney day it happened on', () => {
    expect(sydneyDateOf('2026-08-28T23:00:00.000Z')).toBe('2026-08-29');
    expect(sydneyDateOf('2026-08-28T13:59:00.000Z')).toBe('2026-08-28');
  });
});

describe('msUntilSydneyMidnight', () => {
  it('counts down to the next Sydney midnight', () => {
    const hour = 3_600_000;
    // 14:00Z = 00:00 Sydney, so a whole day remains.
    expect(msUntilSydneyMidnight(new Date('2026-08-28T14:00:00.000Z'))).toBe(24 * hour);
    // 23:00Z = 09:00 Sydney, so 15 hours remain.
    expect(msUntilSydneyMidnight(new Date('2026-08-28T23:00:00.000Z'))).toBe(15 * hour);
  });

  it('is always a positive part-day', () => {
    for (let h = 0; h < 24; h++) {
      const at = new Date(`2026-08-28T${String(h).padStart(2, '0')}:30:00.000Z`);
      const ms = msUntilSydneyMidnight(at);
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThanOrEqual(24 * 3_600_000);
    }
  });
});
