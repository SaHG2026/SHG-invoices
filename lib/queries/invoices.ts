'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase/browser';
import { pushRecentSupplierId } from '@/lib/recents';
import { DUPE_LOOKBACK_DAYS, UNPAID_STALE_MS } from '@/lib/constants';
import { nowTimestamp } from '@/lib/date';
import { mk } from '@/lib/offline/keys';
import { useMemo } from 'react';
import { mergeRecentlyPaid, useRecentlyPaid } from '@/lib/recently-paid';
import { qk } from './keys';
import type { Business, Invoice, InvoiceRow, Supplier } from '@/lib/types';
import type { InvoiceWrite } from '@/lib/invoice-form';

/** Everything a list row needs, in one round trip. */
const ROW_SELECT =
  '*, supplier:suppliers!inner(id, name), business:businesses!inner(id, code, name)';

/**
 * Every unpaid invoice that has been accepted into the ledger.
 *
 * Architecture §2: this is the ONE query behind Home, Pending, the payment
 * runs, all four sorts and every total. Business and supplier filters are
 * applied client-side over this array rather than in the query, which is what
 * makes it impossible for a filtered total to disagree with the filtered list
 * it sits under (notes §3).
 *
 * ---------------------------------------------------------------------------
 * `approved_at is not null` is in the QUERY, not in a filter over the result.
 *
 * It is the one condition that must never be a client-side choice, because
 * this array is what every owed figure in the app is made of. Filtering it
 * here means an invoice waiting for review cannot reach a total by any route,
 * including a route somebody writes next year that forgets `onlyOwed`.
 *
 * The review queue is its own query over the other half, and it is the
 * architecture §2 exception that History already is: it feeds a count and a
 * total that no other screen has to agree with.
 * ---------------------------------------------------------------------------
 */
export function useUnpaidInvoices() {
  const query = useQuery({
    queryKey: qk.invoices.unpaid,
    queryFn: async (): Promise<InvoiceRow[]> => {
      const { data, error } = await supabase()
        .from('invoices')
        .select(ROW_SELECT)
        .eq('status', 'unpaid')
        .not('approved_at', 'is', null)
        .order('due_date');

      if (error) throw error;
      return (data ?? []) as unknown as InvoiceRow[];
    },
    // Notes §1.4: never 0 on a list that receives optimistic updates.
    staleTime: UNPAID_STALE_MS,
  });

  /*
   * Invoices ticked off during this session are folded back in, so a row does
   * not disappear out from under the person who just tapped it — and so a
   * payment run does not silently collapse and take its siblings off screen
   * with it. lib/recently-paid.ts has the full account of that bug.
   *
   * They arrive carrying `status: 'paid'`, and every summary calls
   * `onlyOwed` (lib/derive/select.ts), so none of them can reach a total.
   */
  const remembered = useRecentlyPaid();
  const data = useMemo(
    () => mergeRecentlyPaid(query.data ?? [], remembered),
    [query.data, remembered],
  );

  return { ...query, data };
}

