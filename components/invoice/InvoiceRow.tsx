'use client';

import { PersonChip } from '@/components/ui/PersonChip';
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
}

export function InvoiceRow({
  invoice,
  today,
  people,
  expanded,
  onToggle,
  showSpine = true,
  showSupplier = true,
}: InvoiceRowProps) {
  const urgency = urgencyOf(invoice.due_date, today);
  const late = formatDaysLate(invoice.due_date, today);
  const author = people.find((person) => person.id === invoice.created_by);

  return (
    <li className="relative border-b border-hairline last:border-b-0">
      {showSpine ? (
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 w-[3px]"
          style={{ backgroundColor: URGENCY_COLOUR[urgency] }}
        />
      ) : null}

      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className={`flex h-row w-full items-center gap-3 pr-3 text-left active:bg-pressed ${
          showSpine ? 'pl-4' : 'pl-3'
        }`}
      >
        {/*
          Spec §9: the attribution chip is permanent and appears everywhere the
          invoice appears afterwards.
        */}
        {author ? <PersonChip profile={author} /> : <span className="size-6 shrink-0" />}

        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-ink">
            {showSupplier ? invoice.supplier.name : (invoice.invoice_number ?? invoice.internal_ref)}
          </span>
          <span className="figure-date block truncate text-xs text-muted">
            {formatDay(invoice.due_date)}
            {late ? ` · ${late}` : ''} · {invoice.business.code}
            {invoice.internal_ref ? ` · ${invoice.internal_ref}` : ' · saving…'}
          </span>
        </span>

        <span className="money shrink-0 text-sm text-ink">{formatCents(invoice.amount_cents)}</span>
        <span aria-hidden className="shrink-0 text-xs text-muted">
          {expanded ? '⌃' : '⌄'}
        </span>
      </button>

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
          <Detail label="Reference">{invoice.internal_ref || 'assigned once it saves'}</Detail>
          <Detail label="Added">
            {author ? `${author.display_name} · ` : ''}
            {formatDateTime(invoice.created_at)}
          </Detail>
        </dl>
      ) : null}
    </li>
  );
}
