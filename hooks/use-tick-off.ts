'use client';

import { useCallback } from 'react';
import { useToast } from '@/components/ui/Toast';
import { useMarkPaid, useUnmarkPaid } from '@/lib/queries/payments';
import { forgetPaid, rememberPaid } from '@/lib/recently-paid';
import { useCurrentProfile } from '@/lib/queries/session';
import { formatCents } from '@/lib/money';
import type { InvoiceRow } from '@/lib/types';

/**
 * Ticking one invoice off a list.
 *
 * ---------------------------------------------------------------------------
 * Immediate, with Undo — rather than a confirmation dialog.
 *
 * This is the most repeated action in the app after adding an invoice, and a
 * dialog on every one of them is a tax paid on the ninety-nine correct ticks
 * to catch the one mistake. Undo is the better trade: it costs nothing when
 * you were right, and it is one tap when you were not.
 *
 * It is only safe because the mistake is genuinely cheap to reverse. The undo
 * calls `unmark_invoice_paid`, the audit trigger records both the tick and the
 * reversal with your name on them, and nothing is ever destroyed (notes §8).
 *
 * A whole payment run still goes through the sheet: more money, and a bank
 * reference worth capturing while you have it in front of you.
 * ---------------------------------------------------------------------------
 */
export function useTickOff() {
  const toast = useToast();
  const markPaid = useMarkPaid();
  const unmarkPaid = useUnmarkPaid();
  const { data: profile } = useCurrentProfile();

  /**
   * Put one back. Shared by the toast and by the Undo on the row itself, so
   * the two cannot drift into doing different things.
   */
  const undo = useCallback(
    async (id: string) => {
      try {
        await unmarkPaid.mutateAsync(id);
        forgetPaid(id);
        toast.show('Put back to unpaid.');
      } catch {
        toast.show('Couldn’t undo that — open the invoice and try there.', 'problem');
      }
    },
    [unmarkPaid, toast],
  );

  const tickOff = useCallback(
    async (invoice: InvoiceRow) => {
      try {
        const result = await markPaid.mutateAsync({
          ids: [invoice.id],
          actorId: profile?.id,
        });

        if (result.paid.length === 0) {
          // Somebody else ticked it while this list was on screen.
          toast.show('Already marked paid by someone else.', 'queued');
          return;
        }

        /*
         * Kept on screen, struck through, until the app is closed.
         *
         * The row used to leave on the next refetch. Inside a payment run that
         * dropped the run to a single invoice, which stops rendering as a
         * group — so both children vanished and only one had been paid. See
         * lib/recently-paid.ts.
         *
         * Remembered only after the database confirms, and only the rows it
         * actually flipped, so a row never sits there struck through on the
         * strength of a call that failed.
         */
        rememberPaid(
          result.paid.map((row) => ({ ...invoice, ...row } as InvoiceRow)),
        );

        toast.show(`Marked paid · ${formatCents(invoice.amount_cents)}`, 'done', {
          label: 'Undo',
          onAct: () => undo(invoice.id),
        });
      } catch {
        toast.show('Couldn’t mark it paid — check your connection and try again.', 'problem');
      }
    },
    [markPaid, undo, toast, profile],
  );

  return { tickOff, undo };
}
