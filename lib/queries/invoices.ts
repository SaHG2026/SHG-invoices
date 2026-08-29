'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase/browser';
import { pushRecentSupplierId } from '@/lib/recents';
import { DUPE_LOOKBACK_DAYS, UNPAID_STALE_MS } from '@/lib/constants';
import { qk } from './keys';
import type { Business, Invoice, InvoiceRow, Supplier } from '@/lib/types';
import type { InvoiceWrite } from '@/lib/invoice-form';

/** Everything a list row needs, in one round trip. */
const ROW_SELECT =
  '*, supplier:suppliers!inner(id, name), business:businesses!inner(id, code, name)';

/**
 * Every unpaid invoice, unfiltered.
 *
 * Architecture §2: this is the ONE query behind Home, Pending, the payment
 * runs, all four sorts and every total. Business and supplier filters are
 * applied client-side over this array rather than in the query, which is what
 * makes it impossible for a filtered total to disagree with the filtered list
 * it sits under (notes §3).
 */
export function useUnpaidInvoices() {
  return useQuery({
    queryKey: qk.invoices.unpaid,
    queryFn: async (): Promise<InvoiceRow[]> => {
      const { data, error } = await supabase()
        .from('invoices')
        .select(ROW_SELECT)
        .eq('status', 'unpaid')
        .order('due_date');

      if (error) throw error;
      return (data ?? []) as unknown as InvoiceRow[];
    },
    // Notes §1.4: never 0 on a list that receives optimistic updates.
    staleTime: UNPAID_STALE_MS,
  });
}

export interface CreateInvoiceInput {
  payload: InvoiceWrite & { id: string };
  /** Carried so the optimistic row can render immediately, before any refetch. */
  supplier: Pick<Supplier, 'id' | 'name'>;
  business: Pick<Business, 'id' | 'code' | 'name'>;
}

/**
 * Add an invoice.
 *
 * Written to the pattern in ARCHITECTURE §7, and the two non-obvious parts are
 * both from the notes:
 *
 * `cancelQueries` first (notes §1.4). Without it an already-in-flight fetch can
 * land after the optimistic update and overwrite it, and the new row vanishes
 * for a second before reappearing — which reads as "did that save?".
 *
 * `upsert(..., { ignoreDuplicates: true })` on a client-generated id (notes
 * §1.5). The insert becomes `on conflict (id) do nothing`, so a write replayed
 * from the offline queue is a no-op rather than a second identical invoice.
 * The id is generated before sending precisely so a retry can be recognised.
 */
export function useCreateInvoice() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ payload }: CreateInvoiceInput): Promise<Invoice | null> => {
      const { data, error } = await supabase()
        .from('invoices')
        .upsert(payload, { onConflict: 'id', ignoreDuplicates: true })
        .select()
        .maybeSingle();

      if (error) throw error;
      // `null` means the row already existed — a replayed write. Not an error.
      return (data as Invoice | null) ?? null;
    },

    onMutate: async (input: CreateInvoiceInput) => {
      // Non-negotiable. See above.
      await queryClient.cancelQueries({ queryKey: qk.invoices.unpaid });

      const previous = queryClient.getQueryData<InvoiceRow[]>(qk.invoices.unpaid);
      const now = new Date().toISOString();

      const optimistic: InvoiceRow = {
        ...input.payload,
        // The reference is stamped by a database trigger, so it genuinely is
        // not known yet. Showing an invented one would be a lie that later
        // changes under the person who read it.
        internal_ref: '',
        status: 'unpaid',
        paid_at: null,
        paid_by: null,
        payment_ref: null,
        void_reason: null,
        created_at: now,
        updated_at: now,
        supplier: input.supplier,
        business: input.business,
      };

      queryClient.setQueryData<InvoiceRow[]>(qk.invoices.unpaid, (current) => [
        optimistic,
        ...(current ?? []),
      ]);

      return { previous };
    },

    onError: (_error, _input, context) => {
      if (context?.previous) {
        queryClient.setQueryData(qk.invoices.unpaid, context.previous);
      }
    },

    onSuccess: (_data, input) => {
      pushRecentSupplierId(input.supplier.id);
    },

    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: qk.invoices.unpaid });
      queryClient.invalidateQueries({ queryKey: qk.activity.recent });
    },
  });
}

/**
 * The duplicate check. Spec §6: a warning, never a block.
 *
 * "Suppliers restart numbering; a hard unique index will block legitimate
 * entries." So this runs on demand, at save time, and the person decides.
 */
export async function findDuplicates(
  supplierId: string,
  invoiceNumber: string,
): Promise<Invoice[]> {
  const trimmed = invoiceNumber.trim();
  if (trimmed === '') return [];

  const { data, error } = await supabase().rpc('find_duplicate_invoices', {
    p_supplier_id: supplierId,
    p_invoice_number: trimmed,
    p_lookback_days: DUPE_LOOKBACK_DAYS,
  });

  if (error) throw error;
  return (data ?? []) as Invoice[];
}
