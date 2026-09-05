'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { mk } from '@/lib/offline/keys';
import { supabase } from '@/lib/supabase/browser';
import { UNPAID_STALE_MS } from '@/lib/constants';
import { qk } from './keys';
import type { SalesInvoice, SalesInvoiceLine, SalesInvoiceRow } from '@/lib/types';

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

/** One line as the compose screen builds it, before the database sees it. */
export interface NewSalesLine {
  /** Null for a one-off line that is not a product. */
  product_id: string | null;
  description: string;
  unit: string | null;
  quantity_milli: number;
  unit_price_cents: number;
}

export interface CreateSalesInvoiceInput {
  id: string;
  business_id: string;
  customer_id: string;
  /** Null lets the database number it — DDL-0001. CATCH_UP_015 §3. */
  invoice_number: string | null;
  invoice_date: string;
  due_date: string;
  /**
   * Only consulted when there are no lines.
   *
   * With lines, the database sums them and ignores this — a header and its
   * lines that disagree is a document that lies about itself, and it gets
   * handed to a customer (CATCH_UP_015 §4).
   */
  amount_cents: number;
  /**
   * A column on the row, not a second notes table.
   *
   * A payables invoice is something several people talk about over a
   * fortnight; a sales invoice is a document you issue once. Giving this one a
   * thread would be symmetry for its own sake.
   */
  note: string | null;
  created_by: string;
  /**
   * Empty for the "record one we already sent" path, which is how this worked
   * before line items existed and still works.
   *
   * One input shape and one mutation key for both, deliberately. Two keys
   * would be two paths that build one record, which is notes §1.3 exactly.
   * `OFFLINE_SCHEMA` went to v2 for this.
   */
  lines: NewSalesLine[];
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
    /*
     * One RPC, one transaction — notes §1.6, and the same reason
     * `mark_invoices_paid` is one: a header written here and lines written
     * there is a document that can exist half-made.
     *
     * It is idempotent on the client-generated id inside the function, so a
     * replay off the offline queue returns the existing row rather than
     * invoicing a customer twice. That matters more on this side than on the
     * payables side: a duplicated receivable is money we would chase somebody
     * for a second time.
     */
    mutationFn: async (input: CreateSalesInvoiceInput): Promise<SalesInvoice> => {
      const { lines, ...invoice } = input;

      const { data, error } = await supabase().rpc('create_sales_invoice', {
        p_invoice: invoice,
        p_lines: lines,
      });

      if (error) throw error;
      return data as SalesInvoice;
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
  return useMutation<SalesInvoice, Error, CreateSalesInvoiceInput>({
    mutationKey: mk.sales.create,
  });
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

/* -------------------------------------------------------------------------- */

export interface SalesInvoiceDetail {
  invoice: SalesInvoiceRow;
  lines: SalesInvoiceLine[];
}

/**
 * One issued invoice and its lines — what the printed document is made of.
 *
 * Two round trips rather than a nested select, because the document must not
 * render half of itself: an embedded `lines(...)` that PostgREST could not
 * satisfy comes back as an empty array, not an error, and the page would print
 * a header with a total and no lines under it. Asked separately, a failure is
 * a failure and the screen says so.
 *
 * Ordered by `position`, which is what the unique index on
 * (sales_invoice_id, position) exists to make meaningful — without it the
 * order of a printed document would be whatever the planner returned.
 */
export function useSalesInvoice(id: string) {
  return useQuery({
    queryKey: qk.sales.detail(id),
    queryFn: async (): Promise<SalesInvoiceDetail | null> => {
      const { data: invoice, error } = await supabase()
        .from('sales_invoices')
        .select(ROW_SELECT)
        .eq('id', id)
        .maybeSingle();

      if (error) throw error;
      if (!invoice) return null;

      const { data: lines, error: linesError } = await supabase()
        .from('sales_invoice_lines')
        .select('*')
        .eq('sales_invoice_id', id)
        .order('position');

      if (linesError) throw linesError;

      return {
        invoice: invoice as unknown as SalesInvoiceRow,
        lines: (lines ?? []) as SalesInvoiceLine[],
      };
    },
    enabled: id !== '',
    staleTime: 30_000,
  });
}
