import { buildPdf, Page, PAGE_WIDTH, type PdfResult } from './writer';
import { wrapText } from './text';
import { formatCents } from '@/lib/money';
import { formatQuantity } from '@/lib/quantity';
import { formatDayWithYear } from '@/lib/date';
import type { Business, Customer, SalesInvoice, SalesInvoiceLine } from '@/lib/types';

/**
 * The invoice, as a piece of paper. ARCHITECTURE §48.
 *
 * ===========================================================================
 * The second copy of one document, and why it is allowed here
 *
 * Notes §1.3 warns against two copies of an invoice in one file: they drift,
 * and the one that drifts is the one nobody looks at. `SalesInvoiceDocument`
 * prints ITSELF for exactly that reason, rather than rebuilding into a hidden
 * div.
 *
 * This is a second rendering of the same invoice and the warning still
 * applies -- so what stops it drifting is that **every value on both comes
 * from the same three formatters**: `formatCents`, `formatQuantity` and
 * `formatDayWithYear`. Nothing here formats anything itself. If a total is
 * wrong on the PDF it is wrong on the screen too, which is the property that
 * matters; what differs between them is only where the ink goes.
 *
 * The alternative -- printing to PDF through the browser -- was already
 * rejected: `window.print()` never hands the page back to the app, so there
 * is no file to share (§44.4). Print is still there and still does that job.
 * ===========================================================================
 */

const MARGIN = 45;
const RIGHT = PAGE_WIDTH - MARGIN;
/** Where the table's four columns end. Amount ends at the right margin. */
const QTY_RIGHT = 355;
const PRICE_RIGHT = 445;
const AMOUNT_RIGHT = RIGHT;
/** Description wraps inside its own column and never runs under Qty. */
const DESCRIPTION_WIDTH = QTY_RIGHT - 40 - MARGIN;

/** Below this, start a new page. Leaves room for the total and the rules. */
const PAGE_FLOOR = 700;

const GREY = 0.42;

export interface InvoicePdfInput {
  invoice: SalesInvoice;
  lines: SalesInvoiceLine[];
  business: Business | null;
  customer: Pick<Customer, 'name' | 'contact_name' | 'contact_phone' | 'contact_email'> | null;
}

/** What a saved file should be called. `DDL-0001.pdf`, or the id if unnumbered. */
export function invoiceFileName(invoice: SalesInvoice): string {
  /*
   * An unnumbered invoice is a real state, not a defensive branch: the number
   * is stamped by the database, so an invoice created offline has none until
   * it sends (CATCH_UP_015 §3). The compose screen refuses to open the
   * document in that case, but a file name is cheap to get right and a file
   * called `null.pdf` in somebody's downloads is not.
   */
  const stem = invoice.invoice_number ?? `invoice-${invoice.id.slice(0, 8)}`;
  return `${stem}.pdf`;
}

