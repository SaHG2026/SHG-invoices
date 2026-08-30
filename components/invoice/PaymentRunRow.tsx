'use client';

import { InvoiceRow } from './InvoiceRow';
import { formatDay } from '@/lib/date';
import { formatCents } from '@/lib/money';
import { formatDaysLate, URGENCY_COLOUR, urgencyOf } from '@/lib/derive/urgency';
import type { DateStr } from '@/lib/date';
import type { PaymentRun, Profile } from '@/lib/types';

/**
 * A payment run. Spec §6.
 *
 * Unpaid invoices sharing a supplier and a due date collapse into one row,
 * because that is how they get paid — one transfer, one reference. Expanding
 * shows each invoice inside.
 *
 * A run of one renders as a plain invoice row rather than a collapsed group
 * of a single item, which would be a heading over its own contents.
 *
 * Ticking the run is Phase 5. When it arrives it marks every child paid in one
 * database call (notes §1.6), and the grouping here is what decides which ids
 * go into it.
 */

interface PaymentRunRowProps {
  run: PaymentRun;
  today: DateStr;
  people: readonly Profile[];
  expandedId: string | null;
  onToggle: (id: string) => void;
}

export function PaymentRunRow({
  run,
  today,
  people,
  expandedId,
  onToggle,
}: PaymentRunRowProps) {
  const single = run.invoices[0];
  if (run.invoices.length === 1 && single) {
    return (
      <InvoiceRow
        invoice={single}
        today={today}
        people={people}
        expanded={expandedId === single.id}
        onToggle={() => onToggle(single.id)}
      />
    );
  }

  const urgency = urgencyOf(run.due_date, today);
  const late = formatDaysLate(run.due_date, today);
  const expanded = expandedId === run.key;

  return (
    <li className="relative border-b border-hairline last:border-b-0">
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-[3px]"
        style={{ backgroundColor: URGENCY_COLOUR[urgency] }}
      />

      <button
        type="button"
        onClick={() => onToggle(run.key)}
        aria-expanded={expanded}
        className="flex h-row w-full items-center gap-3 pl-4 pr-3 text-left active:bg-pressed"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-ink">{run.supplier.name}</span>
          <span className="figure-date block truncate text-xs text-muted">
            {formatDay(run.due_date)}
            {late ? ` · ${late}` : ''} · {run.invoices.length} invoices
          </span>
        </span>

        <span className="money shrink-0 text-sm text-ink">{formatCents(run.total_cents)}</span>
        <span aria-hidden className="shrink-0 text-xs text-muted">
          {expanded ? '⌃' : '⌄'}
        </span>
      </button>

      {expanded ? (
        <ul className="row-in border-t border-hairline bg-pressed">
          {run.invoices.map((invoice) => (
            <InvoiceRow
              key={invoice.id}
              invoice={invoice}
              today={today}
              people={people}
              expanded={expandedId === invoice.id}
              onToggle={() => onToggle(invoice.id)}
              showSpine={false}
              showSupplier={false}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
