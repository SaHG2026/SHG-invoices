/**
 * What goes in an exported file, and in which column. ARCHITECTURE §49.2.
 *
 * ===========================================================================
 * Pure, and separate from the reading, deliberately.
 *
 * Fetching the whole ledger needs a browser and a session. Deciding that the
 * amount column holds `1234.56` and not `$1,234.56` needs neither, and it is
 * the half that will be wrong if either half is. So it is here, where a test
 * can hand it four rows and read the file back.
 * ===========================================================================
 *
 * ---------------------------------------------------------------------------
 * Three files, not one.
 *
 * The obvious shape is one CSV with a column saying which direction each row
 * points. That is the flag §17 refused when it made `customers` its own table
 * rather than a direction on `suppliers`, and the reason is the same one step
 * further on: a spreadsheet with a direction column cannot be summed without
 * a condition inside every formula, and the person doing the summing is not a
 * developer.
 *
 * A bill you owe and an invoice you issued are two questions. They get two
 * files. Lines get a third because a line-per-row table is the only shape a
 * spreadsheet can total, and folding them into the invoice file would repeat
 * every header across every line and make the amount column sum to nonsense.
 * ---------------------------------------------------------------------------
 */

import { centsToInputValue } from '@/lib/money';
import { formatQuantity } from '@/lib/quantity';
import { sydneyDateOf, type Timestamp } from '@/lib/date';
import { csvFile, type Cell } from '@/lib/csv';
import type { InvoiceRow, Profile, SalesInvoiceLine, SalesInvoiceRow } from '@/lib/types';

/** A file about to be written: what it is called and what is in it. */
export interface ExportTable {
  /** The filename stem. The date range and `.csv` are added by the caller. */
  slug: string;
  /** What the button says, and what the toast says afterwards. */
  label: string;
  header: readonly string[];
  rows: readonly (readonly Cell[])[];
}

/**
 * Names, by id — including people who have been deactivated.
 *
 * `useProfiles()` filters to `active`, which is right for a chip on a live
 * screen and wrong here: an export of two years of history that cannot name
 * whoever entered half of it is an export with a hole in it. Rule 5 keeps the
 * row; this keeps the name attached to it.
 */
export type NameLookup = ReadonlyMap<string, string>;

export function nameLookup(profiles: readonly Pick<Profile, 'id' | 'display_name'>[]): NameLookup {
  return new Map(profiles.map((person) => [person.id, person.display_name]));
}

/**
 * Somebody's name, or their id.
 *
 * Not blank, and not "Unknown". A profile row is never deleted (rule 5), so an
 * id with no name means this export ran against a lookup that did not include
 * them — and the id is the thing somebody can actually take to the database to
 * find out who it was. A blank cell throws the answer away.
 */
function who(id: string | null, names: NameLookup): Cell {
  if (id === null) return null;
  return names.get(id) ?? id;
}

/**
 * Money, as a spreadsheet wants it: `1234.56`.
 *
 * Through `centsToInputValue` rather than a `toFixed` written here, because
 * rule 6 says `lib/money.ts` is the only thing that turns cents into a string
 * and this is exactly the boundary that rule is about. No `$` and no thousands
 * separator: both make Excel read the column as text, and a column of text
 * cannot be summed, which is the one thing this file is for.
 */
function money(cents: number): Cell {
  return centsToInputValue(cents);
}

/**
 * A `timestamptz` as the Sydney calendar date it fell on.
 *
 * The date, not the instant. "Paid on the 3rd" is what somebody is looking
 * for, and the exact second an RPC ran is noise in a spreadsheet column. The
 * conversion goes through `lib/date.ts`, which is the only file that may hold
 * a `Date` at all (rule 2).
 */
function day(ts: Timestamp | null): Cell {
  return ts === null ? null : sydneyDateOf(ts);
}

/* -------------------------------------------------------------------------- *
 * Bills — what the four businesses were invoiced.
 * -------------------------------------------------------------------------- */

const BILL_HEADER = [
  'Reference',
  'Business',
  'Supplier',
  'Invoice number',
  'Invoice date',
  'Due date',
  'Amount',
  'Status',
  'Paid on',
  'Paid by',
  'Payment reference',
  'Entered by',
  'Entered on',
  'Approved by',
  'Approved on',
  'Void reason',
] as const;

/**
 * Every status, including void.
 *
 * The history SCREEN hides voided invoices by default because they are
 * corrections rather than history, and somebody scrolling a list wants what
 * happened, not what was undone. A file is a different thing: this is the
 * record leaving the app, and an export that silently drops rows is the
 * failure §35.4 named — a total that is quietly short. The `Status` column
 * says which is which, and a spreadsheet can filter.
 */
