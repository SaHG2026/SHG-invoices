import { describe, expect, it } from 'vitest';
import { formatCents, parseAmountToCents, sumCents, centsToInputValue, MAX_AMOUNT_CENTS } from '@/lib/money';
import { parseQuantityToMilli, lineTotalCents, formatQuantity, sumLineTotals } from '@/lib/quantity';
import { addDays, daysBetween, compareDates, isDateStr, monthOf, sydneyToday } from '@/lib/date';

/**
 * An independent audit pass, written without reading the existing tests.
 *
 * The point is adversarial input, not the happy path: everything below is a
 * value somebody could actually produce with a thumb on a phone, or a value
 * the database could hand back, chosen to break the function rather than to
 * demonstrate it.
 */

describe('AUDIT — money never silently produces a wrong number', () => {
  it('refuses the inputs that look like numbers and are not', () => {
    for (const bad of ['', ' ', '.', '-', '-5', '1.2.3', '1,2,3.456', 'abc', '1e3',
                       '0x10', 'Infinity', 'NaN', '5 dollars', '½', '１２３']) {
      expect(parseAmountToCents(bad), `"${bad}" must not parse`).toBeNull();
    }
  });

  it('IS forgiving about a currency symbol, deliberately', () => {
    /*
     * Audited, expected a rejection, and the code is right: a dollar sign is
     * something a person legitimately types or pastes, and stripping it is
     * not coercion — the digits either side are unambiguous. Contrast '5
     * dollars' above, which is rejected, because guessing there would mean
     * guessing.
     */
    expect(parseAmountToCents('$5')).toBe(500);
    expect(parseAmountToCents('$1,234.56')).toBe(123_456);
  });

  it('refuses more than two decimal places rather than rounding money silently', () => {
    // Rounding here would make a total disagree with a docket by a cent, and
    // the disagreement would be invisible.
    expect(parseAmountToCents('1.005')).toBeNull();
    expect(parseAmountToCents('1.999')).toBeNull();
  });

  it('parses what a person actually types', () => {
    expect(parseAmountToCents('5')).toBe(500);
    expect(parseAmountToCents('5.5')).toBe(550);
    expect(parseAmountToCents('5.50')).toBe(550);
    expect(parseAmountToCents('1,234.56')).toBe(123_456);
    expect(parseAmountToCents(' 12.30 ')).toBe(1_230);
    expect(parseAmountToCents('.5')).toBe(50);
  });

  it('treats zero as a decision, not as blank', () => {
    expect(parseAmountToCents('0')).toBeNull();
    expect(parseAmountToCents('0', { allowZero: true })).toBe(0);
    expect(parseAmountToCents('0.00', { allowZero: true })).toBe(0);
  });

  it('has a ceiling, and it is enforced', () => {
    expect(parseAmountToCents('10000000')).toBe(MAX_AMOUNT_CENTS);
    expect(parseAmountToCents('10000000.01')).toBeNull();
  });

  it('round-trips through the input format without drifting', () => {
    for (const cents of [0, 1, 99, 100, 505, 123_456, 999_999_99, MAX_AMOUNT_CENTS]) {
      expect(parseAmountToCents(centsToInputValue(cents), { allowZero: true })).toBe(cents);
    }
  });

  it('sums as integers, so a hundred lines cannot drift', () => {
    // 0.1 + 0.2 in floats is the canonical failure. In cents it cannot happen.
    const rows = Array.from({ length: 1000 }, () => ({ amount_cents: 10 }));
    expect(sumCents(rows)).toBe(10_000);
    expect(sumCents([{ amount_cents: 10 }, { amount_cents: 20 }])).toBe(30);
  });

  it('formats negatives and zero without producing nonsense', () => {
    expect(formatCents(0)).toBe('$0.00');
    expect(formatCents(5)).toBe('$0.05');
    expect(formatCents(-500)).toContain('5.00');
  });
});

