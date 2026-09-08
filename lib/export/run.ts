'use client';

/**
 * Reading the whole ledger out. ARCHITECTURE §49.3.
 *
 * ===========================================================================
 * The one place in this app where a second query is correct.
 *
 * Rule 4 — one array, one total — exists because a figure computed from a
 * separate query is a figure that can disagree with the list above it. That
 * rule is about a SCREEN. Nothing here renders, nothing here is totalled
 * against anything, and the screens' own arrays cannot be reused for a reason
 * that has nothing to do with the rule: they stop. `useHistory` returns 50
 * rows (`HISTORY_PAGE_SIZE`) and `useSupplierInvoices` 300, and an export
 * built on either would be quietly short — the failure §35.4 refused for the
 * supplier range, arriving in a file somebody keeps.
 *
 * So this asks its own question, and the answer is bounded and refused rather
 * than truncated. §44.5.
 * ===========================================================================
 *
 * ---------------------------------------------------------------------------
 * Not a `useQuery`, and not a mutation either.
 *
 * A cache entry holding two years of invoices would sit in memory for the rest
 * of the session for the sake of one tap, and be stale the moment anybody
 * logged a bill. And it is not a write, so it must stay out of the offline
 * queue entirely: `lib/offline/keys.ts` is the list of things that can be
 * replayed from a cold start, and a read that replays is a download that
 * arrives days later for no reason.
 *
 * It is a plain async function that the screen awaits. The screen owns the
 * spinner.
 * ---------------------------------------------------------------------------
 */

import { supabase } from '@/lib/supabase/browser';
import { EXPORT_MAX_ROWS, EXPORT_PAGE_SIZE } from '@/lib/constants';
import { compareDates, isDateStr, type DateStr } from '@/lib/date';
import {
  billsTable,
  exportFilename,
  linesTable,
  nameLookup,
  renderTable,
  salesTable,
  type ExportTable,
} from './tables';
import { csvBlobFile } from '@/lib/csv';
import type { InvoiceRow, Profile, SalesInvoiceLine, SalesInvoiceRow } from '@/lib/types';

/**
 * Both ends optional, and both meaning what they say.
 *
 * Null is "no bound on this side", not "today" and not "the beginning of the
 * data". The wipe (§49.5) asks for the export with both ends null, because
 * "everything that is about to be deleted" is genuinely unbounded, and a
 * report for a month sets both.
 */
export interface ExportRange {
  from: DateStr | null;
  to: DateStr | null;
}

/**
 * The basis is `invoice_date` and there is no choice about it.
 *
 * `useSupplierRange` makes the caller pick between due date and invoice date
 * and labels which it used, because "what falls due in October" and "what they
 * billed us in October" are different questions and neither default is safe.
 * That is a screen answering a question. This is a record leaving the app, and
 * the date on the paper is the one a record is filed under — a due date is a
 * plan, and half the sales invoices do not have one at all (CATCH_UP_017).
 *
 * Stated here rather than offered as a second control, because a range export
 * with two radio buttons is a screen asking somebody to make a decision they
 * have no way to make.
 */
const BASIS_COLUMN = 'invoice_date';

export class ExportTooLarge extends Error {
  constructor(public readonly what: string) {
    super(
      `That range covers more than ${EXPORT_MAX_ROWS.toLocaleString('en-AU')} ${what}. ` +
        'Choose a shorter period.',
    );
    this.name = 'ExportTooLarge';
  }
}

/**
 * Read every row a query matches, a page at a time.
 *
 * ---------------------------------------------------------------------------
 * PostgREST answers at most 1000 rows and does not say so.
 *
 * There is no error and no flag — a request for "every invoice" against a
 * table of 1,400 returns 1,000 of them and looks exactly like a complete
 * answer. This is the trap that makes an unpaginated read the wrong words for
 * what §44.5 asked for: the read has to be paged, or the file is short and
 * nothing in the app can tell.
 *
 * The ceiling is the `useSupplierRange` lesson (§35.4) applied to a file: at
 * the limit this THROWS rather than returning what it has. A refused export
 * can be narrowed and asked for again; a short one gets filed.
 * ---------------------------------------------------------------------------
 */
