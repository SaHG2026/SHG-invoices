'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase/browser';
import { UNPAID_STALE_MS } from '@/lib/constants';
import { mk } from '@/lib/offline/keys';
import { qk } from './keys';
import type { Invoice, InvoiceRow, Supplier } from '@/lib/types';

/**
 * The invoices a venue has entered and nobody has accepted yet.
 *
 * ---------------------------------------------------------------------------
 * Why this is a second query rather than a filter over the unpaid array
 *
 * Architecture §2 makes one array the source of every owed figure, and the
 * reason it works is that a total and the list under it cannot disagree when
 * both are `useMemo` over the same rows. Adding unapproved invoices to that
 * array and filtering them out at each summary would put the rule back in
 * every call site — which is exactly the arrangement §2 exists to avoid, and
 * the failure would be silent: money in a total that nobody has agreed to owe.
 *
 * So they are two disjoint queries — `status = unpaid` split by whether
 * `approved_at` is null — and this one is the same exception History already
 * is: it feeds a count and a total that no other screen has to agree with.
 * ---------------------------------------------------------------------------
 *
 * Nothing here is scoped by business. Reviewing is a job done across the whole
 * group in one sitting, and a venue filter would hide the second shop's
 * morning behind a control nobody thought to change.
 */

/**
 * `is_placeholder` is joined in, and the rest of the app does not ask for it.
 *
 * This is the one screen that has to tell "Supplier not listed" apart from a
 * real supplier, because approving one of those means picking the real one
 * first. Matching on the name would work until somebody renames the row.
 */
const ROW_SELECT =
  '*, supplier:suppliers!inner(id, name, is_placeholder), business:businesses!inner(id, code, name)';

/** An invoice awaiting review, with enough of its supplier to judge it. */
export interface ReviewRow extends Omit<InvoiceRow, 'supplier'> {
  supplier: Pick<Supplier, 'id' | 'name' | 'is_placeholder'>;
}

export function useAwaitingReview() {
  return useQuery({
    queryKey: qk.invoices.review,
    queryFn: async (): Promise<ReviewRow[]> => {
      const { data, error } = await supabase()
        .from('invoices')
        .select(ROW_SELECT)
        .eq('status', 'unpaid')
        .is('approved_at', null)
        // Oldest first: a shop's Monday delivery should not be pushed down the
        // screen by its Tuesday one. The queue is worked from the top.
        .order('created_at', { ascending: true });

      if (error) throw error;
      return (data ?? []) as unknown as ReviewRow[];
    },
    // Notes §1.4: never 0 on a list that receives optimistic updates.
    staleTime: UNPAID_STALE_MS,
  });
}

/**
 * Every note on the invoices waiting for review, in one round trip.
 *
 * The note is the mechanism the whole "a shop cannot create a supplier" change
 * rests on — it is where the real supplier's name is written down. Fetching it
 * per row would mean one request per invoice on the screen that most needs to
 * be readable at a glance.
 */
export function useReviewNotes(invoiceIds: readonly string[]) {
  const key = [...invoiceIds].sort().join(',');

  return useQuery({
    queryKey: qk.invoices.reviewNotes(key),
    queryFn: async (): Promise<Record<string, string[]>> => {
      if (invoiceIds.length === 0) return {};

      const { data, error } = await supabase()
        .from('invoice_notes')
        .select('invoice_id, body, created_at')
        .in('invoice_id', [...invoiceIds])
        .order('created_at');

      if (error) throw error;

      const byInvoice: Record<string, string[]> = {};
      for (const row of (data ?? []) as { invoice_id: string; body: string }[]) {
        (byInvoice[row.invoice_id] ??= []).push(row.body);
      }
      return byInvoice;
    },
    enabled: invoiceIds.length > 0,
    staleTime: UNPAID_STALE_MS,
  });
}

/* -------------------------------------------------------------------------- */

export interface ApproveResult {
  approved: Invoice[];
  /** Asked for but already approved, paid or voided by somebody else. */
  missed: string[];
}

/**
 * Accept invoices into the ledger.
 *
 * One RPC for one invoice and for a shop's whole morning, on the same pattern
 * as `mark_invoices_paid` — one statement, one transaction (notes §1.6). It
 * returns only the rows it actually changed, so if Milan approved the same
 * batch a minute ago those come back in `missed` and the app can say so rather
 * than claiming to have done something it did not.
 */
