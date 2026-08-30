import { addDays, type DateStr } from '../date';
import { parseAmountToCents, sumCents } from '../money';
import type { Invoice, Supplier } from '../types';

/**
 * History search, and the six-month spend figure on a supplier page.
 *
 * History grows without bound, so unlike the unpaid list it is filtered by the
 * database rather than in the browser (architecture §2). That means turning
 * what somebody typed into a query — carefully, because the filter is a string
 * and the input is not.
 */

/**
 * Characters that would break out of a PostgREST filter expression.
 *
 * The `or=(a.ilike.*x*,b.eq.1)` syntax is comma and parenthesis delimited, so
 * a supplier called "Smith, Jones & Co" or a stray bracket would change the
 * shape of the query rather than the value being searched for. Stripping them
 * costs a little precision and removes the whole class of problem.
 */
function sanitise(query: string): string {
  return query.trim().replace(/[,()*\\%]/g, ' ').replace(/\s+/g, ' ').trim();
}

export interface HistorySearch {
  /** A PostgREST `or` expression, or null when nothing was typed. */
  or: string | null;
  /** Supplier ids whose names matched, resolved from the cached list. */
  supplierIds: string[];
}

/**
 * Build the search for a history query. Spec §7.7: "Search by supplier,
 * invoice number, internal ref, amount."
 *
 * Supplier names are matched here rather than in SQL. The supplier list is
 * small and already in the cache, so resolving names to ids in the browser
 * avoids a join filter across two tables — and it means "bid" finds Bidfood's
 * invoices even though the word "bid" appears nowhere on the invoice row.
 */
export function buildHistorySearch(query: string, suppliers: readonly Supplier[]): HistorySearch {
  const clean = sanitise(query);
  if (clean === '') return { or: null, supplierIds: [] };

  const needle = clean.toLowerCase();
  const supplierIds = suppliers
    .filter((supplier) => supplier.name.toLowerCase().includes(needle))
    .map((supplier) => supplier.id);

  const clauses = [`invoice_number.ilike.*${clean}*`, `internal_ref.ilike.*${clean}*`];

  if (supplierIds.length > 0) {
    clauses.push(`supplier_id.in.(${supplierIds.join(',')})`);
  }

  // "5220" and "5,220.00" should both find a $5,220.00 invoice.
  const cents = parseAmountToCents(clean);
  if (cents !== null) {
    clauses.push(`amount_cents.eq.${cents}`);
  }

  return { or: clauses.join(','), supplierIds };
}

/* -------------------------------------------------------------------------- */

export interface MonthSpend {
  /** 'YYYY-MM'. */
  month: string;
  /** Short label for the axis, e.g. 'Sep'. */
  label: string;
  total_cents: number;
}

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/**
 * Rolling six months of spend with one supplier. Spec §7.5: "a plain number
 * and a sparkline, not a dashboard."
 *
 * Counted by INVOICE date rather than payment date. The question a supplier
 * page answers is "how much do we buy from them", and that is decided when the
 * goods are invoiced, not when the transfer happens to clear. Paying two
 * months late would otherwise move the spend into the wrong month.
 *
 * Every month appears, including empty ones — a gap is information, and a
 * sparkline that silently skips months is a lie about its own x-axis.
 */
export function spendByMonth(
  invoices: readonly Invoice[],
  today: DateStr,
  months = 6,
): MonthSpend[] {
  const buckets: MonthSpend[] = [];
  const [todayYear, todayMonth] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];

  for (let back = months - 1; back >= 0; back--) {
    // Month arithmetic, not day arithmetic: months are not 30 days long.
    const raw = todayMonth - 1 - back;
    const year = todayYear + Math.floor(raw / 12);
    const month = ((raw % 12) + 12) % 12;

    buckets.push({
      month: `${year}-${String(month + 1).padStart(2, '0')}`,
      label: MONTH_NAMES[month]!,
      total_cents: 0,
    });
  }

  const index = new Map(buckets.map((bucket, position) => [bucket.month, position]));

  for (const invoice of invoices) {
    if (invoice.status === 'void') continue;
    const position = index.get(invoice.invoice_date.slice(0, 7));
    if (position !== undefined) buckets[position]!.total_cents += invoice.amount_cents;
  }

  return buckets;
}

/** The headline under the sparkline. */
export function spendTotal(spend: readonly MonthSpend[]): number {
  return spend.reduce((sum, month) => sum + month.total_cents, 0);
}

/**
 * What a supplier is owed right now, and across how many invoices.
 * Voided invoices are excluded — they drop out of every total (spec §6).
 */
export function outstandingFor(invoices: readonly Invoice[]): {
  total_cents: number;
  count: number;
  oldest_due: DateStr | null;
} {
  const unpaid = invoices.filter((invoice) => invoice.status === 'unpaid');
  const oldest = unpaid.reduce<DateStr | null>(
    (earliest, invoice) =>
      earliest === null || invoice.due_date < earliest ? invoice.due_date : earliest,
    null,
  );

  return { total_cents: sumCents(unpaid), count: unpaid.length, oldest_due: oldest };
}

/** Used by the supplier page to show the window the spend figure covers. */
export function sixMonthsAgo(today: DateStr): DateStr {
  return addDays(today, -182);
}
