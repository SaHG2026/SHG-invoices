'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase/browser';
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
export function useMarkPaid() {
  const queryClient = useQueryClient();

  return useMutation({
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

    onMutate: async ({ ids }) => {
      // Notes §1.4: non-negotiable. Without it an in-flight fetch can land
      // after the optimistic update and bring the row back for a second.
      await queryClient.cancelQueries({ queryKey: qk.invoices.unpaid });

      const previous = queryClient.getQueryData<InvoiceRow[]>(qk.invoices.unpaid);
      const paying = new Set(ids);

      queryClient.setQueryData<InvoiceRow[]>(qk.invoices.unpaid, (current) =>
        (current ?? []).filter((invoice) => !paying.has(invoice.id)),
      );

      return { previous };
    },

    onError: (_error, _input, context) => {
      if (context?.previous) queryClient.setQueryData(qk.invoices.unpaid, context.previous);
    },

    onSettled: (_data, _error, input) => {
      queryClient.invalidateQueries({ queryKey: qk.invoices.unpaid });
      queryClient.invalidateQueries({ queryKey: qk.activity.recent });
      for (const id of input.ids) {
        queryClient.invalidateQueries({ queryKey: qk.invoices.detail(id) });
        queryClient.invalidateQueries({ queryKey: qk.activity.forInvoice(id) });
      }
    },
  });
}

/**
 * Un-tick. Spec §6: available from the invoice detail screen only — never
 * swipeable from a list, "too easy to fat-finger" — requires a confirm, and is
 * logged loudly. The logging is not this function's job: the audit trigger
 * records it whether or not anyone remembers to.
 */
export function useUnmarkPaid() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string): Promise<Invoice | null> => {
      const { data, error } = await supabase().rpc('unmark_invoice_paid', { p_id: id });
      if (error) throw error;
      return ((data ?? []) as Invoice[])[0] ?? null;
    },
    onSettled: (_data, _error, id) => {
      queryClient.invalidateQueries({ queryKey: qk.invoices.unpaid });
      queryClient.invalidateQueries({ queryKey: qk.invoices.detail(id) });
      queryClient.invalidateQueries({ queryKey: qk.activity.forInvoice(id) });
      queryClient.invalidateQueries({ queryKey: qk.activity.recent });
    },
  });
}

/**
 * Void, with a reason. Never delete — notes §8.
 *
 * The reason is required by the database as well as by the form, so an invoice
 * cannot end up voided with nobody knowing why.
 */
export function useVoidInvoice() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }): Promise<Invoice | null> => {
      const { data, error } = await supabase().rpc('void_invoice', {
        p_id: id,
        p_reason: reason.trim(),
      });
      if (error) throw error;
      return ((data ?? []) as Invoice[])[0] ?? null;
    },
    onSettled: (_data, _error, { id }) => {
      queryClient.invalidateQueries({ queryKey: qk.invoices.unpaid });
      queryClient.invalidateQueries({ queryKey: qk.invoices.detail(id) });
      queryClient.invalidateQueries({ queryKey: qk.activity.forInvoice(id) });
      queryClient.invalidateQueries({ queryKey: qk.activity.recent });
    },
  });
}
