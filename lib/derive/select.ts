/**
 * Filtering, sorting and totalling — all over the one array.
 *
 * Architecture §2: Home, Pending, the payment-run grouping, every sort and
 * the sticky footer total are derived synchronously from a single query
 * result. Notes §3 warns that a total showing everything while the list shows
 * a subset is a trust-destroying bug that looks like a display glitch. It
 * cannot happen if the total and the list are computed from the same array,
 * which is the entire reason these functions take `rows` rather than issuing
 * queries of their own.
 */

import { compareDates, type DateStr } from '../date';
import { bucketByUrgency } from './urgency';
import { sumCents } from '../money';
import type { Business, InvoiceRow } from '../types';

export type SortKey = 'due' | 'supplier' | 'amount' | 'added';

/** Spec §7.4 — a single row of pills, in this order. */
export const SORT_OPTIONS: ReadonlyArray<{ key: SortKey; label: string }> = [
  { key: 'due', label: 'Due date' },
  { key: 'supplier', label: 'Supplier' },
  { key: 'amount', label: 'Amount' },
  { key: 'added', label: 'Recently added' },
];

export interface InvoiceFilter {
  /** `null` means "All businesses". */
  businessId?: string | null;
  supplierId?: string | null;
  /** Inclusive due-date range. */
  dueFrom?: DateStr | null;
  dueTo?: DateStr | null;
  overdueOnly?: boolean;
  /** Required when `overdueOnly` is set — urgency is never self-derived. */
  today?: DateStr;
}

export function filterInvoices(
  rows: ReadonlyArray<InvoiceRow>,
  filter: InvoiceFilter,
): InvoiceRow[] {
  const { businessId, supplierId, dueFrom, dueTo, overdueOnly, today } = filter;

  if (overdueOnly && !today) {
    throw new Error('filterInvoices: overdueOnly requires `today` to be passed in');
  }

  return rows.filter((row) => {
    if (businessId && row.business_id !== businessId) return false;
    if (supplierId && row.supplier_id !== supplierId) return false;
    if (dueFrom && compareDates(row.due_date, dueFrom) < 0) return false;
    if (dueTo && compareDates(row.due_date, dueTo) > 0) return false;
    if (overdueOnly && today && compareDates(row.due_date, today) >= 0) return false;
    return true;
  });
}

/** Returns a new array; never sorts the query cache's array in place. */
export function sortInvoices(rows: ReadonlyArray<InvoiceRow>, key: SortKey): InvoiceRow[] {
  const sorted = [...rows];

  switch (key) {
    case 'due':
      sorted.sort(
        (a, b) =>
          compareDates(a.due_date, b.due_date) || a.supplier.name.localeCompare(b.supplier.name),
      );
      break;
    case 'supplier':
      sorted.sort(
        (a, b) =>
          a.supplier.name.localeCompare(b.supplier.name) || compareDates(a.due_date, b.due_date),
      );
      break;
    case 'amount':
      // Largest first — the question being asked is "what are the big ones".
      sorted.sort((a, b) => b.amount_cents - a.amount_cents);
      break;
    case 'added':
      sorted.sort((a, b) => b.created_at.localeCompare(a.created_at));
      break;
  }

  return sorted;
}

/**
 * Search by supplier name or invoice number.
 *
 * Matches loosely on purpose: somebody looking for an invoice half-remembers
 * it. "bid 11" should find Bidfood's invoice 1123, so every whitespace-
 * separated word has to appear somewhere, rather than the whole phrase
 * matching one field.
 *
 * The internal reference is searched too, even though it is no longer shown.
 * It is the only guaranteed-unique handle an invoice has, so it stays useful
 * for finding one from a bank statement or an older note.
 */
export function searchInvoices(rows: ReadonlyArray<InvoiceRow>, query: string): InvoiceRow[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...rows];

  return rows.filter((row) => {
    const haystack = [
      row.supplier.name,
      row.invoice_number ?? '',
      row.internal_ref,
      row.business.code,
      row.business.name,
    ]
      .join(' ')
      .toLowerCase();

    return words.every((word) => haystack.includes(word));
  });
}