export function registerReviewMutations(queryClient: QueryClient) {
  queryClient.setMutationDefaults(mk.review.approve, {
    mutationFn: async (ids: string[]): Promise<ApproveResult> => {
      const { data, error } = await supabase().rpc('approve_invoices', { p_ids: ids });
      if (error) throw error;

      const approved = (data ?? []) as Invoice[];
      const done = new Set(approved.map((row) => row.id));
      return { approved, missed: ids.filter((id) => !done.has(id)) };
    },

    /*
     * Optimistic on the review list only, and deliberately NOT on the unpaid
     * list.
     *
     * The row is leaving this screen, which is what somebody needs to see
     * immediately. Where it lands is the dashboard's headline figures, and
     * inventing a row there means inventing money — an optimistic entry that
     * turned out to be refused would show a total nobody owed. The refetch
     * below is one round trip and it is the honest one.
     */
    onMutate: async (ids: string[]) => {
      await queryClient.cancelQueries({ queryKey: qk.invoices.review });
      const previous = queryClient.getQueryData<ReviewRow[]>(qk.invoices.review);

      const going = new Set(ids);
      queryClient.setQueryData<ReviewRow[]>(qk.invoices.review, (current) =>
        (current ?? []).filter((row) => !going.has(row.id)),
      );

      return { previous };
    },

    onError: (_error: unknown, _ids: string[], context: { previous?: ReviewRow[] } | undefined) => {
      if (context?.previous) {
        queryClient.setQueryData(qk.invoices.review, context.previous);
      }
    },

    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: qk.invoices.review });
      queryClient.invalidateQueries({ queryKey: qk.invoices.unpaid });
      queryClient.invalidateQueries({ queryKey: qk.activity.recent });
    },
  });
}

export function useApproveInvoices() {
  return useMutation<ApproveResult, Error, string[], { previous?: ReviewRow[] }>({
    mutationKey: mk.review.approve,
  });
}

/* -------------------------------------------------------------------------- */

export interface ReassignInput {
  id: string;
  supplierId: string;
  /**
   * Carried, not looked up. HANDOFF §2 rule 4: a write resumed by key from a
   * cold start has no component left holding a supplier list, and the
   * optimistic row needs a name to render.
   */
  supplierName: string;
}

/**
 * Move a venue's invoice off "Supplier not listed" onto a real supplier.
 *
 * This is the other half of taking supplier creation away from the shops
 * (CATCH_UP_013 §5). The shop files against the placeholder and writes the
 * real name in the note; one of the four reads the note, creates the supplier
 * if it is genuinely new, and points the invoice at it — all from the review
 * screen, because a correction that requires going somewhere else is a
 * correction that does not get made.
 *
 * A plain update rather than an RPC: members already have `member_all`, and
 * there is no rule here that a policy is not already enforcing.
 */
export function registerReassignMutations(queryClient: QueryClient) {
  queryClient.setMutationDefaults(mk.review.reassign, {
    mutationFn: async ({ id, supplierId }: ReassignInput): Promise<void> => {
      const { error } = await supabase()
        .from('invoices')
        .update({ supplier_id: supplierId })
        .eq('id', id);

      if (error) throw error;
    },

    onMutate: async (input: ReassignInput) => {
      await queryClient.cancelQueries({ queryKey: qk.invoices.review });
      const previous = queryClient.getQueryData<ReviewRow[]>(qk.invoices.review);

      queryClient.setQueryData<ReviewRow[]>(qk.invoices.review, (current) =>
        (current ?? []).map((row) =>
          row.id === input.id
            ? {
                ...row,
                supplier_id: input.supplierId,
                supplier: {
                  id: input.supplierId,
                  name: input.supplierName,
                  is_placeholder: false,
                },
              }
            : row,
        ),
      );

      return { previous };
    },

    onError: (
      _error: unknown,
      _input: ReassignInput,
      context: { previous?: ReviewRow[] } | undefined,
    ) => {
      if (context?.previous) {
        queryClient.setQueryData(qk.invoices.review, context.previous);
      }
    },

    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: qk.invoices.review });
      queryClient.invalidateQueries({ queryKey: qk.activity.recent });
    },
  });
}

export function useReassignSupplier() {
  return useMutation<void, Error, ReassignInput, { previous?: ReviewRow[] }>({
    mutationKey: mk.review.reassign,
  });
}
