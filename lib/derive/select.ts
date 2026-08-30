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
  return {
    total_cents: sumCents(rows),
    invoice_count: rows.length,
    supplier_count: new Set(rows.map((row) => row.supplier_id)).size,
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
      const mine = rows.filter((row) => row.business_id === business.id);
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
