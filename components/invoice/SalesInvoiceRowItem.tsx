'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { Route } from 'next';
import { useToast } from '@/components/ui/Toast';
import { PersonChip } from '@/components/ui/PersonChip';
import { useProfiles, useCurrentProfile } from '@/lib/queries/session';
import { isOwner } from '@/lib/staff';
import { useMarkReceived, useSalesInvoice, useUnmarkReceived } from '@/lib/queries/sales';
import { formatCents } from '@/lib/money';
import { formatQuantity } from '@/lib/quantity';
import { formatDay, formatDateTime, type DateStr } from '@/lib/date';
import { formatDueLabel, URGENCY_COLOUR, URGENCY_TINT, urgencyOf } from '@/lib/derive/urgency';
import type { SalesInvoiceRow } from '@/lib/types';

/**
 * One invoice Deli has issued, which opens into the bill itself.
 *
 * ===========================================================================
 * The row IS the way in. Round F.
 *
 * The client: *"intuitively we tend to tap any invoices (receivables or
 * payables), so I would want it to expand into its bill and show the details.
 * Specially relevant in deli delights case."*
 *
 * He is right, and the payables side already worked this way —
 * `components/invoice/InvoiceRow.tsx` is a full-width button with
 * `aria-expanded` that opens a detail block in place. The sales rows were the
 * odd ones out: the invoice NUMBER was a link and the rest of the row was
 * dead, so the tappable part was the smallest text on the line.
 *
 * "Specially relevant in deli delights case" is the sharp end of it. A
 * payables row is one amount from one supplier; a Deli invoice is a docket of
 * products, and the question you have when you look at one is *what was on
 * it* — which was reachable only by leaving for the print view.
 * ===========================================================================
 *
 * The lines are fetched only when the row is opened. A receivables list of
 * thirty invoices must not be thirty line queries on arrival, and until
 * somebody taps a row nobody has asked what is on it.
 */

