import { monthOf, msSince } from '../date';
import { VENUE_EDIT_WINDOW_MS } from '../constants';
import { sumCents } from '../money';
import type { StaffInvoice } from '../types';

/**
 * How a venue's own invoices are grouped for reading.
 *
 * ---------------------------------------------------------------------------
 * What is deliberately absent, and why it is the whole design
 *
 * There is no urgency here, no "due this week", no overdue treatment, and no
 * outstanding total. Not because they would be hard — `lib/derive/urgency.ts`
 * already exists — but because every one of them would be a lie or a leak:
 *
 *   * A venue cannot see payment status (CATCH_UP_010 §3). So an "overdue"
 *     badge would sit on invoices that were paid a fortnight ago. The app
 *     would be stating something false, which is worse than saying nothing.
 *
 *   * "What this venue owes" IS the payment status, computed. Any figure that
 *     separates settled from unsettled hands over exactly the fact the view
 *     was built to withhold — and it would do it in a number, which is harder
 *     to notice than a column.
 *
 * So the only figures here are records of what was entered: how many, and for
 * how much. Both move when somebody logs an invoice and never when somebody
 * pays one, which is the property that makes them safe to show.
 * ---------------------------------------------------------------------------
 *
 * ARCHITECTURE §2 still holds — every figure below is derived from the same
 * array the list renders, so a heading cannot disagree with the rows beneath
 * it.
 */

export interface VenueMonth {
  /** '2026-09' — sorts correctly as a string, which is why it is one. */
  key: string;
  invoices: StaffInvoice[];
  /** What was entered in this month. Not what is owed; see above. */
  total_cents: number;
}

/**
 * Newest month first, and newest invoice first inside it.
 *
 * Grouped by the date on the docket rather than by when it was typed. A
 * delivery that arrived on the 30th and was entered on the 2nd belongs to the
 * month it happened in — that is the month the person is looking for when they
 * ask whether it was logged.
 */
export function byMonth(rows: readonly StaffInvoice[]): VenueMonth[] {
  const months = new Map<string, StaffInvoice[]>();

  for (const row of rows) {
    const key = monthOf(row.invoice_date);
    const bucket = months.get(key);
    if (bucket) bucket.push(row);
    else months.set(key, [row]);
  }

  return [...months.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([key, invoices]) => ({
      key,
      invoices: [...invoices].sort(compareNewestFirst),
      total_cents: sumCents(invoices),
    }));
}

/**
 * Docket date first, then when it was entered.
 *
 * The tiebreak is not decoration. A shop logs a delivery run in one sitting —
 * six invoices, all dated the same day — and without a second key their order
 * is whatever the array happened to hold, which changes between a refetch and
 * an optimistic insert. A list that reshuffles under somebody who is checking
 * it against a pile of paper is the same class of bug as §23's disappearing
 * rows: nothing is wrong with the data, and it is unusable anyway.
 */
function compareNewestFirst(a: StaffInvoice, b: StaffInvoice): number {
  if (a.invoice_date !== b.invoice_date) return a.invoice_date < b.invoice_date ? 1 : -1;
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
  return 0;
}


/**
 * Whether a venue may still correct this invoice.
 *
 * ---------------------------------------------------------------------------
 * This decides what is OFFERED. `CATCH_UP_010`'s `staff_update` policy decides
 * what is allowed, and it checks four things this cannot see — the venue, who
 * entered it, and whether it has been paid. So this being wrong shows a button
 * that fails; it does not let anybody edit anything.
 *
 * The one that matters is payment. A shop cannot be told an invoice is paid,
 * so this function cannot know either, so it cannot hide the button for that
 * reason. Inside five minutes of a shop entering something, the odds of one of
 * the four having already paid it are close enough to nil that the button is
 * offered anyway — and if it happens, the save is refused and the app says the
 * same sentence it says for every other refusal.
 * ---------------------------------------------------------------------------
 *
 * `now` is passed in rather than read here, so this stays a pure function of
 * its arguments and a test can stand at any moment it likes.
 */
export function stillCorrectable(invoice: StaffInvoice, now: number): boolean {
  const age = msSince(invoice.created_at, now);
  /*
   * A negative age means the row claims to have been created in the future —
   * a phone with a wrong clock, or an optimistic row written a moment before
   * this render. Treated as brand new rather than as expired: the window is a
   * kindness, and the failure mode of being generous is a refused save.
   */
  return age < VENUE_EDIT_WINDOW_MS;
}
