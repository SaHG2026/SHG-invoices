'use client';

import Link from 'next/link';
import { PersonChip } from '@/components/ui/PersonChip';
import { invoiceHref } from '@/lib/scope';
import { formatDateTime, formatDay, formatDayWithYear, type DateStr } from '@/lib/date';
import { formatCents } from '@/lib/money';
import { formatDaysLate, URGENCY_COLOUR, urgencyOf } from '@/lib/derive/urgency';
import type { InvoiceRow as Invoice, Profile } from '@/lib/types';

/**
 * One invoice in a list, expandable in place.
 *
 * Shared by the week view and the pending list so the two cannot drift. They
 * show the same invoice, so they must show it the same way — a row that reads
 * differently depending on which screen you found it on is a small betrayal of
 * a ledger.
 *
 * The full detail screen, with notes and the activity stream, is Phase 5. This
 * answers "what is this one?" without leaving the list you are reading.
 */

/** One line of the expanded panel. */
function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-hairline py-1.5 last:border-b-0">
      <dt className="shrink-0 text-xs uppercase tracking-widest text-muted">{label}</dt>
      <dd className="figure-date min-w-0 truncate text-right text-sm text-ink">{children}</dd>
    </div>
  );
}

interface InvoiceRowProps {
  invoice: Invoice;
  today: DateStr;
  people: readonly Profile[];
  expanded: boolean;
  onToggle: () => void;
  /** The spine is drawn by the section in week view, and per row in flat lists. */
  showSpine?: boolean;
  /** Hidden inside a payment run, where the supplier is already the heading. */
  showSupplier?: boolean;
  /** Offered on unpaid rows. Absent on paid and void ones. */
  onMarkPaid?: () => void;
  /**
   * Offered on a row ticked off during this session, in place of the tick.
   *
   * Spec §6 forbids un-ticking from a list because it is "too easy to
   * fat-finger". This is narrower than that and does not reopen it: it appears
   * only on a row you ticked yourself, minutes ago, on this device, and it
   * disappears when the app is closed. Undoing your own last action is not the
   * same act as reaching into the ledger and reversing somebody else's.
   */
  onUndo?: () => void;
}

