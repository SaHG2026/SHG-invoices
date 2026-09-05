import { describe, expect, it } from 'vitest';
import {
  formatQuantity,
  lineTotalCents,
  parseQuantityToMilli,
  sumLineTotals,
  MAX_QUANTITY_MILLI,
} from '@/lib/quantity';
import { parseAmountToCents } from '@/lib/money';

/**
 * Quantities, and the one calculation that has a twin in SQL.
 *
 * `lib/money.ts` has this file's sibling and the reasoning is the same: floats
 * produce drift and then arguments, and the bugs live at the two boundaries —
 * reading a typed string in, and writing a figure out.
 *
 * What is different here is `lineTotalCents`. It exists twice, once in
 * TypeScript and once inside `create_sales_invoice`, because the total on a
 * document handed to a customer cannot be whatever the client said it was. The
 * AGREEMENT table below is the pinning: the same rows appear in the
 * verification query at the bottom of the SQL file, so the two are proven to
 * match on both sides rather than assumed to on one.
 */

describe('parseQuantityToMilli', () => {
  it('reads what somebody actually types on a docket', () => {
    expect(parseQuantityToMilli('1')).toBe(1_000);
    expect(parseQuantityToMilli('12')).toBe(12_000);
    expect(parseQuantityToMilli('1.5')).toBe(1_500);
    expect(parseQuantityToMilli('0.25')).toBe(250);
    expect(parseQuantityToMilli('.5')).toBe(500);
    expect(parseQuantityToMilli('2.125')).toBe(2_125);
  });

  it('tolerates the spacing and separators people paste', () => {
    expect(parseQuantityToMilli('  1.5  ')).toBe(1_500);
    expect(parseQuantityToMilli('1,000')).toBe(1_000_000);
  });

  it('refuses rather than coercing', () => {
    // parseFloat('1,5') is 1 — a wrong answer, not a failure, which notes §3
    // names as the expensive kind.
    for (const bad of ['', ' ', 'abc', '1.2345', '-1', '0', '1.2.3', '1kg', '1e3']) {
      expect(parseQuantityToMilli(bad)).toBeNull();
    }
  });

  it('refuses a quantity past the ceiling', () => {
    expect(parseQuantityToMilli(String(MAX_QUANTITY_MILLI / 1000))).toBe(MAX_QUANTITY_MILLI);
    expect(parseQuantityToMilli(String(MAX_QUANTITY_MILLI / 1000 + 1))).toBeNull();
  });

  it('never produces a float', () => {
    for (const input of ['1.005', '0.001', '999.999', '1.1']) {
      const milli = parseQuantityToMilli(input)!;
      expect(Number.isSafeInteger(milli)).toBe(true);
    }
    // 1.005 * 1000 is 1004.9999999999999. String work is why this is 1005.
    expect(parseQuantityToMilli('1.005')).toBe(1_005);
  });
});

describe('formatQuantity', () => {
  it('trims trailing zeros, because a quantity is not money', () => {
    // "12.000 boxes" reads as a measurement taken to three places, which is a
    // claim the docket did not make. Money always shows two; this shows what
    // it is.
    expect(formatQuantity(12_000)).toBe('12');
    expect(formatQuantity(1_500)).toBe('1.5');
    expect(formatQuantity(250)).toBe('0.25');
    expect(formatQuantity(1_005)).toBe('1.005');
    expect(formatQuantity(1_050)).toBe('1.05');
  });

  it('round-trips with the parser', () => {
    for (const input of ['1', '1.5', '0.25', '12', '2.125', '999.999']) {
      expect(formatQuantity(parseQuantityToMilli(input)!)).toBe(
        input.startsWith('.') ? `0${input}` : input,
      );
    }
  });

  it('says 0 rather than something broken for nonsense', () => {
    expect(formatQuantity(Number.NaN)).toBe('0');
    expect(formatQuantity(Number.POSITIVE_INFINITY)).toBe('0');
  });
});

/**
 * The table that is repeated inside `CATCH_UP_015.sql`.
 *
 * If a row is added here it goes there too. That is the whole discipline: one
 * calculation, written twice, proven equal in both places.
 */
const AGREEMENT: ReadonlyArray<[quantity: string, price: string, cents: number]> = [
  ['1', '10.00', 1_000],
  ['12', '2.50', 3_000],
  ['1.5', '4.00', 600],
  ['0.25', '12.00', 300],
  ['2.125', '8.00', 1_700],
  ['3', '0.99', 297],
  // The rounding cases — a third of a cent each way.
  ['1.5', '0.01', 2], // 1.5 -> rounds up
  ['0.5', '0.01', 1], // 0.5 -> rounds up (half away from zero, both sides)
  ['0.4', '0.01', 0], // 0.4 -> rounds down
  ['7.777', '1.11', 863], // 863.2..., down
];

describe('lineTotalCents — the twin of the SQL', () => {
  it('agrees with the table the SQL file repeats', () => {
    for (const [quantity, price, expected] of AGREEMENT) {
      const milli = parseQuantityToMilli(quantity)!;
      const cents = parseAmountToCents(price) ?? 0;
      expect(lineTotalCents(milli, cents), `${quantity} x ${price}`).toBe(expected);
    }
  });

  it('is exact where a float would drift', () => {
    // 0.1 * 3 is 0.30000000000000004. 100 milli x 3 cents must be 0 or 1, not
    // a number with an exponent in it.
    expect(lineTotalCents(100, 3)).toBe(0);
    expect(lineTotalCents(1_100, 300)).toBe(330);
    expect(Number.isSafeInteger(lineTotalCents(2_125, 800)!)).toBe(true);
  });

  it('allows a free line at no charge', () => {
    // A price of zero is legitimate — a sample, a replacement, a credit line.
    expect(lineTotalCents(1_000, 0)).toBe(0);
  });

  it('refuses rather than returning a wrong number', () => {
    expect(lineTotalCents(0, 100)).toBeNull(); // a line for nothing
    expect(lineTotalCents(-1_000, 100)).toBeNull();
    expect(lineTotalCents(1_000, -100)).toBeNull();
    expect(lineTotalCents(1.5, 100)).toBeNull(); // a float got in somehow
  });

  it('checks the result, not the inputs', () => {
    // Both of these are legal on their own; their product is not exact.
    const huge = Number.MAX_SAFE_INTEGER;
    expect(lineTotalCents(huge, huge)).toBeNull();
  });
});

describe('sumLineTotals', () => {
  it('sums as integers, like sumCents', () => {
    expect(sumLineTotals([{ line_total_cents: 1_000 }, { line_total_cents: 297 }])).toBe(1_297);
  });

  it('is zero rather than NaN over nothing', () => {
    expect(sumLineTotals([])).toBe(0);
  });

  it('never drifts across many lines', () => {
    // Forty lines at 8.29 each. The float version of this is where cent drift
    // shows up first, and it is what notes §3 is about.
    const lines = Array.from({ length: 40 }, () => ({ line_total_cents: 829 }));
    expect(sumLineTotals(lines)).toBe(33_160);
  });
});
