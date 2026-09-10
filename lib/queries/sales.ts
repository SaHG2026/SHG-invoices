'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { mk } from '@/lib/offline/keys';
import { supabase } from '@/lib/supabase/browser';
import { UNPAID_STALE_MS } from '@/lib/constants';
import { qk } from './keys';
import type { SalesInvoice, SalesInvoiceLine, SalesInvoiceRow, SalesInvoiceAdjustment } from '@/lib/types';

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

/**
 * Every sales invoice, with its customer AND its adjustments. §53, J5.
 *
 * ---------------------------------------------------------------------------
 * The embed is not optional, and the type cannot enforce it here.
 *
 * `SalesInvoiceRow.adjustments` is required precisely so a forgotten embed is
 * a compile error — but every read in this file casts the PostgREST result
 * through `as unknown as`, and a double cast defeats exactly that check. So
 * `tsc` found the fixtures and could not find these.
 *
 * What makes it safe instead is that this constant is the ONLY way this file
 * reads a sales invoice. All three queries share it, so the embed is in one
 * place and cannot be half-applied — which is the same argument `onlyOwed`
 * makes for living in one function.
 *
 * A query that dropped it would not fail. It would report a net equal to the
 * full amount: too high, entirely ordinary-looking, and visible in
 * Receivables as money nobody owes.
 * ---------------------------------------------------------------------------
 */
const ROW_SELECT =
  '*, customer:customers!inner(id, name), adjustments:sales_invoice_adjustments(*)';

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
  /**
   * Null when none was issued — CATCH_UP_017, and the switch on the compose
   * screen. `->>` on a JSON null yields SQL NULL, so the RPC needed no edit.
   */
  due_date: string | null;
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

  /**
   * Applying a discount or a refund. §53, J5.
   *
   * ---------------------------------------------------------------------------
   * Manager level, and the refusal is the database's.
   *
   * `add_sales_adjustment` checks `is_manager_or_above()` and refuses with
   * 42501. The screen hides the control from anybody else, which is notes §6 —
   * but the function is what makes the boundary real, and its sentences are
   * written to be read by a person, so they are shown verbatim rather than
   * replaced with a house message.
   *
   * It also refuses an amount that would take the invoice below nothing, and
   * that refusal names what is left. That is the one somebody will actually
   * hit, by typing 400 for 40.
   * ---------------------------------------------------------------------------
   */
  queryClient.setMutationDefaults(mk.sales.adjust, {
    mutationFn: async (input: AddAdjustmentInput): Promise<SalesInvoiceAdjustment> => {
      const { data, error } = await supabase().rpc('add_sales_adjustment', {
        p_id: input.id,
        p_invoice_id: input.salesInvoiceId,
        p_kind: input.kind,
        p_amount_cents: input.amountCents,
        p_reason: input.reason,
      });

      if (error) {
        /*
         * A replay off the queue landing twice. The id was generated on the
         * client, so the second arrival collides on the primary key and ONLY
         * on the primary key -- which means the first one worked. Anything
         * else is a real failure. CATCH_UP_015 §3 established the pattern.
         */
        if (error.code === '23505') return { id: input.id } as SalesInvoiceAdjustment;
        throw new Error(error.message);
      }
      return data as SalesInvoiceAdjustment;
    },
    onSettled: (_data: unknown, _error: unknown, input: AddAdjustmentInput) => {
      queryClient.invalidateQueries({ queryKey: qk.sales.all });
      queryClient.invalidateQueries({ queryKey: qk.sales.detail(input.salesInvoiceId) });
    },
  });

  queryClient.setMutationDefaults(mk.sales.unadjust, {
    mutationFn: async (input: VoidAdjustmentInput): Promise<void> => {
      const { error } = await supabase().rpc('void_sales_adjustment', {
        p_id: input.id,
        p_reason: input.reason ?? null,
      });
      if (error) throw new Error(error.message);
    },
    onSettled: (_data: unknown, _error: unknown, input: VoidAdjustmentInput) => {
      queryClient.invalidateQueries({ queryKey: qk.sales.all });
      queryClient.invalidateQueries({ queryKey: qk.sales.detail(input.salesInvoiceId) });
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

/**
 * Everything a queued adjustment needs, in its variables and nowhere else.
 *
 * HANDOFF §2 rule 4: a write is resumed by key from a cold start, so nothing
 * may be captured in a closure. `salesInvoiceId` is here rather than looked up
 * from the screen for exactly that reason — `onSettled` needs it to invalidate
 * the right detail query, and by then the screen is long gone.
 */
export interface AddAdjustmentInput {
  id: string;
  salesInvoiceId: string;
  kind: 'discount' | 'refund';
  amountCents: number;
  reason: string;
}

export interface VoidAdjustmentInput {
  id: string;
  salesInvoiceId: string;
  reason: string | null;
}

export function useAddSalesAdjustment() {
  return useMutation<SalesInvoiceAdjustment, Error, AddAdjustmentInput>({
    mutationKey: mk.sales.adjust,
  });
}

export function useVoidSalesAdjustment() {
  return useMutation<void, Error, VoidAdjustmentInput>({ mutationKey: mk.sales.unadjust });
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
