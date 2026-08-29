import { describe, expect, it } from 'vitest';
import {
  centsToInputValue,
  formatCents,
  formatCentsRounded,
  parseAmountToCents,
  sumCents,
} from '@/lib/money';

describe('parseAmountToCents', () => {
  it('handles the exact cases from notes §6', () => {
    expect(parseAmountToCents('5,220.00')).toBe(522_000);
    expect(parseAmountToCents('0.05')).toBe(5);
    expect(parseAmountToCents('1000000')).toBe(100_000_000);
  });

  it('does not repeat the parseFloat bug', () => {
    // parseFloat('5,220.00') returns 5 — a wrong answer that looks right.
    expect(parseAmountToCents('5,220.00')).not.toBe(5);
  });

  it('accepts what a person actually types', () => {
    expect(parseAmountToCents('$5,220.00')).toBe(522_000);
    expect(parseAmountToCents('  5220 ')).toBe(522_000);
    expect(parseAmountToCents('5220.5')).toBe(522_050);
    expect(parseAmountToCents('.50')).toBe(50);
    expect(parseAmountToCents('$ 1,234.56')).toBe(123_456);
  });

  it('rejects rather than coerces', () => {
    expect(parseAmountToCents('5.005')).toBeNull(); // three decimal places
    expect(parseAmountToCents('abc')).toBeNull();
    expect(parseAmountToCents('')).toBeNull();
    expect(parseAmountToCents('   ')).toBeNull();
    expect(parseAmountToCents('-5.00')).toBeNull();
    expect(parseAmountToCents('0')).toBeNull(); // amount_cents has check (> 0)
    expect(parseAmountToCents('0.00')).toBeNull();
    expect(parseAmountToCents('1.2.3')).toBeNull();
    expect(parseAmountToCents('5,22,0.00')).toBe(522_000); // separators stripped
    expect(parseAmountToCents('1e5')).toBeNull();
    expect(parseAmountToCents('99999999999')).toBeNull(); // above the ceiling
  });

  it('never drifts, across the whole cent range', () => {
    // 8.29 * 100 is 828.9999999999999 in floating point. Walk a range where
    // that class of error shows up and assert every value is exact.
    for (let cents = 1; cents <= 2000; cents++) {
      const asInput = centsToInputValue(cents);
      expect(parseAmountToCents(asInput)).toBe(cents);
    }
  });
});

describe('formatCents', () => {
  it('formats as $1,234.56', () => {
    expect(formatCents(123_456)).toBe('$1,234.56');
    expect(formatCents(5)).toBe('$0.05');
    expect(formatCents(0)).toBe('$0.00');
    expect(formatCents(100_000_000)).toBe('$1,000,000.00');
  });

  it('rounds only for the 44px headline, and never below it', () => {
    expect(formatCentsRounded(4_732_015)).toBe('$47,320');
    expect(formatCents(4_732_015)).toBe('$47,320.15');
  });

  it('produces no NaN for a broken input', () => {
    expect(formatCents(Number.NaN)).toBe('$0.00');
  });
});

describe('sumCents', () => {
  it('adds as integers', () => {
    const rows = [{ amount_cents: 829 }, { amount_cents: 829 }, { amount_cents: 829 }];
    expect(sumCents(rows)).toBe(2487);
    // The float route gives 24.869999999999997.
    expect(sumCents(rows) / 100).toBe(24.87);
  });

  it('is zero for an empty list, not NaN', () => {
    expect(sumCents([])).toBe(0);
  });
});

describe('round trip', () => {
  it('parse -> cents -> input value -> cents is stable', () => {
    for (const input of ['5,220.00', '0.05', '1000000', '9.99', '.10', '123456.78']) {
      const cents = parseAmountToCents(input)!;
      expect(cents).not.toBeNull();
      expect(parseAmountToCents(centsToInputValue(cents))).toBe(cents);
    }
  });
});
