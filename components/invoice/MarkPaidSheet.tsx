'use client';

import { useState } from 'react';
import { Sheet } from '@/components/ui/Sheet';
import { useToast } from '@/components/ui/Toast';
import { useMarkPaid } from '@/lib/queries/payments';
import { formatCents } from '@/lib/money';
import { formatDayWithYear } from '@/lib/date';
import type { InvoiceRow } from '@/lib/types';

/**
 * Confirming a payment. Spec §6.
 *
 * One sheet for a single invoice and for a whole run, because they are the
 * same act: one transfer leaves the account. The only difference is how many
 * invoices it settles, and that is a line of text.
 *
 * The reference is optional and the field is not focused on open — asking for
 * it would put a keyboard in front of a confirmation. Most payments are ticked
 * off from a bank statement afterwards, where the reference is already known
 * and typing it is worth the two seconds; some are ticked off in a hurry.
 */

interface MarkPaidSheetProps {
  open: boolean;
  invoices: InvoiceRow[];
  onClose: () => void;
  /** Fired once the database confirms, so a list can animate the rows out. */
  onPaid?: (ids: string[]) => void;
}

export function MarkPaidSheet({ open, invoices, onClose, onPaid }: MarkPaidSheetProps) {
  const toast = useToast();
  const markPaid = useMarkPaid();
  const [reference, setReference] = useState('');

  if (!open || invoices.length === 0) return null;

  const total = invoices.reduce((sum, invoice) => sum + invoice.amount_cents, 0);
  const supplier = invoices[0]!.supplier.name;
  const dueDate = invoices[0]!.due_date;

  async function confirm() {
    const ids = invoices.map((invoice) => invoice.id);
    onClose();

    try {
      const result = await markPaid.mutateAsync({ ids, reference });

      if (result.missed.length > 0) {
        // Somebody else got there first. Saying "marked paid" would claim
        // credit for work this person did not do, and hide a disagreement.
        toast.show(
          result.paid.length === 0
            ? 'Already marked paid by someone else.'
            : `Marked ${result.paid.length} paid · ${result.missed.length} were already done.`,
          'queued',
        );
      } else {
        // Spec §8: the action name survives into the confirmation.
        toast.show(
          ids.length === 1
            ? `Marked paid · ${formatCents(total)}`
            : `Marked ${ids.length} paid · ${formatCents(total)}`,
        );
      }

      onPaid?.(result.paid.map((invoice) => invoice.id));
    } catch {
      toast.show('Couldn’t mark it paid — check your connection and try again.', 'problem');
    }
  }

  return (
    <Sheet
      open
      title={invoices.length === 1 ? 'Mark paid' : `Mark ${invoices.length} paid`}
      onClose={onClose}
      footer={
        <button
          type="button"
          onClick={confirm}
          disabled={markPaid.isPending}
          className="touch w-full rounded-sm px-4 text-base font-medium disabled:opacity-40"
          style={{ backgroundColor: 'var(--paid)', color: 'var(--card)' }}
        >
          {markPaid.isPending ? 'Marking…' : 'Mark paid'}
        </button>
      }
    >
      <div className="mb-4 rounded-sm border border-edge bg-pressed p-3">
        <p className="text-xs uppercase tracking-widest text-muted">Leaving the account</p>
        <p className="money mt-1 text-h1 text-ink" style={{ textAlign: 'left' }}>
          {formatCents(total)}
        </p>
        <p className="figure-date mt-1 text-sm text-muted">
          {supplier} · due {formatDayWithYear(dueDate)}
        </p>
      </div>

      {invoices.length > 1 ? (
        <ul className="mb-4 overflow-hidden rounded-sm border border-hairline">
          {invoices.map((invoice) => (
            <li
              key={invoice.id}
              className="flex items-center justify-between gap-3 border-b border-hairline px-3 py-2 last:border-b-0"
            >
              <span className="figure-date min-w-0 truncate text-sm text-muted">
                {invoice.invoice_number ?? invoice.internal_ref}
              </span>
              <span className="money shrink-0 text-sm text-ink">
                {formatCents(invoice.amount_cents)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <label className="block">
        <span className="mb-1 block text-xs uppercase tracking-widest text-muted">
          Payment reference
        </span>
        <input
          type="text"
          autoComplete="off"
          autoCapitalize="characters"
          placeholder="Optional — bank ref or cheque number"
          value={reference}
          onChange={(event) => setReference(event.target.value)}
          className="touch w-full rounded-sm border border-hairline bg-card px-3 text-base text-ink outline-none focus:border-action"
        />
      </label>

      <p className="mt-3 text-xs text-muted">
        Your initials stay on this invoice permanently. It can be put back to unpaid from the
        invoice itself.
      </p>
    </Sheet>
  );
}
