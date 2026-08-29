import { describe, expect, it } from 'vitest';
import { greet, timeOfDay } from '@/lib/greeting';
import { sydneyHour } from '@/lib/date';

/**
 * Sydney is UTC+10, or UTC+11 in daylight saving. So the instants below are
 * chosen to sit on the wrong side of midnight UTC wherever it matters — the
 * greeting must follow the shop, not the server.
 */

describe('timeOfDay', () => {
  it('covers all 24 hours with no gap and no overlap', () => {
    const seen = new Set<string>();
    for (let hour = 0; hour < 24; hour++) {
      const band = timeOfDay(hour);
      expect(['morning', 'afternoon', 'evening', 'night']).toContain(band);
      seen.add(band);
    }
    expect(seen.size).toBe(4);
  });

  it('places the boundaries where the table in §16 says', () => {
    expect(timeOfDay(4)).toBe('night');
    expect(timeOfDay(5)).toBe('morning');
    expect(timeOfDay(11)).toBe('morning');
    expect(timeOfDay(12)).toBe('afternoon');
    expect(timeOfDay(16)).toBe('afternoon');
    expect(timeOfDay(17)).toBe('evening');
    expect(timeOfDay(21)).toBe('evening');
    expect(timeOfDay(22)).toBe('night');
    expect(timeOfDay(0)).toBe('night');
  });
});

describe('greet', () => {
  it('reads the clock in Sydney, not on the machine', () => {
    // 2026-08-28T23:00Z is 9am on Saturday 29 August in Sydney (UTC+10).
    // In UTC it is still late evening on the 28th.
    const sydneyMorning = new Date('2026-08-28T23:00:00.000Z');
    expect(sydneyHour(sydneyMorning)).toBe(9);
    expect(greet('Sujan', sydneyMorning)).toBe('Good morning, Sujan');
  });

  it('gives each of the four greetings at the right time', () => {
    // All four are the same Sydney day, 29 August 2026 (UTC+10).
    expect(greet('Sujan', new Date('2026-08-28T23:00:00.000Z'))).toBe('Good morning, Sujan'); // 09:00
    expect(greet('Mani', new Date('2026-08-29T04:00:00.000Z'))).toBe('Afternoon, Mani'); // 14:00
    expect(greet('Milan', new Date('2026-08-29T09:00:00.000Z'))).toBe('Evening, Milan'); // 19:00
    expect(greet('Rabindra', new Date('2026-08-29T13:00:00.000Z'))).toBe('Late night, Rabindra?'); // 23:00
  });

  it('is correct during daylight saving, when Sydney is UTC+11', () => {
    // 2026-01-15T22:00Z is 9am on the 16th in Sydney.
    expect(greet('Mani', new Date('2026-01-15T22:00:00.000Z'))).toBe('Good morning, Mani');
  });

  it('obeys the copy rules — sentence case, no emoji, one question mark at most', () => {
    for (const at of [
      '2026-08-28T23:00:00.000Z',
      '2026-08-29T04:00:00.000Z',
      '2026-08-29T09:00:00.000Z',
      '2026-08-29T13:00:00.000Z',
    ]) {
      const line = greet('Sujan', new Date(at));
      expect(line).not.toMatch(/!/);
      expect(line).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(line).toContain('Sujan');
      expect(line).not.toMatch(/undefined|NaN/);
    }
  });

  it('degrades rather than greeting nobody', () => {
    expect(greet('', new Date('2026-08-28T23:00:00.000Z'))).toBe('Hello');
    expect(greet('   ', new Date('2026-08-28T23:00:00.000Z'))).toBe('Hello');
  });
});
