'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase/browser';
import { qk } from './keys';
import type { ActivityEntry, InvoiceNote, InvoiceRow } from '@/lib/types';

/**
 * One invoice, and everything said about it.
 *
 * Separate from the unpaid list on purpose. The list holds only unpaid
 * invoices (architecture §2); this fetches any invoice by id, whatever its
 * status, because a link to a paid or voided one has to keep working.
 */

const ROW_SELECT =
  '*, supplier:suppliers!inner(id, name), business:businesses!inner(id, code, name)';

export function useInvoice(id: string) {
  return useQuery({
    queryKey: qk.invoices.detail(id),
    queryFn: async (): Promise<InvoiceRow | null> => {
      const { data, error } = await supabase()
        .from('invoices')
        .select(ROW_SELECT)
        .eq('id', id)
        .maybeSingle();

      if (error) throw error;
      return (data as unknown as InvoiceRow | null) ?? null;
    },
    staleTime: 15_000,
  });
}

/**
 * The audit trail for one invoice.
 *
 * Read-only by design: `activity_log` has a select policy and no insert
 * policy, so the only writer is the database trigger. A log you can write to
 * by hand is not a log (migration 007).
 */
export function useInvoiceActivity(id: string) {
  return useQuery({
    queryKey: qk.activity.forInvoice(id),
    queryFn: async (): Promise<ActivityEntry[]> => {
      const { data, error } = await supabase()
        .from('activity_log')
        .select('id, entity_type, entity_id, action, actor_id, detail, created_at')
        .eq('entity_type', 'invoice')
        .eq('entity_id', id)
        .order('created_at');

      if (error) throw error;
      return (data ?? []) as ActivityEntry[];
    },
    staleTime: 15_000,
  });
}

export function useInvoiceNotes(id: string) {
  return useQuery({
    queryKey: ['notes', id] as const,
    queryFn: async (): Promise<InvoiceNote[]> => {
      const { data, error } = await supabase()
        .from('invoice_notes')
        .select('id, invoice_id, author_id, body, created_at')
        .eq('invoice_id', id)
        .order('created_at');

      if (error) throw error;
      return (data ?? []) as InvoiceNote[];
    },
    staleTime: 15_000,
  });
}

export function useAddNote(invoiceId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ body, authorId }: { body: string; authorId: string }) => {
      const { data, error } = await supabase()
        .from('invoice_notes')
        .insert({ invoice_id: invoiceId, author_id: authorId, body: body.trim() })
        .select('id, invoice_id, author_id, body, created_at')
        .single();

      if (error) throw error;
      return data as InvoiceNote;
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['notes', invoiceId] });
    },
  });
}

/**
 * Recent activity across everything, for the header bell.
 *
 * Capped rather than paginated: the bell answers "has anything happened",
 * and nobody scrolls a notification list looking for the fiftieth item.
 */
export function useRecentActivity(limit = 50) {
  return useQuery({
    queryKey: qk.activity.recent,
    queryFn: async (): Promise<ActivityEntry[]> => {
      const { data, error } = await supabase()
        .from('activity_log')
        .select('id, entity_type, entity_id, action, actor_id, detail, created_at')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) throw error;
      return (data ?? []) as ActivityEntry[];
    },
    staleTime: 30_000,
  });
}