describe('AUDIT — quantity, and the product that goes on paper', () => {
  it('refuses junk rather than coercing it', () => {
    for (const bad of ['', '.', '-1', '0', '1.2345', 'abc', '1e3', 'Infinity']) {
      expect(parseQuantityToMilli(bad), `"${bad}" must not parse`).toBeNull();
    }
  });

  it('keeps three decimal places exactly', () => {
    expect(parseQuantityToMilli('1.005')).toBe(1_005);
    expect(parseQuantityToMilli('0.001')).toBe(1);
    expect(parseQuantityToMilli('1.5')).toBe(1_500);
  });

  it('formats without trailing zeros, because a quantity is not money', () => {
    expect(formatQuantity(12_000)).toBe('12');
    expect(formatQuantity(1_500)).toBe('1.5');
    expect(formatQuantity(1_005)).toBe('1.005');
  });

  it('agrees with the SQL twin on the documented table', () => {
    /*
     * `create_sales_invoice` computes round(qty::numeric * price / 1000) and
     * this must match it exactly, or a printed invoice disagrees with the row
     * behind it. Both round half away from zero on positive values.
     */
    const cases: Array<[number, number, number]> = [
      [1_000, 2_500, 2_500],
      [1_500, 1_240, 1_860],
      [2_500, 2_500, 6_250],
      [333, 300, 100],
      [1, 1, 0], // 0.001 x $0.01 rounds to nothing, and must not be a cent
      [500, 1, 1], // 0.5 x $0.01 = 0.5c, half away from zero -> 1
    ];
    for (const [qty, price, expected] of cases) {
      expect(lineTotalCents(qty, price), `${qty} x ${price}`).toBe(expected);
    }
  });

  it('returns null rather than a wrong number when the product overflows', () => {
    expect(lineTotalCents(1_000_000_000, 1_000_000_000)).toBeNull();
    expect(lineTotalCents(Number.MAX_SAFE_INTEGER, 2)).toBeNull();
  });

  it('sums line totals as integers', () => {
    expect(sumLineTotals([{ line_total_cents: 1 }, { line_total_cents: 2 }])).toBe(3);
  });
});

describe('AUDIT — dates, the worst historical bug class', () => {
  it('validates real calendar dates and rejects impossible ones', () => {
    expect(isDateStr('2026-02-31')).toBe(false);
    expect(isDateStr('2026-13-01')).toBe(false);
    expect(isDateStr('2026-2-01')).toBe(false);
    expect(isDateStr('2026-02-28')).toBe(true);
    expect(isDateStr('2024-02-29')).toBe(true); // leap year
    expect(isDateStr('2026-02-29')).toBe(false);
  });

  it('crosses month, year and leap boundaries', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('survives the DST changeovers, which is why the arithmetic is in UTC', () => {
    // Sydney: DST ends first Sunday in April, starts first Sunday in October.
    expect(addDays('2026-04-04', 1)).toBe('2026-04-05');
    expect(addDays('2026-04-05', 1)).toBe('2026-04-06');
    expect(addDays('2026-10-03', 1)).toBe('2026-10-04');
    expect(addDays('2026-10-04', 1)).toBe('2026-10-05');
    expect(daysBetween('2026-04-04', '2026-04-06')).toBe(2);
    expect(daysBetween('2026-10-03', '2026-10-05')).toBe(2);
  });

  it('never returns a fractional day across DST', () => {
    // A 23- or 25-hour day divided by 24 is where "0.958 days late" comes from.
    for (const [a, b] of [['2026-04-04', '2026-04-05'], ['2026-10-03', '2026-10-04']]) {
      expect(Number.isInteger(daysBetween(a!, b!))).toBe(true);
    }
  });

  it('orders dates chronologically as plain strings', () => {
    expect(compareDates('2026-01-02', '2026-01-10')).toBe(-1);
    expect(compareDates('2025-12-31', '2026-01-01')).toBe(-1);
    expect(compareDates('2026-01-01', '2026-01-01')).toBe(0);
  });

  it('throws rather than guessing when handed a non-date', () => {
    expect(() => addDays('' as never, 1)).toThrow();
    expect(() => addDays('06/09/2026' as never, 1)).toThrow();
    expect(() => compareDates('2026-1-1' as never, '2026-01-01')).toThrow();
  });

  it('buckets by month without slipping a day either side', () => {
    expect(monthOf('2026-01-01')).toBe('2026-01');
    expect(monthOf('2026-12-31')).toBe('2026-12');
  });

  it('gives the same Sydney date whatever the machine timezone is', () => {
    // The instant is 2026-09-06 23:30 UTC = 2026-09-07 09:30 in Sydney.
    const instant = new Date(Date.UTC(2026, 8, 6, 23, 30));
    expect(sydneyToday(instant)).toBe('2026-09-07');
    // And an instant that is the previous day in Sydney.
    expect(sydneyToday(new Date(Date.UTC(2026, 8, 6, 13, 0)))).toBe('2026-09-06');
  });
});
