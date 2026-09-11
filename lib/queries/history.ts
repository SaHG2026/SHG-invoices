'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { mk } from '@/lib/offline/keys';
import { supabase } from '@/lib/supabase/browser';
import { buildHistorySearch } from '@/lib/derive/history';
import { HISTORY_PAGE_SIZE, SUPPLIER_RANGE_MAX } from '@/lib/constants';
import { compareDates, isDateStr, type DateStr } from '@/lib/date';
import { SUPPLIER_COLUMNS } from './reference';
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
 * One supplier, between two dates. Asked for after real use: "an option within
 * suppliers to check total pending between two time periods."
 *
 * ---------------------------------------------------------------------------
 * Two decisions worth keeping.
 *
 * **It asks the database rather than filtering what the page already has.**
 * `useSupplierInvoices` stops at 300 rows, which is generous for a page and
 * silently wrong for a question about 2024. A total computed over a truncated
 * array is exactly the failure notes §3 names, and it would look right.
 *
 * **It asks for one row more than it will show.** If that row comes back, the
 * range is wider than this can total, and the screen says so instead of
 * reporting a figure it knows is short. A refused answer can be narrowed; a
 * wrong one gets written down.
 * ---------------------------------------------------------------------------
 *
 * The basis is the caller's choice and neither default is safe to assume:
 * "what falls due in October" and "what they billed us in October" are
 * different questions with different answers, and the screen labels which one
 * it is showing rather than picking quietly.
 */
export type RangeBasis = 'due' | 'invoice';

export interface SupplierRange {
  rows: InvoiceRow[];
  /** More invoices matched than can be totalled honestly. */
  truncated: boolean;
}

export function useSupplierRange(
  supplierId: string,
  from: string,
  to: string,
  basis: RangeBasis,
) {
  const column = basis === 'due' ? 'due_date' : 'invoice_date';
  const usable =
    supplierId !== '' && isDateStr(from) && isDateStr(to) && compareDates(from, to) <= 0;

  return useQuery({
    queryKey: qk.invoices.forSupplierRange(supplierId, { from, to, basis }),
    queryFn: async (): Promise<SupplierRange> => {
      const { data, error } = await supabase()
        .from('invoices')
        .select(ROW_SELECT)
        .eq('supplier_id', supplierId)
        .gte(column, from as DateStr)
        .lte(column, to as DateStr)
        .order(column, { ascending: false })
        .limit(SUPPLIER_RANGE_MAX + 1);

      if (error) throw error;

      const rows = (data ?? []) as unknown as InvoiceRow[];
      return rows.length > SUPPLIER_RANGE_MAX
        ? { rows: [], truncated: true }
        : { rows, truncated: false };
    },
    enabled: usable,
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
export function registerSupplierEditMutations(queryClient: QueryClient) {
  queryClient.setMutationDefaults(mk.suppliers.update, {
    mutationFn: async ({
      id,
      ...changes
    }: Partial<Supplier> & { id: string }): Promise<Supplier> => {
      const { data, error } = await supabase()
        .from('suppliers')
        .update(changes)
        .eq('id', id)
        .select(SUPPLIER_COLUMNS)
        .single();

      if (error) {
        if (error.code === '23505') {
          throw new Error('There is already an active supplier with that name.');
        }
        throw error;
      }
      return data as Supplier;
    },
    onSuccess: (supplier: Supplier) => {
      queryClient.setQueryData<Supplier[]>(qk.suppliers.all, (current) =>
        (current ?? []).map((existing) => (existing.id === supplier.id ? supplier : existing)),
      );
      queryClient.invalidateQueries({ queryKey: qk.suppliers.all });
    },
  });
}

export function useUpdateSupplier() {
  return useMutation<Supplier, Error, Partial<Supplier> & { id: string }>({
    mutationKey: mk.suppliers.update,
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
        .select(SUPPLIER_COLUMNS)
        .order('name');

      if (error) throw error;
      return (data ?? []) as Supplier[];
    },
    staleTime: 60_000,
  });
}
