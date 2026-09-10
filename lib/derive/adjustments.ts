import { sumCents } from '../money';
import type { SalesInvoiceAdjustment, SalesInvoiceRow } from '../types';

/**
 * What an invoice is actually worth after discounts and refunds.
 * ARCHITECTURE §53, J5.
 *
 * ===========================================================================
 * Every figure on Deli's side goes through here, and that is the point.
 *
 * §44.6 chose append-only rows over an edited `amount_cents` for three
 * reasons, and the third one is this file: **every total is derived.** The
 * invoice keeps saying what it said when it was issued, the adjustments say
 * what happened afterwards, and the net is worked out at the moment it is
 * shown rather than stored anywhere.
 *
 * So there is no `net_cents` column to keep in step, and no way for a total
 * to disagree with the rows a screen is displaying — which is rule 4 applied
 * to the one thing that reopens §28.3.
 * ===========================================================================
 *
 * ---------------------------------------------------------------------------
 * Why `adjustments` is REQUIRED on the row type, not optional
 *
 * Every sales query has to embed them, and a query that forgets would produce
 * a net equal to the full amount — a figure that is too HIGH, looks
 * completely ordinary, and appears in Receivables as money nobody owes.
 *
 * Optional would make that a runtime accident. Required makes it a compile
 * error at every call site that has not been visited, which is the same
 * device CATCH_UP_017 used to make a nullable due date findable rather than
 * discoverable. `tsc` is the review.
 * ---------------------------------------------------------------------------
 */

/**
 * The ones that still count.
 *
 * A voided adjustment is kept for ever (rule 5) and must never reach a
 * figure. It is filtered here, once, rather than at each call site — the
 * same reasoning `onlyOwed` gives for the review gate: with one condition it
 * is a preference, with two it is the only reason the rule cannot be
 * half-applied.
 */
export function liveAdjustments(
  row: Pick<SalesInvoiceRow, 'adjustments'>,
): SalesInvoiceAdjustment[] {
  return row.adjustments.filter((adjustment) => adjustment.voided_at === null);
}

/** How much has been taken off, in total. Zero when nothing has. */
export function adjustedCents(row: Pick<SalesInvoiceRow, 'adjustments'>): number {
  return sumCents(liveAdjustments(row));
}

/**
 * What is left: the issued amount, less what has been taken off it.
 *
 * Never negative. `add_sales_adjustment` refuses an amount that would take an
 * invoice below nothing, so this cannot go negative through the app — and it
 * is clamped anyway, because a negative receivable is a customer owing minus
 * money, and that figure would spread into every screen on Deli's side as a
 * credit nobody agreed to. The database is the boundary; this is the seatbelt.
 */
export function netCents(row: Pick<SalesInvoiceRow, 'amount_cents' | 'adjustments'>): number {
  return Math.max(0, row.amount_cents - adjustedCents(row));
}

/** Whether anything has been taken off, which is what decides if a screen
 *  mentions adjustments at all. A row of "less $0.00" is noise. */
export function hasAdjustments(row: Pick<SalesInvoiceRow, 'adjustments'>): boolean {
  return liveAdjustments(row).length > 0;
}

/**
 * Sum a list of invoices at their net.
 *
 * Goes through `sumCents` rather than adding integers here, because rule 6
 * says `lib/money.ts` is where money arithmetic lives. The map is the price
 * of that and it is worth paying: one summer means one place that could ever
 * be wrong about cents.
 */
export function sumNetCents(
  rows: ReadonlyArray<Pick<SalesInvoiceRow, 'amount_cents' | 'adjustments'>>,
): number {
  return sumCents(rows.map((row) => ({ amount_cents: netCents(row) })));
}

/** 'discount' | 'refund' as a person would say it. */
export function describeAdjustment(adjustment: SalesInvoiceAdjustment): string {
  return adjustment.kind === 'refund' ? 'Refund' : 'Discount';
}