export function renderInvoicePdf({
  invoice,
  lines,
  business,
  customer,
}: InvoicePdfInput): PdfResult {
  const pages: Page[] = [];
  let page = new Page();
  pages.push(page);

  let y = MARGIN + 14;

  // ---- Who sent it -------------------------------------------------------
  page.text(business?.name ?? 'Invoice', MARGIN, y, { font: 'Helvetica-Bold', size: 18 });

  page.textRight('INVOICE', RIGHT, y - 6, { size: 7.5, grey: GREY });
  page.textRight(invoice.invoice_number ?? '', RIGHT, y + 7, { size: 11 });

  y += 14;

  /*
   * The contact block, live from the business row (§47.1). Printed exactly as
   * it was typed, one line per line, which is what `white-space: pre-line`
   * does on the screen and what this loop does here -- the same fact rendered
   * by two mechanisms, which is the drift the header note is about. It is
   * kept honest by both reading the same string and neither reformatting it.
   */
  for (const line of (business?.contact_block ?? '').split('\n')) {
    if (line.trim() === '') continue;
    page.text(line, MARGIN, y, { size: 8.5, grey: GREY });
    y += 11;
  }

  y += 22;

  // ---- To, and when ------------------------------------------------------
  const toTop = y;
  page.text('TO', MARGIN, y, { size: 7.5, grey: GREY });
  y += 13;
  page.text(customer?.name ?? '', MARGIN, y, { size: 10 });
  y += 12;

  for (const detail of [customer?.contact_name, customer?.contact_phone, customer?.contact_email]) {
    if (!detail) continue;
    page.text(detail, MARGIN, y, { size: 8.5, grey: GREY });
    y += 11;
  }

  let rightY = toTop;
  page.textRight('DATE', RIGHT, rightY, { size: 7.5, grey: GREY });
  rightY += 13;
  page.textRight(formatDayWithYear(invoice.invoice_date), RIGHT, rightY, { size: 10 });
  rightY += 16;

  /*
   * No due date prints nothing at all, not a DUE heading over a blank.
   * CATCH_UP_017, and the same rule the screen follows: a heading with
   * nothing under it reads as something that failed to load.
   */
  if (invoice.due_date) {
    page.textRight('DUE', RIGHT, rightY, { size: 7.5, grey: GREY });
    rightY += 13;
    page.textRight(formatDayWithYear(invoice.due_date), RIGHT, rightY, { size: 10 });
    rightY += 16;
  }

  y = Math.max(y, rightY) + 18;

  // ---- The table ---------------------------------------------------------
  const heading = (top: number): number => {
    page.text('DESCRIPTION', MARGIN, top, { size: 7.5, grey: GREY });
    page.textRight('QTY', QTY_RIGHT, top, { size: 7.5, grey: GREY });
    page.textRight('PRICE', PRICE_RIGHT, top, { size: 7.5, grey: GREY });
    page.textRight('AMOUNT', AMOUNT_RIGHT, top, { size: 7.5, grey: GREY });
    page.rule(MARGIN, RIGHT, top + 5);
    return top + 19;
  };

  y = heading(y);

  const rows: Array<{ description: string; qty: string; price: string; amount: string }> =
    lines.length === 0
      ? [
          {
            /* The path that predates line items: a total with no breakdown.
               Saying so beats printing an empty table. */
            description: 'Recorded without a breakdown',
            qty: '',
            price: '',
            amount: formatCents(invoice.amount_cents),
          },
        ]
      : lines.map((line) => ({
          description: line.description,
          qty: `${formatQuantity(line.quantity_milli)}${line.unit ? ` ${line.unit}` : ''}`,
          price: formatCents(line.unit_price_cents),
          amount: formatCents(line.line_total_cents),
        }));

  for (const row of rows) {
    const wrapped = wrapText(row.description, 'Helvetica', 9.5, DESCRIPTION_WIDTH);
    const height = Math.max(wrapped.length * 12, 12) + 8;

    /*
     * A new page rather than a row running off the bottom.
     *
     * The screen has `thead { display: table-header-group }` and the browser
     * repeats the headings for it. Nothing does that here, so this does --
     * and the failure it prevents is the worst one this document has: an
     * invoice whose last three lines are silently absent still shows a total
     * that includes them, so it does not look wrong, it just is.
     */
    if (y + height > PAGE_FLOOR) {
      page = new Page();
      pages.push(page);
      y = heading(MARGIN + 8);
    }

    for (const [index, text] of wrapped.entries()) {
      page.text(text, MARGIN, y + index * 12, { size: 9.5 });
    }
    page.textRight(row.qty, QTY_RIGHT, y, { size: 9.5 });
    page.textRight(row.price, PRICE_RIGHT, y, { size: 9.5 });
    page.textRight(row.amount, AMOUNT_RIGHT, y, { size: 9.5 });

    y += height;
    page.rule(MARGIN, RIGHT, y - 6, { width: 0.4, grey: 0.8 });
  }

  // ---- Total -------------------------------------------------------------
  y += 12;
  page.text('TOTAL', MARGIN, y, { size: 7.5, grey: GREY });
  page.textRight(formatCents(invoice.amount_cents), AMOUNT_RIGHT, y + 2, {
    font: 'Helvetica-Bold',
    size: 15,
  });
  y += 26;

  if (invoice.note) {
    page.rule(MARGIN, RIGHT, y, { width: 0.4, grey: 0.8 });
    y += 14;
    for (const line of wrapText(invoice.note, 'Helvetica', 9, RIGHT - MARGIN)) {
      page.text(line, MARGIN, y, { size: 9, grey: GREY });
      y += 11;
    }
    y += 6;
  }

  // ---- How to pay --------------------------------------------------------
  if (business?.bank_details) {
    page.rule(MARGIN, RIGHT, y, { width: 0.4, grey: 0.8 });
    y += 16;
    page.text('PAYMENT', MARGIN, y, { size: 7.5, grey: GREY });
    y += 13;
    for (const line of business.bank_details.split('\n')) {
      if (line.trim() === '') continue;
      page.text(line, MARGIN, y, { size: 9.5 });
      y += 12;
    }
    y += 8;
  }

  // ---- Somewhere to put a pen -------------------------------------------
  /*
   * Pinned to the bottom of the last page rather than following the content.
   *
   * On the screen it sits under whatever came before, because a web page is as
   * long as it needs to be. Paper is not: a signature block that floated up to
   * the middle of a short invoice looks like the document was cut off, and one
   * that followed a long invoice would be the reason a second page exists.
   */
  const signTop = Math.max(y + 20, PAGE_FLOOR + 40);
  const gap = 16;
  const columnWidth = (RIGHT - MARGIN - gap * 2) / 3;

  for (const [index, label] of ['RECEIVED BY', 'SIGNATURE', 'DATE'].entries()) {
    const left = MARGIN + index * (columnWidth + gap);
    page.rule(left, left + columnWidth, signTop, { width: 0.6 });
    page.text(label, left, signTop + 11, { size: 7.5, grey: GREY });
  }

  return buildPdf(pages, `Invoice ${invoice.invoice_number ?? ''}`.trim());
}
