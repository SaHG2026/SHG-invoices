'use client';

import type { Route } from 'next';
import { useEffect, useState } from 'react';
import { AppChrome } from '@/components/app/AppChrome';
import { useToast } from '@/components/ui/Toast';
import { BusinessMark } from '@/components/ui/BusinessMark';
import { useSalesInvoice } from '@/lib/queries/sales';
import { useBusinesses } from '@/lib/queries/reference';
import { useAllCustomers } from '@/lib/queries/customers';
import { formatCents } from '@/lib/money';
import {
  describeAdjustment,
  liveAdjustments,
  netCents,
} from '@/lib/derive/adjustments';
import { formatQuantity } from '@/lib/quantity';
import { formatDayWithYear } from '@/lib/date';
import { invoiceFileName, renderInvoicePdf } from '@/lib/pdf/invoice';
import { canShareFile, downloadFile, shareFile } from '@/lib/pdf/share';
import { fetchLogoBytes } from '@/lib/pdf/logo';
import { invoiceShareMessage, invoiceShareTitle } from '@/lib/pdf/message';

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
  const toast = useToast();
  const { data, isLoading, isError } = useSalesInvoice(id);
  const { data: businesses = [] } = useBusinesses();
  const { data: customers = [] } = useAllCustomers();

  /*
   * Whether this phone can hand a file to another app.
   *
   * In state rather than read during render, because `navigator` does not
   * exist on the server and a value that differs between the server's HTML and
   * the first client render is a hydration mismatch. Null means "not asked
   * yet", and the Share button is absent until the answer is yes -- never
   * disabled, and never present-then-gone.
   */
  const [canShare, setCanShare] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    /*
     * Probed with an empty PDF rather than the real one, so nothing is built
     * on mount for a page that may only ever be looked at. Safari's answer
     * depends on the file's TYPE, which this carries; it does not look at the
     * bytes.
     */
    setCanShare(canShareFile(new File([], 'invoice.pdf', { type: 'application/pdf' })));
  }, []);

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
  /* Live only: a voided adjustment is kept for ever and must never reach the
     paper, or a customer receives an invoice quoting a discount that was
     taken back. §53. */
  const adjustments = liveAdjustments(invoice);
  const business = businesses.find((entry) => entry.id === invoice.business_id);
  const customer = customers.find((entry) => entry.id === invoice.customer_id);

  /**
   * Build the file, and say so when a character could not survive the trip.
   *
   * `lossy` is not decoration. The PDF uses the fonts every viewer already
   * has, whose alphabet is Latin-1 — so a name in Devanagari becomes question
   * marks, and a customer receiving a document with their name spelled in
   * punctuation is worse than being told beforehand. Print is unaffected and
   * the message says so, because that is the way out rather than a limitation
   * with no answer.
   */
  async function build(): Promise<File> {
    /*
     * The mark is fetched at the moment it is needed, not held in state.
     *
     * It is wanted twice at most in the life of this screen and never on
     * arrival, so loading it on mount would spend a request on every person
     * who opens an invoice to look at it. `fetchLogoBytes` answers null for
     * every failure there is -- no artwork, no signal, a PNG, a progressive
     * JPEG -- and the document prints the business name instead. A missing
     * logo is never the reason somebody cannot download an invoice.
     */
    const logo = await fetchLogoBytes(business?.code);

    const { bytes, lossy } = renderInvoicePdf({
      invoice,
      lines,
      business: business ?? null,
      customer: customer ?? null,
      logo,
    });

    if (lossy) {
      toast.show(
        'Some characters aren’t in the PDF’s font and came out as “?”. Print keeps them.',
        'queued',
      );
    }

    return new File([bytes as BlobPart], invoiceFileName(invoice), {
      type: 'application/pdf',
    });
  }

  async function onDownload() {
    setBusy(true);
    try {
      downloadFile(await build());
    } catch {
      toast.show('Couldn’t make that PDF. Print still works.', 'problem');
    } finally {
      setBusy(false);
    }
  }

  async function onShare() {
    setBusy(true);
    try {
      const outcome = await shareFile(
        await build(),
        invoiceShareTitle(invoice),
        /* The note that travels with the file. Gmail opens with this in the
           body and a cursor in it -- a starting point, not a send. §48.6. */
        invoiceShareMessage({ invoice, business: business ?? null }),
      );
      /* Backing out of a share sheet is an ordinary thing to do and gets no
         message at all. Saying "couldn't share" every time somebody changed
         their mind would teach them to ignore the one that means it. */
      if (outcome === 'failed') {
        toast.show('Couldn’t hand that to another app. Download still works.', 'problem');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppChrome back={{ href: '/customers' as Route, label: 'Customers' }}>
      <div className="no-print mb-3 flex items-center justify-between gap-3">
        <h1 className="text-h2 text-ink">Invoice {invoice.invoice_number}</h1>
      </div>

      {/*
        Three controls, and which of them appear is a fact about the phone.

        Download is always here: it is the stated main goal, and the fallback
        everywhere Share is missing — desktop browsers, older iOS. Share
        appears only when `navigator.canShare({ files })` says yes, so it is
        never a button that throws when pressed (notes §6).

        Share is what the client actually asked for. He asked for a Mail
        button that opens Gmail with the invoice attached, and **a web page
        cannot attach a file to a mail client** — `mailto:` carries a subject
        and a body and nothing else. The share sheet does the same job in the
        same three taps, through the phone's own list of apps. §48.2.
      */}
      <div className="no-print mb-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void onDownload()}
          disabled={busy}
          className="touch flex-1 whitespace-nowrap rounded-full bg-action px-4 text-sm text-action-text disabled:opacity-40"
        >
          {/* "Download", not "Download PDF". Measured at 320px with all three
              buttons up, the longer label wraps to two lines inside a 44px
              pill -- and next to Share and Print on a screen headed "Invoice
              DDL-0001", what is being downloaded is not in doubt. */}
          Download
        </button>

        {canShare ? (
          <button
            type="button"
            onClick={() => void onShare()}
            disabled={busy}
            className="touch flex-1 whitespace-nowrap rounded-full border border-action bg-action-bg px-4 text-sm text-action disabled:opacity-40"
          >
            Share
          </button>
        ) : null}

        <button
          type="button"
          onClick={() => window.print()}
          className="touch shrink-0 whitespace-nowrap rounded-full border border-hairline bg-card px-4 text-sm text-ink"
        >
          Print
        </button>
      </div>

      <p className="no-print mb-3 text-xs text-muted">
        {canShare
          ? 'Share hands the file to another app — pick Gmail and it opens with the invoice attached.'
          : 'Print opens your phone’s or laptop’s own dialog — AirPrint, or Save as PDF to send it.'}
      </p>

      {/*
        What will be in the message, shown before it goes.

        Only where Share exists, because it is the only thing that carries it.
        And shown at all because a message written by the app and sent under
        Deli's name is one they should have read once -- it opens in Gmail with
        a cursor in it, so it is a starting point rather than a send, but
        finding that out in the share sheet is finding out too late.
      */}
      {canShare ? (
        <details className="no-print mb-4 rounded-sm border border-edge bg-card px-3 py-2">
          <summary className="cursor-pointer text-xs uppercase tracking-widest text-muted">
            The message
          </summary>
          <p className="mt-2 whitespace-pre-line text-sm text-ink">
            {invoiceShareMessage({ invoice, business: business ?? null })}
          </p>
          <p className="mt-2 text-xs text-muted">
            You can change it in Gmail before you send.
          </p>
        </details>
      ) : null}

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
            {/*
              The name, and nothing else about them. Asked for: *"probably
              receiver details not needed."*

              A customer's phone number is on this document for OUR benefit,
              and the customer is the one holding it -- they know how to reach
              themselves. Three lines of the page spent telling somebody what
              they already know. It is still on the customer page, where it is
              looked up.
            */}
            <p className="text-sm text-ink">{customer?.name ?? '—'}</p>
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
              {/*
                What was invoiced, then what came off it, then what is left.
                §53, J5.

                ---------------------------------------------------------------
                The issued figure stays on the paper, and that is the point.

                Rule 5: the original is what the customer's copy says, and a
                document that quietly reprinted $460 where $500 was handed over
                would make the two disagree with no way to tell which was
                right. So the invoice keeps saying $500, the discount is a line
                under it, and the net is the last figure.

                Each adjustment prints WITH ITS REASON. §44.6 asked for that
                explicitly and §28.3 is why: "why is this bill $40 less than
                the docket" is the question this whole design exists to answer,
                and an unexplained $40 on a customer's invoice is that question
                arriving by phone instead.

                None of this appears at all when nothing has been adjusted —
                a "less $0.00" row on every invoice Deli has ever issued would
                be a feature announcing itself on documents that do not use it.
                ---------------------------------------------------------------
              */}
              {adjustments.length === 0 ? (
                <tr>
                  <td className="pt-3 text-xs uppercase tracking-widest text-muted" colSpan={3}>
                    Total
                  </td>
                  <td className="money pt-3 text-right text-h2 text-ink">
                    {formatCents(invoice.amount_cents)}
                  </td>
                </tr>
              ) : (
                <>
                  <tr>
                    <td className="pt-3 text-xs uppercase tracking-widest text-muted" colSpan={3}>
                      Invoiced
                    </td>
                    <td className="money pt-3 text-right text-ink">
                      {formatCents(invoice.amount_cents)}
                    </td>
                  </tr>

                  {adjustments.map((adjustment) => (
                    <tr key={adjustment.id}>
                      <td className="py-1 text-sm text-muted" colSpan={3}>
                        {describeAdjustment(adjustment)} — {adjustment.reason}
                      </td>
                      {/* Written as a subtraction rather than as a negative
                          number: "−$40.00" and "-40.00" are the same fact, and
                          only one of them reads as an instruction on paper. */}
                      <td className="money py-1 text-right text-ink">
                        −{formatCents(adjustment.amount_cents)}
                      </td>
                    </tr>
                  ))}

                  <tr>
                    <td
                      className="border-t border-hairline pt-2 text-xs uppercase tracking-widest text-muted"
                      colSpan={3}
                    >
                      Total due
                    </td>
                    <td className="money border-t border-hairline pt-2 text-right text-h2 text-ink">
                      {formatCents(netCents(invoice))}
                    </td>
                  </tr>
                </>
              )}
            </tfoot>
          </table>
        </div>

        {invoice.note ? (
          <p className="mt-4 border-t border-hairline pt-3 text-sm text-muted">{invoice.note}</p>
        ) : null}

        {/* ------------------------------------------------------------ *
          How to pay, and somewhere to sign. One row, low on the page.

          Asked for: *"only one signature line is plenty, parallel to the
          payment option on the left side of the page. maybe place that row
          just a little bit below. kinda saving the space."*

          Three ruled lines were a delivery docket's habit rather than an
          invoice's -- Received by, Signature and Date is what a driver hands
          over goods against -- and it spent a third of the page asking for
          one thing.

          The payment block reads LIVE from the business row rather than
          frozen onto the invoice, which is §47.1: a price is a term that was
          agreed, but a bank account is a routing instruction, and a reprinted
          unpaid invoice must not name an account that has closed.

          `items-end` is what makes it one row: the signature line sits level
          with the FOOT of the bank details, not its head, so the two read
          together rather than as two things that happen to start at once.
         * ------------------------------------------------------------ */}
        <section className="print-rule mt-10 grid grid-cols-2 items-end gap-4 border-t border-hairline pt-4">
          <div>
            {business?.bank_details ? (
              <>
                <p className="text-xs uppercase tracking-widest text-muted">Payment</p>
                <p className="mt-1 whitespace-pre-line text-sm text-ink">
                  {business.bank_details}
                </p>
              </>
            ) : null}
          </div>

          <div>
            <div className="h-8 border-b border-ink" />
            <p className="mt-1 text-xs uppercase tracking-widest text-muted">Signature</p>
          </div>
        </section>

      </article>
    </AppChrome>
  );
}
