'use client';

import { useMutation } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase/browser';
import { nowTimestamp } from '@/lib/date';
import { mk } from '@/lib/offline/keys';
import { qk } from './keys';
import type { Invoice, InvoiceRow } from '@/lib/types';

/**
 * Marking paid, un-ticking, and voiding.
 *
 * ---------------------------------------------------------------------------
 * Notes §1.6, which decides the shape of all of this:
 *
 *   "If ticking a whole run is implemented as a loop of individual updates, a
 *   mid-loop failure leaves some invoices paid and some not, with no
 *   indication which. In a money app that's the worst possible partial state."
 *
 * So every one of these is a single database call. `mark_invoices_paid` takes
 * an array and updates them in one statement, inside one transaction — a
 * single invoice is just an array of one. There is no loop here, and there is
 * no code path where one of three invoices ends up paid.
 * ---------------------------------------------------------------------------
 */

export interface MarkPaidInput {
  /** One id, or every id in a payment run. */
  ids: string[];
  /** Bank reference or cheque number. Optional. */
  reference?: string;
  /** Who is ticking, so the optimistic row can show their chip immediately. */
  actorId?: string;
}

export interface MarkPaidResult {
  /** The rows the database actually changed. */
  paid: Invoice[];
  /** Asked for but already paid or voided by somebody else. */
  missed: string[];
}

/**
 * Mark one invoice or a whole run paid.
 *
 * The RPC returns only the rows it actually flipped, because its WHERE clause
 * includes `status = 'unpaid'`. If Milan ticked one of them thirty seconds
 * ago, that row comes back missing rather than being silently re-stamped with
 * a new payer — and the caller can say so instead of quietly disagreeing with
 * the server.
 */
interface MarkPaidContext {
  previous?: InvoiceRow[];
}

/**
 * All three payment writes, registered by key so they survive the app closing.
 *
 * Every one of them is idempotent in the database, which is what makes them
 * safe to replay from the queue at all: `mark_invoices_paid` only touches rows
 * still `unpaid`, `unmark_invoice_paid` only ones still `paid`, and voiding
 * checks the same way. A write that arrives twice does nothing the second
 * time — it does not re-stamp a payment with a new payer and a new hour.
 */
export function registerPaymentMutations(queryClient: QueryClient) {
  queryClient.setMutationDefaults(mk.payments.markPaid, {
    mutationFn: async ({ ids, reference }: MarkPaidInput): Promise<MarkPaidResult> => {
      const { data, error } = await supabase().rpc('mark_invoices_paid', {
        p_ids: ids,
        p_ref: reference?.trim() || null,
      });

      if (error) throw error;

      const paid = (data ?? []) as Invoice[];
      const flipped = new Set(paid.map((invoice) => invoice.id));
      return { paid, missed: ids.filter((id) => !flipped.has(id)) };
    },

    onMutate: async ({ ids, actorId }: MarkPaidInput): Promise<MarkPaidContext> => {
      // Notes §1.4: non-negotiable. Without it an in-flight fetch can land
      // after the optimistic update and bring the row back for a second.
      await queryClient.cancelQueries({ queryKey: qk.invoices.unpaid });

      const previous = queryClient.getQueryData<InvoiceRow[]>(qk.invoices.unpaid);
      const paying = new Set(ids);
      const now = nowTimestamp();

      /*
       * Marked paid in place rather than removed.
       *
       * A row that vanishes the instant it is tapped gives no confirmation
       * that the right one went — and on a list of similar invoices from one
       * supplier, that is exactly when confirmation matters. It is struck
       * through and labelled instead, and the refetch takes it away.
       */
      queryClient.setQueryData<InvoiceRow[]>(qk.invoices.unpaid, (current) =>
        (current ?? []).map((invoice) =>
          paying.has(invoice.id)
            ? { ...invoice, status: 'paid' as const, paid_at: now, paid_by: actorId ?? null }
            : invoice,
        ),
      );

      return { previous };
    },

    onError: (_error: unknown, _input: MarkPaidInput, context: MarkPaidContext | undefined) => {
      if (context?.previous) queryClient.setQueryData(qk.invoices.unpaid, context.previous);
    },

    onSettled: (_data: MarkPaidResult | undefined, _error: unknown, input: MarkPaidInput) => {
      // Every invoice list, not just the unpaid one. A supplier page and the
      // history show the same invoice, and leaving them stale meant a tick
      // appeared to do nothing.
      queryClient.invalidateQueries({ queryKey: qk.invoices.all });
      queryClient.invalidateQueries({ queryKey: qk.activity.recent });
      for (const id of input.ids) {
        queryClient.invalidateQueries({ queryKey: qk.activity.forInvoice(id) });
      }
    },
  });

  /*
   * Un-tick. Spec §6: available from the invoice detail screen only — never
   * swipeable from a list, "too easy to fat-finger" — requires a confirm, and
   * is logged loudly. The logging is not this function's job: the audit
   * trigger records it whether or not anyone remembers to.
   */
  queryClient.setMutationDefaults(mk.payments.unmarkPaid, {
    mutationFn: async (id: string): Promise<Invoice | null> => {
      const { data, error } = await supabase().rpc('unmark_invoice_paid', { p_id: id });
      if (error) throw error;
      return ((data ?? []) as Invoice[])[0] ?? null;
    },
    onSettled: (_data: Invoice | null | undefined, _error: unknown, id: string) => {
      queryClient.invalidateQueries({ queryKey: qk.invoices.all });
      queryClient.invalidateQueries({ queryKey: qk.activity.forInvoice(id) });
      queryClient.invalidateQueries({ queryKey: qk.activity.recent });
    },
  });

  /*
   * Void, with a reason. Never delete — notes §8.
   *
   * The reason is required by the database as well as by the form, so an
   * invoice cannot end up voided with nobody knowing why.
   */
  queryClient.setMutationDefaults(mk.payments.voidInvoice, {
    mutationFn: async ({ id, reason }: VoidInput): Promise<Invoice | null> => {
      const { data, error } = await supabase().rpc('void_invoice', {
        p_id: id,
        p_reason: reason.trim(),
      });
      if (error) throw error;
      return ((data ?? []) as Invoice[])[0] ?? null;
    },
    onSettled: (_data: Invoice | null | undefined, _error: unknown, { id }: VoidInput) => {
      queryClient.invalidateQueries({ queryKey: qk.invoices.all });
      queryClient.invalidateQueries({ queryKey: qk.activity.forInvoice(id) });
      queryClient.invalidateQueries({ queryKey: qk.activity.recent });
    },
  });
}

export interface VoidInput {
  id: string;
  reason: string;
}

export function useMarkPaid() {
  return useMutation<MarkPaidResult, Error, MarkPaidInput, MarkPaidContext>({
    mutationKey: mk.payments.markPaid,
  });
}

export function useUnmarkPaid() {
  return useMutation<Invoice | null, Error, string>({
    mutationKey: mk.payments.unmarkPaid,
  });
}

export function useVoidInvoice() {
  return useMutation<Invoice | null, Error, VoidInput>({
    mutationKey: mk.payments.voidInvoice,
  });
}