export function InvoiceRow({
  invoice,
  today,
  people,
  expanded,
  onToggle,
  showSpine = true,
  showSupplier = true,
  onMarkPaid,
  onUndo,
}: InvoiceRowProps) {
  const urgency = urgencyOf(invoice.due_date, today);
  const late = formatDaysLate(invoice.due_date, today);
  const author = people.find((person) => person.id === invoice.created_by);

  /*
   * Paid and void rows stay visible, struck through.
   *
   * A row that vanishes the instant it is tapped gives no confirmation that
   * the right one went — and on a list of near-identical invoices from one
   * supplier, that is exactly when confirmation matters most. The refetch
   * removes it from the pending list a moment later; what is on screen in
   * between says plainly what just happened, and who did it.
   */
  const settled = invoice.status !== 'unpaid';
  const payer = people.find((person) => person.id === invoice.paid_by);

  return (
    <li className="relative border-b border-hairline last:border-b-0">
      {showSpine ? (
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 w-[3px]"
          style={{
            backgroundColor:
              invoice.status === 'paid'
                ? 'var(--paid)'
                : settled
                  ? 'var(--spine-later)'
                  : URGENCY_COLOUR[urgency],
          }}
        />
      ) : null}

      <div className="flex h-row items-center">
        {/*
          The tick, on the row itself.
          Spec §6 forbids UN-ticking from a list — "too easy to fat-finger" —
          and says nothing against ticking. Spec §9 in fact describes the
          tick-off as a list behaviour: the spine fills, then the row leaves.
          An earlier version hid it behind an expand, which cost a tap on the
          single most repeated action in the app.
        */}
        {onMarkPaid && !settled ? (
          <button
            type="button"
            onClick={onMarkPaid}
            aria-label={`Mark ${invoice.supplier.name} ${formatCents(invoice.amount_cents)} paid`}
            className={`touch flex shrink-0 items-center justify-center ${showSpine ? 'pl-3' : 'pl-2'}`}
          >
            <span
              aria-hidden
              className="flex size-6 items-center justify-center rounded-full border text-xs transition-colors duration-150"
              style={{ borderColor: 'var(--spine-later)', color: 'var(--spine-later)' }}
            >
              ✓
            </span>
          </button>
        ) : invoice.status === 'paid' ? (
          /* Same slot, same size, so the row does not shuffle sideways the
             moment it is ticked — but a filled tick now says "done" and does
             nothing, because the thing that undoes it says Undo. */
          <span
            aria-hidden
            className={`flex shrink-0 items-center justify-center ${showSpine ? 'pl-3' : 'pl-2'}`}
          >
            <span
              className="flex size-6 items-center justify-center rounded-full text-xs"
              style={{ backgroundColor: 'var(--paid)', color: 'var(--card)' }}
            >
              ✓
            </span>
          </span>
        ) : null}

        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className={`flex h-row min-w-0 flex-1 items-center gap-3 pr-3 text-left active:bg-pressed ${
            onMarkPaid ? 'pl-2' : showSpine ? 'pl-4' : 'pl-3'
          }`}
        >
          {/*
            Spec §9: the attribution chip is permanent and appears everywhere
            the invoice appears afterwards.
          */}
          {author ? <PersonChip profile={author} /> : <span className="size-6 shrink-0" />}

          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span
                className={`min-w-0 truncate text-sm text-ink ${settled ? 'line-through' : ''}`}
              >
                {showSupplier
                  ? invoice.supplier.name
                  : (invoice.invoice_number ?? 'No invoice number')}
              </span>
              {settled ? (
                <span
                  className="shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] uppercase tracking-widest"
                  style={
                    invoice.status === 'paid'
                      ? { backgroundColor: 'var(--paid-bg)', color: 'var(--paid)' }
                      : { backgroundColor: 'var(--spine-later-bg)', color: 'var(--muted)' }
                  }
                >
                  {invoice.status === 'paid' ? 'Paid' : 'Void'}
                </span>
              ) : null}
            </span>

            <span className="figure-date block truncate text-xs text-muted">
              {invoice.status === 'paid' ? (
                <>Paid{payer ? ` by ${payer.display_name}` : ''}</>
              ) : (
                <>
                  {formatDay(invoice.due_date)}
                  {late ? ` · ${late}` : ''}
                </>
              )}
              {' · '}
              {invoice.business.code}
              {showSupplier && invoice.invoice_number ? ` · ${invoice.invoice_number}` : ''}
              {invoice.internal_ref ? '' : ' · saving…'}
            </span>
          </span>

          {/* mr-2 pulls the figure off the chevron so the column reads as a
              column rather than as something crushed against the edge. */}
          <span
            className={`money mr-2 shrink-0 text-sm text-ink ${settled ? 'line-through' : ''}`}
          >
            {formatCents(invoice.amount_cents)}
          </span>
          <span aria-hidden className="shrink-0 text-xs text-muted">
            {expanded ? '⌃' : '⌄'}
          </span>
        </button>

        {/*
          Undo, spelled out, outside the expanding button.
          It was a green tick with "tap the tick to undo" in 12px grey
          underneath — which asks somebody to read an instruction to discover a
          control. A word they can see and hit is not a hint.
        */}
        {onUndo && invoice.status === 'paid' ? (
          <button
            type="button"
            onClick={onUndo}
            className="touch mr-2 shrink-0 rounded-full px-3 text-xs font-medium"
            style={{ backgroundColor: 'var(--action-bg)', color: 'var(--action)' }}
          >
            Undo
          </button>
        ) : null}
      </div>

      {expanded ? (
        <dl className="row-in border-t border-hairline bg-pressed px-4 py-3 pl-5">
          <Detail label="Amount">
            <span className="money" style={{ textAlign: 'left' }}>
              {formatCents(invoice.amount_cents)}
            </span>
          </Detail>
          <Detail label="Supplier">{invoice.supplier.name}</Detail>
          <Detail label="Business">{invoice.business.name}</Detail>
          <Detail label="Invoice date">{formatDayWithYear(invoice.invoice_date)}</Detail>
          <Detail label="Due">
            <span style={{ color: URGENCY_COLOUR[urgency] }}>
              {formatDayWithYear(invoice.due_date)}
              {late ? ` · ${late}` : ''}
            </span>
          </Detail>
          {invoice.invoice_number ? (
            <Detail label="Invoice number">{invoice.invoice_number}</Detail>
          ) : null}
          <Detail label="Added">
            {author ? `${author.display_name} · ` : ''}
            {formatDateTime(invoice.created_at)}
          </Detail>

          <div className="pt-3">
            <Link
              href={invoiceHref(invoice.id)}
              className="touch flex items-center justify-center rounded-sm border border-hairline bg-card px-3 text-sm text-ink"
            >
              Open full record
            </Link>
          </div>
        </dl>
      ) : null}
    </li>
  );
}
