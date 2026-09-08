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
  type NameLookup,
} from './tables';
import { csvBlobFile } from '@/lib/csv';
import { xlsx, xlsxBlobFile, type Sheet } from '@/lib/xlsx';
import { zipBlobFile } from '@/lib/zip';
import type {
  Business,
  InvoiceRow,
  Profile,
  SalesInvoiceLine,
  SalesInvoiceRow,
} from '@/lib/types';

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
/**
 * The four, so a file can be named after one of them.
 *
 * Its own read rather than `useBusinesses()`, for the same reason as the
 * profiles above: this is not a hook and must not hold a cache entry open.
 * Four rows.
 */
async function readBusinesses(): Promise<Business[]> {
  const { data, error } = await supabase()
    .from('businesses')
    .select('id, name, code, sort_order, active, contact_block, bank_details')
    .order('sort_order');
  if (error) throw error;
  return (data ?? []) as Business[];
}

/**
 * The filename stem for one business: its code, lower-cased. `gmh`, `ddl`.
 *
 * The code rather than the name, because a name has spaces and apostrophes in
 * it and a filename should survive being emailed, unzipped on Windows and
 * attached again. The code is already the thing every internal reference is
 * built from (`GMH-260828-03`), so it is the name these four are filed under
 * everywhere else too.
 */
function slugOf(business: Business | undefined, all: readonly Business[]): string {
  if (business) return business.code.toLowerCase();
  /* No such business. Not an invented stem: this can only happen if a business
     id reached here that is not in the list the same call just read, which is
     a bug rather than a state, and a file called `shg-undefined-…` is how it
     would be discovered a week later. */
  throw new Error(
    all.length === 0
      ? 'Could not read the list of businesses.'
      : 'That business is no longer in the list.',
  );
}

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
 * What one download is: a format, and which business it is about.
 *
 * ---------------------------------------------------------------------------
 * `businessId: null` means every business, and it is the reason there are two
 * shapes of download rather than one.
 *
 * Asked for directly: *"choose to download it all (zip) or download of each
 * business individually, and when selected deli, it will download a csv with
 * payable and receivable on two sheets of the same excel"*.
 *
 * One business is one workbook. Every business is a zip of those workbooks
 * rather than one workbook with twelve tabs — four businesses' bills in one
 * file would put GroceryMate's suppliers one tab away from Majheri's, and the
 * first thing anybody would do is filter by business, which is a column they
 * already have inside each file.
 * ---------------------------------------------------------------------------
 */
export type ExportFormat = 'xlsx' | 'csv';

export interface ExportRequest extends ExportRange {
  /** One business, or null for all of them. */
  businessId: string | null;
  format: ExportFormat;
}

/**
 * Everything, as files, ready to be saved or shared.
 *
 * ---------------------------------------------------------------------------
 * An empty table still produces a sheet, with its headers.
 *
 * The alternative — skipping a table with no rows — means the wipe's "take
 * the export first" offer hands over two files one time and three the next,
 * and nobody can tell whether the missing one was empty or failed. A sheet
 * with a header row and nothing under it says "there were none of these",
 * which is an answer.
 * ---------------------------------------------------------------------------
 */
export interface ExportFile {
  file: File;
  /** What the row on screen is headed. */
  title: string;
  /** Row counts per table, in the order the tables appear. */
  counts: { label: string; count: number }[];
}

export interface ExportResult {
  files: ExportFile[];
  /** The totals across everything, for the sentence the screen shows. */
  counts: { bills: number; sales: number; lines: number };
}

/**
 * The tables one business gets.
 *
 * ---------------------------------------------------------------------------
 * Three for Deli, one for a grocery, and the asymmetry is the schema's.
 *
 * Only Deli issues invoices (`SALES_INVOICE_CODES`), so only Deli has a
 * receivables side or any lines. A grocery's workbook offering two empty tabs
 * would be a file explaining a feature it does not have — and §17's whole
 * argument is that the two directions are different questions, not a flag on
 * one table.
 *
 * There is deliberately no "bill lines" sheet for anybody. A supplier bill in
 * this app is a single amount with no line items, which is a real asymmetry
 * rather than an omission.
 * ---------------------------------------------------------------------------
 */
function tablesFor(
  invoices: readonly InvoiceRow[],
  sales: readonly SalesInvoiceRow[],
  lines: readonly SalesInvoiceLine[],
  names: NameLookup,
): ExportTable[] {
  const tables = [billsTable(invoices, names)];
  /* By whether this business has a receivables side at all, not by counting
     its rows. A Deli export for a quiet month must still say "0 invoices
     issued" rather than silently becoming a grocery's workbook. */
  if (sales.length > 0 || lines.length > 0) {
    tables.push(salesTable(sales, names), linesTable(sales, lines));
  }
  return tables;
}

