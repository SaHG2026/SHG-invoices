'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase/browser';
import { UNPAID_STALE_MS, DUPE_LOOKBACK_DAYS } from '@/lib/constants';
import { nowTimestamp } from '@/lib/date';
import { mk } from '@/lib/offline/keys';
import { qk } from './keys';
import type { StaffInvoice } from '@/lib/types';
import type { InvoiceWrite } from '@/lib/invoice-form';

/**
 * Everything a venue account reads and writes.
 *
 * ---------------------------------------------------------------------------
 * The one rule this file exists to keep
 *
 * A venue account has **no SELECT policy on `invoices`**. Not a narrow one —
 * none (CATCH_UP_010 §4). Everything it reads comes from the `staff_invoices`
 * view, which omits `status`, `paid_at`, `paid_by`, `payment_ref` and
 * `void_reason` because RLS cannot restrict columns and a column-level grant
 * would hide them from Mani too.
 *
 * So every request in this file either goes to the view or is a bare insert.
 * If a `.from('invoices')` ever appears below, the feature is broken and the
 * symptom is silent: PostgREST returns an empty array rather than an error,
 * so the screen looks fine and shows nothing.
 * ---------------------------------------------------------------------------
 */

/** Every column the view has. Named rather than `*`, so a widened view is visible here. */
const VIEW_SELECT =
  'id, business_id, supplier_id, supplier_name, invoice_number, internal_ref, invoice_date, due_date, amount_cents, created_at';

/**
 * What this venue has logged.
 *
 * The scoping is not here. `staff_invoices` filters on `staff_venue()`, which
 * reads the caller's own JWT — so this query cannot ask for another venue, and
 * asking would return nothing rather than something. That is deliberate:
 * ARCHITECTURE §2's "one array, one total" rule survives intact, because the
 * array is still the whole of what this person may see.
 *
 * Every invoice, paid or not, is in here. If it held only unpaid ones a row
 * vanishing would BE the payment notification — absence leaking exactly the
 * fact being withheld. Nothing on the venue screen may change when money moves.
 *
 * Newest first by the date on the docket, because the question this screen
 * answers is "did last Tuesday's delivery get logged?".
 */
export function useVenueInvoices() {
  return useQuery({
    queryKey: qk.venue.invoices,
    queryFn: async (): Promise<StaffInvoice[]> => {
      const { data, error } = await supabase()
        .from('staff_invoices')
        .select(VIEW_SELECT)
        .order('invoice_date', { ascending: false })
        .order('created_at', { ascending: false });

      if (error) throw error;
      return (data ?? []) as StaffInvoice[];
    },
    // Notes §1.4: never 0 on a list that receives optimistic updates.
    staleTime: UNPAID_STALE_MS,
  });
}

/**
 * The duplicate warning, for a venue.
 *
 * `findDuplicates` in lib/queries/invoices.ts cannot be reused: it calls an RPC
 * returning `setof invoices`, which is the whole row including `status` and
 * `paid_at`. Pointing a venue at it would leak payment status through the back
 * door and undo the view.
 *
 * Spec §6 is why this exists at all — a warning, never a block. And it matters
 * more here than anywhere else in the app: one login is shared by whoever is
 * on shift, so the person entering this invoice genuinely cannot see what the
 * last shift did.
 */
export interface VenueDuplicate {
  id: string;
  invoice_number: string | null;
  invoice_date: string;
  amount_cents: number;
  supplier_name: string;
}

export async function findVenueDuplicates(
  supplierId: string,
  invoiceNumber: string,
): Promise<VenueDuplicate[]> {
  const trimmed = invoiceNumber.trim();
  if (trimmed === '') return [];

  const { data, error } = await supabase().rpc('find_duplicate_invoices_staff', {
    p_supplier_id: supplierId,
    p_invoice_number: trimmed,
    p_lookback_days: DUPE_LOOKBACK_DAYS,
  });

  if (error) throw error;
  return (data ?? []) as VenueDuplicate[];
}

/* -------------------------------------------------------------------------- */

export interface CreateVenueInvoiceInput {
  payload: InvoiceWrite & { id: string };
  /**
   * Carried, not looked up.
   *
   * HANDOFF §2 rule 4: everything a write needs must be in its variables and
   * never in a closure. This one is resumed by key from a cold start with no
   * component alive to hold a supplier list, and the optimistic row needs a
   * name to render. `supplier_id` alone would render "undefined".
   */
  supplierName: string;
}

interface CreateContext {
  previous?: StaffInvoice[];
}

/**
 * Registered at startup rather than declared in a hook, like every other write
 * — `lib/offline/keys.ts` has the full reasoning.
 */