/**
 * Only what is genuinely still owed.
 *
 * Invoices ticked off during this session stay on screen, struck through,
 * until the app is closed (lib/recently-paid.ts). They are in the same array
 * as everything else, so every figure has to say out loud that it does not
 * count them — otherwise the headline would keep including money that has
 * already left the account, which is notes §3's trust-destroying disagreement
 * with the list right under it.
 *
 * One function, called by every summary below, rather than a `.filter` at each
 * site that somebody later adds a fifth summary without.
 */
export function onlyUnpaid(rows: ReadonlyArray<InvoiceRow>): InvoiceRow[] {
  return rows.filter((row) => row.status === 'unpaid');
}

export interface OutstandingSummary {
  total_cents: number;
  invoice_count: number;
  supplier_count: number;
}

/**
 * The headline on Home: '$47,320.15 across 31 invoices · 12 suppliers'.
 * Derived from the same array the sections below it render.
 */
export function summarise(rows: ReadonlyArray<InvoiceRow>): OutstandingSummary {
  const owed = onlyUnpaid(rows);
  return {
    total_cents: sumCents(owed),
    invoice_count: owed.length,
    supplier_count: new Set(owed.map((row) => row.supplier_id)).size,
  };
}

export interface UrgencySummary {
  /** Already past due. Somebody is waiting on this money. */
  overdue: OutstandingSummary;
  /** Due from today through the next seven days, today included. */
  next7: OutstandingSummary;
}

/**
 * The two figures the dashboard leads with.
 *
 * Spec §1's second metric is that Mani opens this on Monday morning and knows
 * within three seconds what is due this week and what is already late. Those
 * are two different questions with two different answers, and a single
 * "outstanding" total answers neither — it mixes money that is a problem now
 * with money that is not yet anybody's problem.
 *
 * `next7` includes today deliberately. "Next 7 days" is read as a window
 * starting now, and an invoice due this morning belongs in what leaves the
 * account this week, not in a category of its own that the dashboard does not
 * show. The Week screen still separates them, because there the sections are
 * the point.
 *
 * Both are derived from the same array the list below them renders, so the
 * cards and the list cannot disagree (notes §3).
 */
export function summariseUrgency(
  rows: ReadonlyArray<InvoiceRow>,
  today: DateStr,
): UrgencySummary {
  // summarise filters to unpaid itself; bucketing keeps paid rows so they stay
  // in the section they were ticked off in.
  const buckets = bucketByUrgency(rows, today);
  return {
    overdue: summarise(buckets.overdue),
    next7: summarise([...buckets.today, ...buckets.week]),
  };
}

export interface BusinessSummary extends OutstandingSummary {
  business: Business;
  /** How many are already past due — the number that decides the ordering. */
  overdue_count: number;
  overdue_cents: number;
}

/**
 * One line per business for the dashboard.
 *
 * Every business appears, including the ones owing nothing: an empty row says
 * "nothing outstanding here", while a missing row is indistinguishable from a
 * business somebody forgot to set up.
 *
 * Ordered by whoever is most overdue, then by size. The dashboard's job is to
 * put the thing that needs attention at the top, and `sort_order` is a
 * housekeeping detail that knows nothing about that.
 */
export function summariseByBusiness(
  rows: ReadonlyArray<InvoiceRow>,
  businesses: ReadonlyArray<Business>,
  today: DateStr,
): BusinessSummary[] {
  return businesses
    .map((business) => {
      const mine = onlyUnpaid(rows).filter((row) => row.business_id === business.id);
      const overdue = mine.filter((row) => compareDates(row.due_date, today) < 0);
      return {
        business,
        total_cents: sumCents(mine),
        invoice_count: mine.length,
        supplier_count: new Set(mine.map((row) => row.supplier_id)).size,
        overdue_count: overdue.length,
        overdue_cents: sumCents(overdue),
      };
    })
    .sort(
      (a, b) =>
        b.overdue_cents - a.overdue_cents ||
        b.total_cents - a.total_cents ||
        a.business.sort_order - b.business.sort_order,
    );
}
