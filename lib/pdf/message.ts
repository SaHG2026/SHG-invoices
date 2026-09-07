import { formatDayInSentence } from '@/lib/date';
import { formatCents } from '@/lib/money';
import type { Business, SalesInvoice } from '@/lib/types';

/**
 * The note that travels with the invoice. ARCHITECTURE §48.6.
 *
 * ===========================================================================
 * What this is, and what carries it
 *
 * Asked for: *"need to add auto generate message to attach: Dear customer,
 * please find the invoice for your ______ delivery."*
 *
 * `navigator.share({ files, title, text })` hands all three to the phone, and
 * Gmail puts `text` in the body and `title` in the subject. So the message is
 * not a feature of this app so much as a field on a call the app was already
 * making — which is why it is a pure function of the invoice and nothing here
 * holds state.
 *
 * It is a STARTING POINT, not a send. Gmail opens with this in the body and a
 * cursor in it; anything Deli wants to add, they add before sending. Nothing
 * is sent by this app, ever, and there is no mail account anywhere near it.
 *
 * ---------------------------------------------------------------------------
 * The blank, and why it is the invoice date
 *
 * *"your ______ delivery"* was left blank on purpose and the client chose the
 * invoice date. It is the one field that is always present, cannot be wrong,
 * and is what a customer matches against their own paperwork. A month would
 * read better for a regular customer and be wrong the moment there are two
 * deliveries in one — and this app does not know what was delivered, only what
 * was charged, so the goods were never an option.
 *
 * The date goes through `lib/date.ts` like every other date in the app, but
 * through `formatDayInSentence` rather than the document's
 * `formatDayWithYear`: "Due — Sat 5 Sep 2026" reads well in a labelled field
 * and "your Sat 5 Sep 2026 delivery" does not. Prose and a field want
 * different shapes; both live in `lib/date.ts` (rule 2) and nothing here
 * assembles a date itself.
 * ---------------------------------------------------------------------------
 */

/** The subject line, when the app it is handed to has one. */
export function invoiceShareTitle(invoice: SalesInvoice): string {
  return `Invoice ${invoice.invoice_number ?? ''}`.trim();
}

/**
 * The body. Plain text, because that is what a share sheet carries.
 *
 * The last two lines are there so the message stands alone if the attachment
 * is opened later or forwarded: an email saying only "please find the invoice"
 * is one nobody can file without opening the file.
 */
export function invoiceShareMessage({
  invoice,
  business,
}: {
  invoice: SalesInvoice;
  business: Business | null;
}): string {
  const lines = [
    'Dear customer,',
    '',
    `Please find the invoice for your ${formatDayInSentence(invoice.invoice_date)} delivery.`,
    '',
  ];

  if (business?.name) lines.push(business.name);

  /*
   * The number and the total, as one line.
   *
   * An unnumbered invoice is a real state -- the number is stamped by the
   * database, so one created offline has none until it sends (CATCH_UP_015
   * §3) -- and "Invoice  — $88.49" with a hole in it is worse than no line at
   * all, so the parts are assembled rather than templated.
   */
  const reference = [
    invoice.invoice_number ? `Invoice ${invoice.invoice_number}` : null,
    formatCents(invoice.amount_cents),
  ]
    .filter((part): part is string => part !== null)
    .join(' — ');

  lines.push(reference);

  return lines.join('\n');
}
