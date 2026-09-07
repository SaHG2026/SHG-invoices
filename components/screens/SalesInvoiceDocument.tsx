'use client';

import type { Route } from 'next';
import { AppChrome } from '@/components/app/AppChrome';
import { BusinessMark } from '@/components/ui/BusinessMark';
import { useSalesInvoice } from '@/lib/queries/sales';
import { useBusinesses } from '@/lib/queries/reference';
import { useAllCustomers } from '@/lib/queries/customers';
import { formatCents } from '@/lib/money';
import { formatQuantity } from '@/lib/quantity';
import { formatDayWithYear } from '@/lib/date';

/**
 * The document. What gets printed and handed over.
 *
 * The client's word was "export", and the shape that answers it on a phone is
 * the browser's own print dialog: AirPrint on iOS, Save as PDF everywhere.
 * That is why there is no PDF library here — rule 7 rules out dependencies
 * that cost more than they save, and this one would replace something every
 * device already has and does better.
 *
 * ---------------------------------------------------------------------------
 * The page prints itself, so what is on it has to BE the document.
 *
 * Everything that is chrome — the header, the menu, the Print button — is
 * marked `no-print` and removed by the stylesheet, rather than the document
 * being rebuilt in a hidden div. Two copies of an invoice in one file is the
 * arrangement notes §1.3 warns about: they drift, and the one that drifts is
 * the one nobody looks at on screen.
 * ---------------------------------------------------------------------------
 *
 * A plain invoice, not a tax invoice: no GST line and no ABN, by the client's
 * decision (CATCH_UP_015 header). If Deli ever registers, this file and the
 * schema change together.
 */