export function SalesInvoiceRowItem({
  row,
  today,
  showCustomer = false,
}: {
  row: SalesInvoiceRow;
  today: DateStr | null;
  /** On the receivables list, which crosses customers. Off inside one. */
  showCustomer?: boolean;
}) {
  const toast = useToast();
  const [expanded, setExpanded] = useState(false);
  /*
   * Attribution, on the side that issues rather than the side that pays.
   *
   * Spec §9 makes the chip permanent and says it appears everywhere the
   * invoice appears afterwards -- and `InvoiceRow` has done exactly that for
   * payables since Phase 2. Sales invoices simply never got it, which the
   * client noticed the moment he was using both sides daily: *"Added by
   * indicator needed on issued invoices too. and indicator of who Marked it
   * paid as well."*
   *
   * Both facts were already on the row (`created_by`, `received_by`) and were
   * being written correctly. Nothing was ever showing them.
   */
  const { data: people = [] } = useProfiles();
  const author = people.find((person) => person.id === row.created_by);
  const receiver = people.find((person) => person.id === row.received_by);
  const markReceived = useMarkReceived();
  const unmarkReceived = useUnmarkReceived();
  const { data: profile } = useCurrentProfile();
  /*
   * The receivables half of CATCH_UP_019 §5. Recording money IN is the same
   * assertion as recording money OUT — it says a bank account moved — so it
   * sits with the owner for the same reason, and `mark_sales_received` refuses
   * anybody else with 42501 whatever this row decides to render.
   */
  const mayReceive = isOwner(profile);

  // '' disables the query, so a closed row costs nothing.
  const { data, isLoading } = useSalesInvoice(expanded ? row.id : '');
  const lines = data?.lines ?? [];

  const settled = row.status !== 'outstanding';
  /*
   * No due date is not an urgency, so it does not get a chip.
   *
   * `urgencyOf` answers a question about a deadline, and there is no deadline
   * here to answer it about (CATCH_UP_017). Colouring it 'later' would be the
   * list making a claim the invoice does not.
   */
  const urgency = row.due_date && today ? urgencyOf(row.due_date, today) : null;

  return (
    <li className="border-b border-hairline last:border-b-0">
      <button
        type="button"
        onClick={() => setExpanded((open) => !open)}
        aria-expanded={expanded}
        className="flex min-h-row w-full min-w-0 items-center gap-2 px-3 py-2 text-left active:bg-pressed"
      >
        {/* Same position and size as InvoiceRow's, so the two ledgers read as
            one app rather than as two screens that happen to share a header. */}
        {author ? <PersonChip profile={author} /> : <span className="size-6 shrink-0" />}

        <span className="min-w-0 flex-1">
          <span className={`block truncate text-sm text-ink ${settled ? 'line-through' : ''}`}>
            {showCustomer
              ? row.customer.name
              : row.invoice_number
                ? `#${row.invoice_number}`
                : 'No invoice number'}
          </span>
          <span className="figure-date block truncate text-xs text-muted">
            {showCustomer && row.invoice_number ? `#${row.invoice_number} · ` : ''}
            Sent {formatDay(row.invoice_date)}
          </span>
        </span>

        {row.due_date && today && urgency ? (
          <span
            className="shrink-0 rounded-sm px-1.5 py-0.5 text-[11px]"
            style={{ backgroundColor: URGENCY_TINT[urgency], color: URGENCY_COLOUR[urgency] }}
          >
            {formatDueLabel(row.due_date, today)}
          </span>
        ) : null}

        <span className={`money shrink-0 text-sm ${settled ? 'text-muted' : 'text-ink'}`}>
          {formatCents(row.amount_cents)}
        </span>

        <span
          aria-hidden
          className="shrink-0 text-xs text-muted"
          style={{ transform: expanded ? 'rotate(90deg)' : undefined }}
        >
          &rsaquo;
        </span>
      </button>

      {expanded ? (
        <div className="panel-in border-t border-hairline px-3 py-3">
          {isLoading ? (
            <p className="text-sm text-muted">Loading the lines…</p>
          ) : lines.length === 0 ? (
            /* Recorded through the flat sheet, as one amount. Saying so beats
               an empty table that looks like something failed. */
            <p className="text-sm text-muted">
              Recorded as one amount, with no itemised lines.
            </p>
          ) : (
            <table className="mb-3 w-full border-collapse text-sm">
              <tbody>
                {lines.map((line) => (
                  <tr key={line.id} className="border-b border-hairline last:border-b-0">
                    <td className="py-1.5 pr-2 text-ink">
                      <span className="block">{line.description}</span>
                      <span className="block text-xs text-muted">
                        {formatQuantity(line.quantity_milli)}
                        {line.unit ? ` ${line.unit}` : ''} &times;{' '}
                        {formatCents(line.unit_price_cents)}
                      </span>
                    </td>
                    <td className="money py-1.5 text-right align-top text-ink">
                      {formatCents(line.line_total_cents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <dl className="mb-3">
            <Fact label="Total">{formatCents(row.amount_cents)}</Fact>
            <Fact label="Sent">{formatDay(row.invoice_date)}</Fact>
            {/* Absent, and said so. A blank line labelled Due reads as
                something that failed to load. */}
            <Fact label="Due">{row.due_date ? formatDay(row.due_date) : 'No due date'}</Fact>
            <Fact label="Added by">
              <span className="flex items-center justify-end gap-2">
                {author ? <PersonChip profile={author} /> : null}
                {author?.display_name ?? 'Somebody no longer listed'}
              </span>
            </Fact>
            {row.received_at ? (
              <Fact label="Received">
                {/* Who ticked it off, not just when. The payables side has
                    said this since Phase 4; this is the same sentence. */}
                <span className="flex items-center justify-end gap-2">
                  {receiver ? <PersonChip profile={receiver} /> : null}
                  <span>
                    {receiver ? `${receiver.display_name} · ` : ''}
                    {formatDateTime(row.received_at)}
                  </span>
                </span>
              </Fact>
            ) : null}
            {row.note ? <Fact label="Note">{row.note}</Fact> : null}
          </dl>

          <div className="flex gap-2">
            {!mayReceive ? null : settled ? (
              <button
                type="button"
                onClick={async () => {
                  try {
                    await unmarkReceived.mutateAsync(row.id);
                    toast.show('Put back to outstanding.');
                  } catch {
                    toast.show('Couldn’t undo that.', 'problem');
                  }
                }}
                className="touch flex-1 rounded-full px-3 text-sm font-medium"
                style={{ backgroundColor: 'var(--action-bg)', color: 'var(--action)' }}
              >
                Undo received
              </button>
            ) : (
              <button
                type="button"
                onClick={async () => {
                  try {
                    const result = await markReceived.mutateAsync({ ids: [row.id] });
                    toast.show(
                      result.received.length === 0
                        ? 'Already recorded by someone else.'
                        : `Received ${formatCents(row.amount_cents)}.`,
                      result.received.length === 0 ? 'queued' : 'done',
                    );
                  } catch {
                    toast.show('Couldn’t record that. Try again.', 'problem');
                  }
                }}
                className="touch flex-1 rounded-full px-3 text-sm font-medium"
                style={{ backgroundColor: 'var(--paid-bg)', color: 'var(--paid)' }}
              >
                Mark received
              </button>
            )}

            <Link
              href={`/sales/${row.id}/print` as Route}
              className="touch flex flex-1 items-center justify-center rounded-sm border border-hairline bg-card px-3 text-sm text-ink"
            >
              Open &amp; print
            </Link>
          </div>
        </div>
      ) : null}
    </li>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-hairline py-1.5 last:border-b-0">
      <dt className="shrink-0 text-xs uppercase tracking-widest text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-right text-sm text-ink">{children}</dd>
    </div>
  );
}