export function registerVenueMutations(queryClient: QueryClient) {
  queryClient.setMutationDefaults(mk.venue.create, {
    /**
     * No `.select()`, and that is the whole point.
     *
     * `registerInvoiceMutations` ends its upsert with `.select().maybeSingle()`
     * so it can show the stamped reference in the toast. A venue account
     * cannot do that: reading the row back means reading `invoices`, which it
     * has no policy for. PostgREST answers a select it cannot satisfy with an
     * empty result, not an error — so this would look like it worked and the
     * invoice would appear to have failed.
     *
     * The consequence, accepted: the venue's toast cannot name the reference,
     * because the reference genuinely is not known yet. It says the amount and
     * the supplier instead, which is what the person just typed and can check.
     *
     * `ignoreDuplicates: true` on a client-generated id makes this
     * `on conflict do nothing`, so a write replayed off the queue is a no-op
     * rather than a second identical invoice (notes §1.5).
     */
    mutationFn: async ({ payload }: CreateVenueInvoiceInput): Promise<void> => {
      const { error } = await supabase()
        .from('invoices')
        .upsert(payload, { onConflict: 'id', ignoreDuplicates: true });

      if (error) throw error;
    },

    /*
     * Not re-run when a write resumes from disk — `onMutate` ran in the session
     * that made the write, and its context died with it. `onError` below is
     * written to cope with having none.
     */
    onMutate: async (input: CreateVenueInvoiceInput): Promise<CreateContext> => {
      // Non-negotiable (notes §1.4): without it an in-flight fetch can land
      // after this and the new row vanishes for a second before reappearing.
      await queryClient.cancelQueries({ queryKey: qk.venue.invoices });

      const previous = queryClient.getQueryData<StaffInvoice[]>(qk.venue.invoices);

      const optimistic: StaffInvoice = {
        id: input.payload.id,
        business_id: input.payload.business_id,
        supplier_id: input.payload.supplier_id,
        supplier_name: input.supplierName,
        invoice_number: input.payload.invoice_number,
        // Stamped by a database trigger, so it genuinely is not known yet.
        // An invented one would be a lie that changes under whoever read it.
        internal_ref: '',
        invoice_date: input.payload.invoice_date,
        due_date: input.payload.due_date,
        amount_cents: input.payload.amount_cents,
        created_at: nowTimestamp(),
      };

      queryClient.setQueryData<StaffInvoice[]>(qk.venue.invoices, (current) => [
        optimistic,
        ...(current ?? []),
      ]);

      return { previous };
    },

    onError: (
      _error: unknown,
      _input: CreateVenueInvoiceInput,
      context: CreateContext | undefined,
    ) => {
      if (context?.previous) {
        queryClient.setQueryData(qk.venue.invoices, context.previous);
      }
    },

    /*
     * Only the venue's own list. Not `qk.activity.recent`, which a venue
     * cannot read — `activity_log` still says `is_member()`, so invalidating
     * it here would schedule a refetch that comes back empty every time.
     */
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: qk.venue.invoices });
    },
  });
}

export function useCreateVenueInvoice() {
  return useMutation<void, Error, CreateVenueInvoiceInput, CreateContext>({
    mutationKey: mk.venue.create,
  });
}

/* -------------------------------------------------------------------------- */

export interface UpdateVenueInvoiceInput {
  id: string;
  /** Exactly the columns the form can change. Not a partial row. */
  payload: Omit<InvoiceWrite, 'id' | 'created_by'>;
  supplierName: string;
}

interface UpdateContext {
  previous?: StaffInvoice[];
}

/**
 * Correcting an invoice a venue entered minutes ago.
 *
 * ---------------------------------------------------------------------------
 * The window is the database's to enforce, and this file does not check it.
 *
 * `staff_update` in CATCH_UP_010 requires four things, and only one of them is
 * visible from here — the venue, whose entry it is, whether it has been paid,
 * and `created_at > now() - interval '5 minutes'`. A queued edit sent from a
 * dead spot twenty minutes later is refused by that policy, which is correct
 * and is the reason the check is not duplicated here: a client-side clock
 * deciding would mean a shop with a wrong phone clock editing last Tuesday.
 *
 * So an update that comes back refused is not a bug. `stillCorrectable` only
 * decides whether the button is offered.
 * ---------------------------------------------------------------------------
 *
 * No `.select()`, for the same reason `create` has none: reading the row back
 * means reading `invoices`, which a venue has no policy for, and PostgREST
 * answers a select it cannot satisfy with an empty result rather than an error.
 */
export function registerVenueUpdateMutations(queryClient: QueryClient) {
  queryClient.setMutationDefaults(mk.venue.update, {
    mutationFn: async ({ id, payload }: UpdateVenueInvoiceInput): Promise<void> => {
      const { error } = await supabase().from('invoices').update(payload).eq('id', id);
      if (error) throw error;
    },

    onMutate: async (input: UpdateVenueInvoiceInput): Promise<UpdateContext> => {
      await queryClient.cancelQueries({ queryKey: qk.venue.invoices });
      const previous = queryClient.getQueryData<StaffInvoice[]>(qk.venue.invoices);

      queryClient.setQueryData<StaffInvoice[]>(qk.venue.invoices, (current) =>
        (current ?? []).map((row) =>
          row.id === input.id
            ? {
                ...row,
                supplier_id: input.payload.supplier_id,
                supplier_name: input.supplierName,
                invoice_number: input.payload.invoice_number,
                invoice_date: input.payload.invoice_date,
                due_date: input.payload.due_date,
                amount_cents: input.payload.amount_cents,
                /*
                 * `created_at` is NOT touched, and that is the point of the
                 * whole feature. It is what the five minutes is measured
                 * from, so an optimistic row that refreshed it would show an
                 * Edit button that outlives the window — and the database
                 * pins the column on update anyway (`pin_invoice_facts`), so
                 * changing it here would also make the cache disagree with
                 * the server the moment it refetched.
                 */
              }
            : row,
        ),
      );

      return { previous };
    },

    onError: (
      _error: unknown,
      _input: UpdateVenueInvoiceInput,
      context: UpdateContext | undefined,
    ) => {
      if (context?.previous) {
        queryClient.setQueryData(qk.venue.invoices, context.previous);
      }
    },

    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: qk.venue.invoices });
    },
  });
}

export function useUpdateVenueInvoice() {
  return useMutation<void, Error, UpdateVenueInvoiceInput, UpdateContext>({
    mutationKey: mk.venue.update,
  });
}