export function SalesInvoiceDocument({ id }: { id: string }) {
  const { data, isLoading, isError } = useSalesInvoice(id);
  const { data: businesses = [] } = useBusinesses();
  const { data: customers = [] } = useAllCustomers();

  if (isLoading || isError || !data) {
    return (
      <AppChrome back={{ href: '/customers' as Route, label: 'Customers' }}>
        <h1 className="text-h2 text-ink">
          {isError ? 'Couldn’t load that invoice' : isLoading ? 'Loading…' : 'No such invoice'}
        </h1>
      </AppChrome>
    );
  }

  const { invoice, lines } = data;
  const business = businesses.find((entry) => entry.id === invoice.business_id);
  const customer = customers.find((entry) => entry.id === invoice.customer_id);

  return (
    <AppChrome back={{ href: '/customers' as Route, label: 'Customers' }}>
      <div className="no-print mb-4 flex items-center justify-between gap-3">
        <h1 className="text-h2 text-ink">Invoice {invoice.invoice_number}</h1>
        <button
          type="button"
          onClick={() => window.print()}
          className="touch shrink-0 rounded-full bg-action px-5 text-sm text-action-text"
        >
          Print
        </button>
      </div>

      <p className="no-print mb-4 text-xs text-muted">
        Print opens your phone’s or laptop’s own dialog — AirPrint, or Save as PDF to send it.
      </p>

      {/* Everything below is the document. `print-sheet` is what survives. */}
      <article className="print-sheet rounded-sm border border-edge bg-card p-5">
        <header className="mb-6 flex items-start justify-between gap-4">
          {/*
            The mark, on the document.

            Asked for: *"when we add in the logo for deli, I would like that
            logo to show up in the invoice"*. `BusinessMark` already resolves
            an uploaded logo over a bundled file over the letters, so the day
            Deli's artwork is uploaded on the Brand screen it appears here with
            no code change -- and until then the header carries "DD" rather
            than a hole where a logo will go.

            `lg` exists for exactly this. Everywhere else the mark identifies a
            row at 24-28px; here it is the top of a piece of paper somebody is
            handed.
          */}
          <div className="flex min-w-0 items-start gap-3">
            {business ? <BusinessMark business={business} size="lg" /> : null}
            <div className="min-w-0">
              <p className="text-h2 min-w-0 text-ink" style={{ fontFamily: 'var(--font-display)' }}>
                {business?.name ?? 'Invoice'}
              </p>
              {/*
                How to reach them. CATCH_UP_020.

                Under the name rather than in a corner of its own, because on
                paper this is one thing -- who sent you this -- and splitting
                it across the sheet makes a reader hunt for the second half.

                `pre-line` is the whole of how it renders: the column holds
                free text with newlines and it prints exactly as it was typed.
                Nothing here parses it, and nothing here labels it, because a
                block that says ADDRESS above a phone number is a form
                pretending to be a document.

                Absent when null, with no heading left behind (CATCH_UP_017's
                rule for the missing due date).
              */}
              {business?.contact_block ? (
                <p className="mt-1 whitespace-pre-line text-xs text-muted">
                  {business.contact_block}
                </p>
              ) : null}
            </div>
          </div>
          <div className="shrink-0 text-right">
            <p className="text-xs uppercase tracking-widest text-muted">Invoice</p>
            <p className="figure-date text-sm text-ink">{invoice.invoice_number}</p>
          </div>
        </header>

        <div className="mb-6 grid grid-cols-2 gap-4">
          <div>
            <p className="text-xs uppercase tracking-widest text-muted">To</p>
            <p className="text-sm text-ink">{customer?.name ?? '—'}</p>
            {customer?.contact_name ? (
              <p className="text-sm text-muted">{customer.contact_name}</p>
            ) : null}
            {customer?.contact_phone ? (
              <p className="text-sm text-muted">{customer.contact_phone}</p>
            ) : null}
            {customer?.contact_email ? (
              <p className="text-sm text-muted">{customer.contact_email}</p>
            ) : null}
          </div>
          <div className="text-right">
            <p className="text-xs uppercase tracking-widest text-muted">Date</p>
            <p className="figure-date text-sm text-ink">
              {formatDayWithYear(invoice.invoice_date)}
            </p>
            {/* No due date is printed as no due date, not as a blank line
                labelled Due -- a heading with nothing under it reads as
                something that failed to load. CATCH_UP_017. */}
            {invoice.due_date ? (
              <>
                <p className="mt-2 text-xs uppercase tracking-widest text-muted">Due</p>
                <p className="figure-date text-sm text-ink">
                  {formatDayWithYear(invoice.due_date)}
                </p>
              </>
            ) : null}
          </div>
        </div>

        {/*
          The table scrolls inside itself on a narrow screen and prints whole.
          A document that made the page scroll sideways would print cropped.
        */}
        <div className="mb-4 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-ink">
                <th className="py-2 text-left text-xs uppercase tracking-widest text-muted">
                  Description
                </th>
                <th className="py-2 text-right text-xs uppercase tracking-widest text-muted">
                  Qty
                </th>
                <th className="py-2 text-right text-xs uppercase tracking-widest text-muted">
                  Price
                </th>
                <th className="py-2 text-right text-xs uppercase tracking-widest text-muted">
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {lines.length === 0 ? (
                <tr className="border-b border-hairline">
                  {/*
                    An invoice recorded rather than composed — the path that
                    predates line items. It has a total and no breakdown, and
                    saying so is better than printing an empty table.
                  */}
                  <td className="py-2 text-ink" colSpan={3}>
                    Recorded without a breakdown
                  </td>
                  <td className="money py-2 text-right text-ink">
                    {formatCents(invoice.amount_cents)}
                  </td>
                </tr>
              ) : (
                lines.map((line) => (
                  <tr key={line.id} className="border-b border-hairline">
                    <td className="py-2 pr-2 text-ink">{line.description}</td>
                    {/* One line: "1.5 jar" wrapped to two at 360px, which
                        reads as two facts rather than one measurement. */}
                    <td className="money whitespace-nowrap py-2 pr-2 text-right text-ink">
                      {formatQuantity(line.quantity_milli)}
                      {line.unit ? ` ${line.unit}` : ''}
                    </td>
                    <td className="money py-2 pr-2 text-right text-ink">
                      {formatCents(line.unit_price_cents)}
                    </td>
                    <td className="money py-2 text-right text-ink">
                      {formatCents(line.line_total_cents)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
            <tfoot>
              <tr>
                <td className="pt-3 text-xs uppercase tracking-widest text-muted" colSpan={3}>
                  Total
                </td>
                <td className="money pt-3 text-right text-h2 text-ink">
                  {formatCents(invoice.amount_cents)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        {invoice.note ? (
          <p className="mt-4 border-t border-hairline pt-3 text-sm text-muted">{invoice.note}</p>
        ) : null}

        {/*
          How to pay. *"For direct pay, use our account details..."*

          Read live from the business row rather than frozen onto the invoice
          at issue, and that is the one decision in J2 worth knowing about: a
          price is a term that was agreed, but a bank account is a routing
          instruction. This app reprints an invoice at any time, and a frozen
          block would hand somebody an unpaid invoice naming an account that
          has since closed. §47.1, and CATCH_UP_020 has the argument in full.
        */}
        {business?.bank_details ? (
          <section className="print-rule mt-6 border-t border-hairline pt-3">
            <p className="text-xs uppercase tracking-widest text-muted">Payment</p>
            <p className="mt-1 whitespace-pre-line text-sm text-ink">{business.bank_details}</p>
          </section>
        ) : null}

        {/*
          Somewhere to put a pen. Confirmed with the client as exactly this and
          nothing more: three ruled lines on the paper for the person taking
          the delivery. Not a digital signature, nothing stored, nothing to
          verify -- so there is no column behind this and no state.

          It is on the screen as well as the paper, because this page prints
          ITSELF (notes §1.3): a block that existed only inside `@media print`
          is a block nobody can look at before handing it over.
        */}
        <section className="print-rule mt-8 grid grid-cols-3 gap-4 border-t border-hairline pt-4">
          <Rule label="Received by" />
          <Rule label="Signature" />
          <Rule label="Date" />
        </section>
      </article>
    </AppChrome>
  );
}

/**
 * One ruled line with a word under it.
 *
 * The line is a bottom border on an empty box with a fixed height, rather than
 * an underscore run: underscores are a font's idea of a line and come out a
 * different length in every face, which on three side by side is visible.
 */
function Rule({ label }: { label: string }) {
  return (
    <div>
      <div className="h-8 border-b border-ink" />
      <p className="mt-1 text-xs uppercase tracking-widest text-muted">{label}</p>
    </div>
  );
}
