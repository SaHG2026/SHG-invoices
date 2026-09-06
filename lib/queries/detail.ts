'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { mk } from '@/lib/offline/keys';
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

/**
 * `23505` on the primary key means this exact row is already there.
 *
 * That is a write replayed from the offline queue doing its job, not a
 * failure: the id was generated on the client before sending precisely so a
 * retry could be recognised (notes §1.5). Treated as success, and nothing else
 * is — a `23505` naming any OTHER unique index is a real collision and must
 * still be thrown.
 */
function isReplayOfSameRow(error: { code?: string; message?: string; details?: string } | null, pkey: string): boolean {
  if (!error || error.code !== '23505') return false;
  return `${error.message ?? ''} ${error.details ?? ''}`.includes(pkey);
}

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

export interface AddNoteInput {
  /**
   * Generated on the client before sending, so a note replayed from the
   * offline queue conflicts on the primary key instead of appearing twice.
   * Notes 1.5 - the same move the invoice insert makes, for the same reason.
   */
  id: string;
  invoiceId: string;
  body: string;
  authorId: string;
}

export function registerNoteMutations(queryClient: QueryClient) {
  queryClient.setMutationDefaults(mk.notes.add, {
    mutationFn: async ({
      id,
      invoiceId,
      body,
      authorId,
    }: AddNoteInput): Promise<InvoiceNote | null> => {
      /*
       * A plain insert, for the same reason `lib/queries/venue.ts` uses one.
       *
       * `.upsert()` becomes `INSERT ... ON CONFLICT`, which requires the
       * table's UPDATE policies — and a venue has none on `invoice_notes`. So
       * a shop's note was refused `42501` whatever else was true, which is a
       * second wall in front of the same feature CATCH_UP_016 unblocked.
       *
       * Members are unaffected either way; one path is simpler than two, and
       * the replay guarantee is unchanged because the id still comes from the
       * client.
       */
      const { data, error } = await supabase()
        .from('invoice_notes')
        .insert({ id, invoice_id: invoiceId, author_id: authorId, body: body.trim() })
        .select('id, invoice_id, author_id, body, created_at')
        .maybeSingle();

      // Already there: a replayed write, not a failure.
      if (isReplayOfSameRow(error, 'invoice_notes_pkey')) return null;
      if (error) throw error;
      return (data as InvoiceNote | null) ?? null;
    },
    onSettled: (_data: unknown, _error: unknown, input: AddNoteInput) => {
      queryClient.invalidateQueries({ queryKey: ['notes', input.invoiceId] });
    },
  });
}

/**
 * The invoice id moved out of the closure and into the variables.
 *
 * A queued note is resumed by key from a cold start, with no component left
 * holding the id it belongs to - so anything the write needs has to travel in
 * the variables that were persisted alongside it. lib/offline/keys.ts.
 */
export function useAddNote() {
  return useMutation<InvoiceNote | null, Error, AddNoteInput>({ mutationKey: mk.notes.add });
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