async function readAll<T>(
  what: string,
  page: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<T[]> {
  const rows: T[] = [];

  for (let offset = 0; ; offset += EXPORT_PAGE_SIZE) {
    if (offset >= EXPORT_MAX_ROWS) throw new ExportTooLarge(what);

    const { data, error } = await page(offset, offset + EXPORT_PAGE_SIZE - 1);
    if (error) throw error;

    const batch = (data ?? []) as T[];
    rows.push(...batch);

    // A short page is the last page. A full one might be, and asking once more
    // is one request against being wrong.
    if (batch.length < EXPORT_PAGE_SIZE) return rows;
  }
}

/** `.gte`/`.lte` applied only for the ends that were given. */
function withinRange<Q extends { gte: (c: string, v: string) => Q; lte: (c: string, v: string) => Q }>(
  query: Q,
  range: ExportRange,
): Q {
  let next = query;
  if (range.from !== null) next = next.gte(BASIS_COLUMN, range.from);
  if (range.to !== null) next = next.lte(BASIS_COLUMN, range.to);
  return next;
}

/**
 * A range somebody could actually have meant.
 *
 * A backwards range is refused rather than silently returning nothing: an
 * empty file looks like "there was no business that month", which is a
 * different and much worse answer than "those dates are the wrong way round".
 */
export function rangeIsUsable(range: ExportRange): boolean {
  if (range.from !== null && !isDateStr(range.from)) return false;
  if (range.to !== null && !isDateStr(range.to)) return false;
  if (range.from !== null && range.to !== null) return compareDates(range.from, range.to) <= 0;
  return true;
}

const INVOICE_SELECT =
  '*, supplier:suppliers!inner(id, name), business:businesses!inner(id, code, name)';
const SALES_SELECT = '*, customer:customers!inner(id, name)';

/**
 * Everyone who has ever touched a row, active or not.
 *
 * Its own read rather than `useProfiles()`, which filters to `active` — see
 * `nameLookup` in tables.ts. Six rows; the cost of getting this wrong is a
 * two-year export that cannot name whoever entered half of it.
 */
async function readProfiles(): Promise<Pick<Profile, 'id' | 'display_name'>[]> {
  const { data, error } = await supabase().from('profiles').select('id, display_name');
  if (error) throw error;
  return (data ?? []) as Pick<Profile, 'id' | 'display_name'>[];
}

/**
 * The lines belonging to the sales invoices in range, asked for by id.
 *
 * By id rather than by date, because `sales_invoice_lines` carries no date of
 * its own — the date is on its header. Reading every line in the table and
 * filtering in the browser would be simpler and would download the whole price
 * history to export one month.
 *
 * The ids go in chunks: a URL carries the `in` list, and a few hundred uuids
 * is already a long one. 100 at a time keeps it comfortably inside every
 * proxy's limit rather than discovering the limit on the day the ledger gets
 * big.
 */
const ID_CHUNK = 100;

async function readLines(invoiceIds: readonly string[]): Promise<SalesInvoiceLine[]> {
  const lines: SalesInvoiceLine[] = [];

  for (let start = 0; start < invoiceIds.length; start += ID_CHUNK) {
    const ids = invoiceIds.slice(start, start + ID_CHUNK);
    const batch = await readAll<SalesInvoiceLine>('invoice lines', (from, to) =>
      supabase()
        .from('sales_invoice_lines')
        .select('*')
        .in('sales_invoice_id', ids)
        .order('sales_invoice_id')
        .order('position')
        .range(from, to),
    );
    lines.push(...batch);
  }

  return lines;
}

/**
 * Everything, as files, ready to be saved or shared.
 *
 * ---------------------------------------------------------------------------
 * An empty table still produces a file, with its headers.
 *
 * The alternative — skipping a table with no rows — means the wipe's "take
 * the export first" offer hands over two files one time and three the next,
 * and nobody can tell whether the missing one was empty or failed. A file
 * with a header row and nothing under it says "there were none of these",
 * which is an answer.
 * ---------------------------------------------------------------------------
 */
export interface ExportResult {
  files: File[];
  /** Row counts, for the sentence the screen shows afterwards. */
  counts: { bills: number; sales: number; lines: number };
}

export async function runExport(range: ExportRange): Promise<ExportResult> {
  if (!rangeIsUsable(range)) {
    throw new Error('Those dates are the wrong way round.');
  }

  const [profiles, invoices, sales] = await Promise.all([
    readProfiles(),
    readAll<InvoiceRow>('bills', (from, to) =>
      withinRange(
        supabase().from('invoices').select(INVOICE_SELECT),
        range,
      )
        .order(BASIS_COLUMN)
        .order('internal_ref')
        .range(from, to),
    ),
    readAll<SalesInvoiceRow>('invoices', (from, to) =>
      withinRange(supabase().from('sales_invoices').select(SALES_SELECT), range)
        .order(BASIS_COLUMN)
        .order('invoice_number')
        .range(from, to),
    ),
  ]);

  const lines = await readLines(sales.map((invoice) => invoice.id));
  const names = nameLookup(profiles);

  const tables: ExportTable[] = [
    billsTable(invoices, names),
    salesTable(sales, names),
    linesTable(sales, lines),
  ];

  return {
    files: tables.map((table) =>
      csvBlobFile(exportFilename(table.slug, range.from, range.to), renderTable(table)),
    ),
    counts: { bills: invoices.length, sales: sales.length, lines: lines.length },
  };
}