function sheetsOf(tables: readonly ExportTable[]): Sheet[] {
  return tables.map((table) => ({
    name: table.label,
    header: table.header,
    rows: table.rows,
  }));
}

function countsOf(tables: readonly ExportTable[]) {
  return tables.map((table) => ({ label: table.label, count: table.rows.length }));
}

export async function runExport(request: ExportRequest): Promise<ExportResult> {
  const range: ExportRange = { from: request.from, to: request.to };
  if (!rangeIsUsable(range)) {
    throw new Error('Those dates are the wrong way round.');
  }

  const [profiles, businesses, invoices, sales] = await Promise.all([
    readProfiles(),
    readBusinesses(),
    readAll<InvoiceRow>('bills', (from, to) => {
      let query = withinRange(supabase().from('invoices').select(INVOICE_SELECT), range);
      if (request.businessId) query = query.eq('business_id', request.businessId);
      return query.order(BASIS_COLUMN).order('internal_ref').range(from, to);
    }),
    readAll<SalesInvoiceRow>('invoices', (from, to) => {
      let query = withinRange(supabase().from('sales_invoices').select(SALES_SELECT), range);
      if (request.businessId) query = query.eq('business_id', request.businessId);
      return query.order(BASIS_COLUMN).order('invoice_number').range(from, to);
    }),
  ]);

  const lines = await readLines(sales.map((invoice) => invoice.id));
  const names = nameLookup(profiles);
  const totals = { bills: invoices.length, sales: sales.length, lines: lines.length };

  /*
   * One business: one file, whatever the format.
   *
   * CSV cannot hold sheets, so the CSV form of a multi-table export is several
   * files — which is what §49.2 already produced and why that decision is
   * unchanged. The workbook form is the one the client asked for and is the
   * default; CSV stays because it opens anywhere, needs nothing, and both are
   * built from the same rows.
   */
  if (request.businessId !== null) {
    const business = businesses.find((entry) => entry.id === request.businessId);
    const stem = slugOf(business, businesses);
    const tables = tablesFor(invoices, sales, lines, names);

    if (request.format === 'csv') {
      return {
        files: tables.map((table) => ({
          file: csvBlobFile(
            exportFilename(`${stem}-${table.slug}`, range.from, range.to),
            renderTable(table),
          ),
          title: table.label,
          counts: [{ label: table.label, count: table.rows.length }],
        })),
        counts: totals,
      };
    }

    return {
      files: [
        {
          file: xlsxBlobFile(
            exportFilename(stem, range.from, range.to, 'xlsx'),
            sheetsOf(tables),
          ),
          title: business?.name ?? 'Everything',
          counts: countsOf(tables),
        },
      ],
      counts: totals,
    };
  }

  /*
   * Every business.
   *
   * The rows are read ONCE and split here rather than read four times. Four
   * round trips for one button on shop wifi is the cost, and the bigger reason
   * is that four separate reads of a live ledger can disagree with each other:
   * a bill entered between the second and third would appear in one workbook's
   * arithmetic and not in another's.
   */
  const perBusiness = businesses.map((business) => {
    const theirInvoices = invoices.filter((row) => row.business_id === business.id);
    const theirSales = sales.filter((row) => row.business_id === business.id);
    const theirSaleIds = new Set(theirSales.map((row) => row.id));
    const theirLines = lines.filter((line) => theirSaleIds.has(line.sales_invoice_id));
    return {
      business,
      tables: tablesFor(theirInvoices, theirSales, theirLines, names),
    };
  });

  if (request.format === 'csv') {
    /* A zip either way. Four businesses' CSVs is up to six files, and six
       separate Save taps is worse than one archive — which is the whole point
       of the client asking for a zip. */
    return {
      files: [
        {
          file: zipBlobFile(
            exportFilename('everything', range.from, range.to, 'zip'),
            perBusiness.flatMap(({ business, tables }) =>
              tables.map((table) => ({
                name: exportFilename(
                  `${slugOf(business, businesses)}-${table.slug}`,
                  range.from,
                  range.to,
                ),
                bytes: new TextEncoder().encode(renderTable(table)),
              })),
            ),
          ),
          title: 'Every business',
          counts: perBusiness.map(({ business, tables }) => ({
            label: business.name,
            count: tables.reduce((sum, table) => sum + table.rows.length, 0),
          })),
        },
      ],
      counts: totals,
    };
  }

  return {
    files: [
      {
        file: zipBlobFile(
          exportFilename('everything', range.from, range.to, 'zip'),
          perBusiness.map(({ business, tables }) => ({
            name: exportFilename(slugOf(business, businesses), range.from, range.to, 'xlsx'),
            bytes: xlsx(sheetsOf(tables)),
          })),
        ),
        title: 'Every business',
        counts: perBusiness.map(({ business, tables }) => ({
          label: business.name,
          count: tables.reduce((sum, table) => sum + table.rows.length, 0),
        })),
      },
    ],
    counts: totals,
  };
}
