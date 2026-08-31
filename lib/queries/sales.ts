'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { mk } from '@/lib/offline/keys';
import { supabase } from '@/lib/supabase/browser';
import { UNPAID_STALE_MS } from '@/lib/constants';
import { qk } from './keys';
import type { SalesInvoice, SalesInvoiceRow } from '@/lib/types';

/**
 * Invoices Deli Delights has sent, and what has come back.
 *
 * The mirror of lib/queries/invoices.ts and lib/queries/payments.ts, against
 * its own table. ARCHITECTURE §17 sets out why this is a second ledger rather
 * than a direction flag; the consequence here is that this file shares no
 * query key, no array and no derive function with the payables side, so
 * receivables cannot reach the owed or pending figures by any route.
 *
 * Vocabulary is `received`, never `paid`. You do not pay an invoice you
 * issued, and a shared word is how two directions end up sharing a code path.
 */

const ROW_SELECT = '*, customer:customers!inner(id, name)';

/** Everything still owed to us. The one query the receivable figures derive from. */
export function useOutstandingSales() {
  return useQuery({
    queryKey: qk.sales.outstanding,
    queryFn: async (): Promise<SalesInvoiceRow[]> => {
      const { data, error } = await supabase()
        .from('sales_invoices')
        .select(ROW_SELECT)
        .eq('status', 'outstanding')
        .order('due_date');

      if (error) throw error;
      return (data ?? []) as unknown as SalesInvoiceRow[];
    },
    staleTime: UNPAID_STALE_MS,
  });
}

/** One customer's whole history, outstanding and settled. */
export function useCustomerSales(customerId: string) {
  return useQuery({
    queryKey: qk.sales.forCustomer(customerId),
    queryFn: async (): Promise<SalesInvoiceRow[]> => {
      const { data, error } = await supabase()
        .from('sales_invoices')
        .select(ROW_SELECT)
        .eq('customer_id', customerId)
        .order('due_date', { ascending: false });

      if (error) throw error;
      return (data ?? []) as unknown as SalesInvoiceRow[];
    },
    staleTime: UNPAID_STALE_MS,
    enabled: customerId !== '',
  });
}

export interface CreateSalesInvoiceInput {
  id: string;
  business_id: string;
  customer_id: string;
  invoice_number: string | null;
  invoice_date: string;
  due_date: string;
  amount_cents: number;
  created_by: string;
}

/**
 * Record an invoice we have sent.
 *
 * Upserted on the client-generated id, ignoring duplicates — notes §1.5. A
 * retried write is a no-op rather than a second invoice for the same money,
 * which matters more here than on the payables side: a duplicated receivable
 * is money we would chase a customer for twice.
 */
export function registerSalesMutations(queryClient: QueryClient) {
  queryClient.setMutationDefaults(mk.sales.create, {
    mutationFn: async (input: CreateSalesInvoiceInput): Promise<void> => {
      const { error } = await supabase()
        .from('sales_invoices')
        .upsert(input, { onConflict: 'id', ignoreDuplicates: true });

      if (error) throw error;
    },
    onSettled: (_data: unknown, _error: unknown, input: CreateSalesInvoiceInput) => {
      queryClient.invalidateQueries({ queryKey: qk.sales.all });
      queryClient.invalidateQueries({ queryKey: qk.sales.forCustomer(input.customer_id) });
    },
  });

  queryClient.setMutationDefaults(mk.sales.markReceived, {
    mutationFn: async ({ ids, reference }: MarkReceivedInput): Promise<MarkReceivedResult> => {
      const { data, error } = await supabase().rpc('mark_sales_received', {
        p_ids: ids,
        p_ref: reference?.trim() || null,
      });

      if (error) throw error;

      const received = (data ?? []) as SalesInvoice[];
      const done = new Set(received.map((row) => row.id));
      return { received, missed: ids.filter((id) => !done.has(id)) };
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: qk.sales.all });
    },
  });

  queryClient.setMutationDefaults(mk.sales.unmarkReceived, {
    mutationFn: async (id: string): Promise<void> => {
      const { error } = await supabase().rpc('unmark_sales_received', { p_id: id });
      if (error) throw error;
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: qk.sales.all });
    },
  });
}

export function useCreateSalesInvoice() {
  return useMutation<void, Error, CreateSalesInvoiceInput>({ mutationKey: mk.sales.create });
}

export interface MarkReceivedResult {
  received: SalesInvoice[];
  /** Asked for but already received or voided by somebody else. */
  missed: string[];
}

/**
 * Money in. One statement, one transaction — notes §1.6.
 *
 * The RPC returns only the rows it actually changed, so if somebody recorded
 * the same payment a minute ago that row comes back missing rather than being
 * silently re-stamped with a new name and time.
 */
export interface MarkReceivedInput {
  ids: string[];
  reference?: string;
}

export function useMarkReceived() {
  return useMutation<MarkReceivedResult, Error, MarkReceivedInput>({
    mutationKey: mk.sales.markReceived,
  });
}

export function useUnmarkReceived() {
  return useMutation<void, Error, string>({ mutationKey: mk.sales.unmarkReceived });
}
