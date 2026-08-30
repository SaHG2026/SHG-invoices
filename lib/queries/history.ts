'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase/browser';
import { buildHistorySearch } from '@/lib/derive/history';
import { HISTORY_PAGE_SIZE } from '@/lib/constants';
import { qk } from './keys';
import type { InvoiceRow, Supplier } from '@/lib/types';

const ROW_SELECT =
  '*, supplier:suppliers!inner(id, name), business:businesses!inner(id, code, name)';

export interface HistoryFilters {
  /** Business id, or null for every business. */
  businessId?: string | null;
  /** Spec §7.7: "everything Sujan ticked off in July" in two taps. */
  paidBy?: string | null;
  search?: string;
  /** Voided invoices are hidden by default — they are corrections, not history. */
  includeVoid?: boolean;
}

/**
 * Paid and voided invoices. Spec §7.7.
 *
 * The exception to architecture §2: this is filtered and paginated by the
 * database rather than in the browser, because it grows without bound. It is
 * also the one list that never feeds a total another screen has to agree with,
 * which is what makes that safe.
 */
export function useHistory(filters: HistoryFilters, suppliers: readonly Supplier[]) {
  return useQuery({
    queryKey: qk.invoices.history(filters as Record<string, unknown>),
    queryFn: async (): Promise<InvoiceRow[]> => {
      let query = supabase()
        .from('invoices')
        .select(ROW_SELECT)
        .in('status', filters.includeVoid ? ['paid', 'void'] : ['paid'])
        // Newest first: history is read backwards from now.
        .order('paid_at', { ascending: false, nullsFirst: false })
        .order('updated_at', { ascending: false })
        .limit(HISTORY_PAGE_SIZE);

      if (filters.businessId) query = query.eq('business_id', filters.businessId);
      if (filters.paidBy) query = query.eq('paid_by', filters.paidBy);

      const search = buildHistorySearch(filters.search ?? '', suppliers);
      if (search.or) query = query.or(search.or);

      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as unknown as InvoiceRow[];
    },
    staleTime: 30_000,
  });
}

/** Every invoice for one supplier, whatever its status. Spec §7.5. */
export function useSupplierInvoices(supplierId: string) {
  return useQuery({
    queryKey: qk.invoices.forSupplier(supplierId),
    queryFn: async (): Promise<InvoiceRow[]> => {
      const { data, error } = await supabase()
        .from('invoices')
        .select(ROW_SELECT)
        .eq('supplier_id', supplierId)
        .order('invoice_date', { ascending: false })
        .limit(300);

      if (error) throw error;
      return (data ?? []) as unknown as InvoiceRow[];
    },
    staleTime: 30_000,
  });
}

/**
 * Edit a supplier. Spec §7.8: list, add, edit, deactivate.
 *
 * Deactivating rather than deleting — it hides them from the type-ahead and
 * keeps every invoice they ever sent (notes §8). The unique index on the name
 * only covers active suppliers, so a name can be reused after deactivation.
 */
export function useUpdateSupplier() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      ...changes
    }: Partial<Supplier> & { id: string }): Promise<Supplier> => {
      const { data, error } = await supabase()
        .from('suppliers')
        .update(changes)
        .eq('id', id)
        .select('id, name, default_terms_days, contact_name, contact_phone, notes, active')
        .single();

      if (error) {
        if (error.code === '23505') {
          throw new Error('There is already an active supplier with that name.');
        }
        throw error;
      }
      return data as Supplier;
    },
    onSuccess: (supplier) => {
      queryClient.setQueryData<Supplier[]>(qk.suppliers.all, (current) =>
        (current ?? []).map((existing) => (existing.id === supplier.id ? supplier : existing)),
      );
      queryClient.invalidateQueries({ queryKey: qk.suppliers.all });
    },
  });
}

/**
 * Every supplier, including deactivated ones.
 *
 * The type-ahead uses the active-only list; the admin screen needs both, or a
 * supplier deactivated by mistake would be unreachable and unrecoverable.
 */
export function useAllSuppliers() {
  return useQuery({
    queryKey: ['suppliers', 'all-including-inactive'] as const,
    queryFn: async (): Promise<Supplier[]> => {
      const { data, error } = await supabase()
        .from('suppliers')
        .select('id, name, default_terms_days, contact_name, contact_phone, notes, active')
        .order('name');

      if (error) throw error;
      return (data ?? []) as Supplier[];
    },
    staleTime: 60_000,
  });
}
