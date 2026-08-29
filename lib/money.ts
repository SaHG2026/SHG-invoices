/**
 * Every amount in this app is an integer number of cents.
 *
 * Notes §3: floats produce cent drift, then arguments. The bugs live at the
 * two boundaries — reading a typed string in, and writing a figure out — so
 * there is exactly one function for each, and nothing else is allowed to do
 * either job.
 */

const AUD = new Intl.NumberFormat('en-AU', {
  style: 'currency',
  currency: 'AUD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Digits, optionally a decimal point and one or two more digits. Nothing else. */
const CLEAN_DECIMAL = /^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/;

/** Sanity ceiling. $10,000,000 — well above any supplier invoice, well below
 *  the point where integer arithmetic stops being exact. */
export const MAX_AMOUNT_CENTS = 1_000_000_000;

/**
 * Parse what someone typed into integer cents.
 *
 * Returns `null` for anything that is not a clean amount. It never coerces:
 * notes §3 points out `parseFloat("5,220.00")` returns 5, which is not a
 * parse failure but a wrong answer, and a wrong answer that looks like a
 * right one is the expensive kind.
 *
 * Cents are produced by string manipulation, not `parseFloat(x) * 100`,
 * because the latter drifts — 8.29 * 100 is 828.9999999999999.
 */
export function parseAmountToCents(input: string): number | null {
  if (typeof input !== 'string') return null;

  // Strip the things a person legitimately types or pastes: currency symbol,
  // ordinary and non-breaking spaces, and thousands separators.
  const cleaned = input.trim().replace(/[$\s  ]/g, '').replace(/,/g, '');

  if (cleaned === '' || !CLEAN_DECIMAL.test(cleaned)) return null;

  const [whole = '', fraction = ''] = cleaned.split('.');
  const cents = Number(`${whole || '0'}${fraction.padEnd(2, '0')}`);

  if (!Number.isSafeInteger(cents)) return null;
  if (cents <= 0) return null; // invoices.amount_cents has `check (> 0)`
  if (cents > MAX_AMOUNT_CENTS) return null;

  return cents;
}

/**
 * The one money formatter. '$1,234.56'.
 *
 * Notes §3: never hand-roll `'$' + n.toFixed(2)` in a component. Nothing in
 * components/ calls toFixed.
 */
export function formatCents(cents: number): string {
  if (!Number.isFinite(cents)) return AUD.format(0);
  return AUD.format(cents / 100);
}

/**
 * '$47,320' — the outstanding total on Home, where the cents are noise at
 * 44px. Rounds for display only; never feeds another calculation.
 */
export function formatCentsRounded(cents: number): string {
  if (!Number.isFinite(cents)) return '$0';
  return new Intl.NumberFormat('en-AU', {
    style: 'currency',
    currency: 'AUD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

/**
 * Sum as integers, convert once at the edge for display.
 *
 * Notes §3: never sum formatted strings or floats. This takes the same array
 * the list renders, which is what keeps the sticky footer total and the rows
 * on screen from ever disagreeing.
 */
export function sumCents(rows: ReadonlyArray<{ amount_cents: number }>): number {
  let total = 0;
  for (const row of rows) total += row.amount_cents;
  return total;
}

/**
 * Turn cents back into the string an amount input should show when editing an
 * existing invoice. Round-trips exactly with `parseAmountToCents`.
 */
export function centsToInputValue(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
