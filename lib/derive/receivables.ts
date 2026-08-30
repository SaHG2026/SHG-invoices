import { compareDates, type DateStr } from '../date';
import { sumCents } from '../money';
import type { SalesInvoiceRow } from '../types';

/**
 * What customers owe us, derived from the one outstanding-sales array.
 *
 * The same rule as lib/derive/select.ts, applied to the other direction: every
 * receivable figure on screen comes from the array the list beneath it
 * renders, so a total and its list cannot disagree (notes §3).
 *
 * These functions deliberately take `SalesInvoiceRow`, not a shared invoice
 * type. Nothing in this file can be handed a supplier invoice by accident,
 * which is the whole point of §17's two ledgers.
 */

export interface Receivable {
  total_cents: number;
  invoice_count: number;
  /** Past due — theirs to explain, and the number worth chasing. */
  overdue_cents: number;
  overdue_count: number;
  /** The oldest thing still unpaid, which is how long this has been going on. */
  oldest_due: DateStr | null;
}

const EMPTY: Receivable = {
  total_cents: 0,
  invoice_count: 0,
  overdue_cents: 0,
  overdue_count: 0,
  oldest_due: null,
};

/** Only what is genuinely still owed to us. Received and void never count. */
export function onlyOutstanding(rows: ReadonlyArray<SalesInvoiceRow>): SalesInvoiceRow[] {
  return rows.filter((row) => row.status === 'outstanding');
}

export function summariseReceivable(
  rows: ReadonlyArray<SalesInvoiceRow>,
  today: DateStr,
): Receivable {
  const owed = onlyOutstanding(rows);
  if (owed.length === 0) return EMPTY;

  const overdue = owed.filter((row) => compareDates(row.due_date, today) < 0);
  const oldest = owed.reduce(
    (earliest, row) => (compareDates(row.due_date, earliest) < 0 ? row.due_date : earliest),
    owed[0]!.due_date,
  );

  return {
    total_cents: sumCents(owed),
    invoice_count: owed.length,
    overdue_cents: sumCents(overdue),
    overdue_count: overdue.length,
    oldest_due: oldest,
  };
}

/** Outstanding per customer, for the list. Keyed by customer id. */
export function receivableByCustomer(
  rows: ReadonlyArray<SalesInvoiceRow>,
  today: DateStr,
): Map<string, Receivable> {
  const byCustomer = new Map<string, SalesInvoiceRow[]>();
  for (const row of onlyOutstanding(rows)) {
    const bucket = byCustomer.get(row.customer_id);
    if (bucket) bucket.push(row);
    else byCustomer.set(row.customer_id, [row]);
  }

  const out = new Map<string, Receivable>();
  for (const [customerId, invoices] of byCustomer) {
    out.set(customerId, summariseReceivable(invoices, today));
  }
  return out;
}