export function billsTable(rows: readonly InvoiceRow[], names: NameLookup): ExportTable {
  return {
    slug: 'bills',
    label: 'Bills',
    header: BILL_HEADER,
    rows: rows.map((invoice) => [
      invoice.internal_ref,
      invoice.business.name,
      invoice.supplier.name,
      invoice.invoice_number,
      invoice.invoice_date,
      invoice.due_date,
      money(invoice.amount_cents),
      invoice.status,
      day(invoice.paid_at),
      who(invoice.paid_by, names),
      invoice.payment_ref,
      who(invoice.created_by, names),
      day(invoice.created_at),
      who(invoice.approved_by, names),
      day(invoice.approved_at),
      invoice.void_reason,
    ]),
  };
}

/* -------------------------------------------------------------------------- *
 * Deli's invoices — what was sent out.
 * -------------------------------------------------------------------------- */

const SALES_HEADER = [
  'Invoice number',
  'Customer',
  'Invoice date',
  'Due date',
  'Amount',
  'Status',
  'Received on',
  'Received by',
  'Payment reference',
  'Note',
  'Issued by',
  'Issued on',
  'Void reason',
] as const;

/**
 * `received`, never `paid`.
 *
 * The vocabulary the schema chose (§17): you do not pay an invoice you issued.
 * A column headed "Paid on" in this file and "Paid on" in the bills file is
 * how the two directions end up added together by somebody who has both open.
 */
export function salesTable(rows: readonly SalesInvoiceRow[], names: NameLookup): ExportTable {
  return {
    slug: 'deli-invoices',
    label: 'Deli’s invoices',
    header: SALES_HEADER,
    rows: rows.map((invoice) => [
      invoice.invoice_number,
      invoice.customer.name,
      invoice.invoice_date,
      invoice.due_date,
      money(invoice.amount_cents),
      invoice.status,
      day(invoice.received_at),
      who(invoice.received_by, names),
      invoice.payment_ref,
      invoice.note,
      who(invoice.created_by, names),
      day(invoice.created_at),
      invoice.void_reason,
    ]),
  };
}

/* -------------------------------------------------------------------------- *
 * The lines on those invoices.
 * -------------------------------------------------------------------------- */

const LINE_HEADER = [
  'Invoice number',
  'Invoice date',
  'Customer',
  'Line',
  'Description',
  'Unit',
  'Quantity',
  'Unit price',
  'Line total',
] as const;

/**
 * Lines, each carrying enough of its invoice to stand alone.
 *
 * Number, date and customer are repeated on every line, which looks like
 * duplication and is not: a spreadsheet has no join, so a line table without
 * them is a list of descriptions and amounts belonging to nothing. Repeating
 * three columns is what makes the file sortable and filterable by the person
 * who opens it.
 *
 * `line_total_cents` is copied, not recomputed. The database computes it
 * (CATCH_UP_015 §4) and a second multiplication here is a second answer — the
 * exact shape rule 4 exists to prevent, arriving in the one place nobody would
 * check it.
 */
export function linesTable(
  invoices: readonly SalesInvoiceRow[],
  lines: readonly SalesInvoiceLine[],
): ExportTable {
  const byInvoice = new Map(invoices.map((invoice) => [invoice.id, invoice]));

  /*
   * Ordered by invoice, then by position on the page.
   *
   * The read comes back ordered by invoice date; `position` is what puts the
   * lines of one invoice back in the order they were printed in. Without it
   * the file is right and unreadable, which for a document somebody is
   * checking against a piece of paper is the same as wrong.
   */
  const ordered = [...lines].sort((a, b) =>
    a.sales_invoice_id === b.sales_invoice_id
      ? a.position - b.position
      : a.sales_invoice_id < b.sales_invoice_id
        ? -1
        : 1,
  );

  return {
    slug: 'deli-invoice-lines',
    label: 'Deli’s invoice lines',
    header: LINE_HEADER,
    rows: ordered.map((line) => {
      const invoice = byInvoice.get(line.sales_invoice_id);
      return [
        invoice?.invoice_number ?? null,
        invoice?.invoice_date ?? null,
        invoice?.customer.name ?? null,
        // 1-based. `position` is 0-based in the database and nobody reading a
        // spreadsheet counts from zero.
        line.position + 1,
        line.description,
        line.unit,
        formatQuantity(line.quantity_milli),
        money(line.unit_price_cents),
        money(line.line_total_cents),
      ];
    }),
  };
}

/* -------------------------------------------------------------------------- *
 * Naming the file.
 * -------------------------------------------------------------------------- */

/**
 * What lands in somebody's downloads folder.
 *
 * The range is in the name, and that is the whole point of it. A folder with
 * three files called `bills.csv`, `bills (1).csv` and `bills (2).csv` is a
 * folder where nobody can say which period any of them covers — and the
 * question this export answers is always "between these two dates".
 *
 * `everything` rather than an invented pair of dates when there is no range,
 * because a filename claiming 2019-01-01 would be stating a start that nobody
 * chose. §40.1: a default is a claim.
 */
export function exportFilename(slug: string, from: string | null, to: string | null): string {
  const range = from === null && to === null ? 'everything' : `${from ?? 'start'}_${to ?? 'today'}`;
  return `shg-${slug}-${range}.csv`;
}

/** The bytes of one table. */
export function renderTable(table: ExportTable): string {
  return csvFile(table.header, table.rows);
}
