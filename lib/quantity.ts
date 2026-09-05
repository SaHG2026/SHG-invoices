/**
 * Every quantity on an invoice line is an integer number of thousandths.
 *
 * ---------------------------------------------------------------------------
 * The same decision `lib/money.ts` makes, for the same reason, one column over.
 *
 * Rule 6 says money is integer cents because floats produce drift and then
 * arguments. A quantity multiplies that money, so a float here reaches the
 * total by the same route with the same result — `1.1 * 3` is
 * 3.3000000000000003, and an invoice you hand to a customer cannot have a line
 * that does not add up.
 *
 * Thousandths rather than hundredths because the unit is not always money-like:
 * 1.5 kg, 0.25 hours, 12 boxes. Three places covers every quantity anybody
 * writes on a docket and keeps the products of quantity and price inside
 * `Number.MAX_SAFE_INTEGER` by a wide margin — the ceilings below are what
 * make that a fact rather than a hope.
 * ---------------------------------------------------------------------------
 */

/** Digits, optionally a decimal point and up to three more. Nothing else. */
const CLEAN_QUANTITY = /^(?:\d+(?:\.\d{1,3})?|\.\d{1,3})$/;

/**
 * Sanity ceiling: 1,000,000.000 of anything.
 *
 * With `MAX_AMOUNT_CENTS` at 1e9, the largest product this module can be asked
 * to compute is 1e9 × 1e9 = 1e18, which is past `Number.MAX_SAFE_INTEGER`. So
 * `lineTotalCents` checks the result rather than trusting the inputs — see
 * there. In practice a line is a few kilos at a few dollars.
 */
export const MAX_QUANTITY_MILLI = 1_000_000_000;

/**
 * Parse what somebody typed into integer thousandths.
 *
 * Returns `null` for anything that is not a clean quantity, and never coerces
 * — the mirror of `parseAmountToCents`, and for the reason notes §3 gives:
 * `parseFloat` turns "1,5" into 1, which is a wrong answer rather than a
 * failure, and a wrong answer that looks right is the expensive kind.
 *
 * Built by string manipulation rather than `parseFloat(x) * 1000`, which
 * drifts: `1.005 * 1000` is 1004.9999999999999.
 */
export function parseQuantityToMilli(input: string): number | null {
  if (typeof input !== 'string') return null;

  const cleaned = input.trim().replace(/[\s ]/g, '').replace(/,/g, '');
  if (cleaned === '' || !CLEAN_QUANTITY.test(cleaned)) return null;

  const [whole = '', fraction = ''] = cleaned.split('.');
  const milli = Number(`${whole || '0'}${fraction.padEnd(3, '0')}`);

  if (!Number.isSafeInteger(milli)) return null;
  if (milli <= 0) return null; // a line for nothing is not a line
  if (milli > MAX_QUANTITY_MILLI) return null;

  return milli;
}

/**
 * '1.5', '12', '0.25' — trailing zeros trimmed.
 *
 * A quantity is not money and must not be padded like it: "12.000 boxes" reads
 * as a measurement taken to three places, which is a claim the docket did not
 * make. Money always shows two; a quantity shows what it is.
 */
export function formatQuantity(milli: number): string {
  if (!Number.isFinite(milli)) return '0';

  const sign = milli < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(milli));
  const whole = Math.floor(abs / 1000);
  const fraction = String(abs % 1000).padStart(3, '0').replace(/0+$/, '');

  return fraction === '' ? `${sign}${whole}` : `${sign}${whole}.${fraction}`;
}

/**
 * What one line comes to, in cents.
 *
 * ---------------------------------------------------------------------------
 * This function has a twin in SQL, and they must never disagree.
 *
 * `create_sales_invoice` computes the same product server-side, because the
 * total on a document handed to a customer cannot be whatever the client said
 * it was. Two implementations of one calculation is the arrangement notes §1.3
 * describes — "two paths that built a record, one of them wrong" — so the two
 * are pinned together deliberately:
 *
 *   here:  Math.round(quantity_milli * unit_price_cents / 1000)
 *   SQL:   round(quantity_milli::numeric * unit_price_cents / 1000)
 *
 * Both are exact for these magnitudes and both round half away from zero on
 * positive values, which is all either is ever given. `test/unit/quantity.test.ts`
 * asserts a table of cases, and the same table is repeated in the SQL file's
 * verification query — so the agreement is proven on both sides rather than
 * assumed on one.
 * ---------------------------------------------------------------------------
 *
 * Returns `null` rather than a wrong number when the product would leave the
 * range integers are exact in. Checked on the RESULT, not on the inputs:
 * either input can be legal on its own and the product still overflow.
 */
export function lineTotalCents(quantityMilli: number, unitPriceCents: number): number | null {
  if (!Number.isSafeInteger(quantityMilli) || !Number.isSafeInteger(unitPriceCents)) return null;
  if (quantityMilli <= 0 || unitPriceCents < 0) return null;

  const product = quantityMilli * unitPriceCents;
  if (!Number.isSafeInteger(product)) return null;

  const cents = Math.round(product / 1000);
  return Number.isSafeInteger(cents) ? cents : null;
}

/** Sum of the lines, as integers. The mirror of `sumCents`. */
export function sumLineTotals(lines: ReadonlyArray<{ line_total_cents: number }>): number {
  let total = 0;
  for (const line of lines) total += line.line_total_cents;
  return total;
}