export interface CreateInvoiceInput {
  payload: InvoiceWrite & { id: string };
  /** Carried so the optimistic row can render immediately, before any refetch. */
  supplier: Pick<Supplier, 'id' | 'name'>;
  business: Pick<Business, 'id' | 'code' | 'name'>;
  /**
   * Whether `stamp_approval` will hold this one back for review.
   *
   * ---------------------------------------------------------------------------
   * A plain boolean, sent by the caller, mirroring a database trigger.
   *
   * The trigger decides — the client cannot, and must not be believed if it
   * tries (CATCH_UP_013 §4 overwrites `approved_at` both ways). But `onMutate`
   * has to render something before the trigger has run, and the two possible
   * rows go to two different places: an approved one belongs in the unpaid
   * array, and an unapproved one belongs nowhere this account can see.
   *
   * Guessing wrong is not cosmetic. The comment on `approved_at` below says
   * why: a row put in the unpaid array carrying the one value that means "not
   * in the unpaid array" vanishes on the first refetch — which reads as the
   * invoice not having saved. So the caller says which case it is, and the
   * only cost of it being wrong is one flicker, in a direction the refetch
   * then corrects.
   *
   * Set by `AddInvoiceSheet` for an assistant filing against "Supplier not
   * listed" (CATCH_UP_026). Absent everywhere else, because everywhere else
   * the answer is "approved" — the venue sheet, whose invoices are never
   * approved, does not use this mutation at all.
   * ---------------------------------------------------------------------------
   */
  awaitsReview?: boolean;
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
interface CreateContext {
  previous?: InvoiceRow[];
}

/**
 * Registered at startup rather than declared in the hook — `lib/offline/keys.ts`
 * has the full reasoning. In one line: a write that outlives the app finds its
 * function again by key, and a hook that has been unmounted for two days
 * cannot supply one.
 */
export function registerInvoiceMutations(queryClient: QueryClient) {
  queryClient.setMutationDefaults(mk.invoices.create, {
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

    /*
     * Not re-run when a write resumes from disk.
     *
     * `onMutate` ran once, in the session that made the write, and its
     * context died with that session — so `onError` below is written to cope
     * with having none. That is the right way round: the optimistic row it
     * would have added is already gone, because reads are never persisted.
     */
    onMutate: async (input: CreateInvoiceInput): Promise<CreateContext> => {
      /*
       * Held back for review: nothing optimistic at all.
       *
       * The unpaid array is every owed figure in the app (§2), and this row is
       * not owed by anybody yet. There is no second list to put it in either —
       * the only account that files one of these is an assistant, and an
       * assistant cannot read the review queue. So the honest render is none,
       * and the toast is what says the write landed.
       */
      if (input.awaitsReview) return {};

      // Non-negotiable. See above.
      await queryClient.cancelQueries({ queryKey: qk.invoices.unpaid });

      const previous = queryClient.getQueryData<InvoiceRow[]>(qk.invoices.unpaid);
      const now = nowTimestamp();

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
        /*
         * Approved, because `stamp_approval` will approve it: this path is
         * only ever one of the four, and the trigger does not consult what the
         * client sent. Saying null here would put the row in the unpaid array
         * carrying the one value that means "not in the unpaid array", and it
         * would vanish on the first refetch.
         */
        approved_at: now,
        approved_by: input.payload.created_by,
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

    onError: (_error: unknown, _input: CreateInvoiceInput, context: CreateContext | undefined) => {
      if (context?.previous) {
        queryClient.setQueryData(qk.invoices.unpaid, context.previous);
      }
    },

    onSuccess: (_data: Invoice | null, input: CreateInvoiceInput) => {
      pushRecentSupplierId(input.supplier.id);
    },

    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: qk.invoices.unpaid });
      queryClient.invalidateQueries({ queryKey: qk.activity.recent });
      /*
       * The review queue too, unconditionally rather than only when
       * `awaitsReview` was set.
       *
       * `awaitsReview` is the client's belief and the trigger is the fact, and
       * the failure this guards against is the belief being wrong in the
       * direction nobody would notice — an invoice held for review while every
       * screen that could show it was never told to look again. Invalidating a
       * query no manager has mounted costs one no-op.
       */
      queryClient.invalidateQueries({ queryKey: qk.invoices.review });
    },
  });
}

export function useCreateInvoice() {
  return useMutation<Invoice | null, Error, CreateInvoiceInput, CreateContext>({
    mutationKey: mk.invoices.create,
  });
}

/**
 * The duplicate check. Spec §6: a warning, never a block.
 *
 * "Suppliers restart numbering; a hard unique index will block legitimate
 * entries." So this runs on demand, at save time, and the person decides.
 */
/**
 * The five facts the warning prints, and nothing else.
 *
 * A narrower shape than `Invoice` on purpose. The dialog has only ever used
 * these, and naming them is what lets an assistant's answer come from a
 * different function without the screen knowing or caring.
 */
export interface DuplicateMatch {
  id: string;
  invoice_number: string | null;
  invoice_date: string;
  amount_cents: number;
  internal_ref: string | null;
  created_by: string | null;
}

export async function findDuplicates(
  supplierId: string,
  invoiceNumber: string,
  { asAssistant = false }: { asAssistant?: boolean } = {},
): Promise<DuplicateMatch[]> {
  const trimmed = invoiceNumber.trim();
  if (trimmed === '') return [];

  /*
   * Two functions, one question.
   *
   * `find_duplicate_invoices` is `security invoker` and returns whole rows,
   * so after CATCH_UP_027 narrowed the assistant SELECT policy it would stop
   * finding anything already PAID — silently, and that is the most useful
   * warning it gives. `find_duplicate_invoices_assistant` is the same query
   * behind SECURITY DEFINER, returning only the fields above.
   *
   * This is CATCH_UP_010 §5's arrangement for the shops, one tier later:
   * `findVenueDuplicates` in `lib/queries/venue.ts` is the same idea and the
   * reason the pattern was already there to copy. A permission change must
   * not weaken a spec §6 protection as a side effect.
   */
  const { data, error } = await supabase().rpc(
    asAssistant ? 'find_duplicate_invoices_assistant' : 'find_duplicate_invoices',
    {
      p_supplier_id: supplierId,
      p_invoice_number: trimmed,
      p_lookback_days: DUPE_LOOKBACK_DAYS,
    },
  );

  if (error) throw error;
  return (data ?? []) as DuplicateMatch[];
}
