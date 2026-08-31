'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { mk } from '@/lib/offline/keys';
import { supabase } from '@/lib/supabase/browser';
import { qk } from './keys';
import type { Business, Supplier } from '@/lib/types';

/**
 * Businesses and suppliers — the two lists the add-invoice sheet needs before
 * anyone can type anything.
 *
 * Both are small, both change rarely, and both are needed the instant the
 * sheet opens. So they are fetched once and held for the session: waiting on a
 * round trip before the supplier field responds would spend the fifteen-second
 * budget on nothing.
 */

const LONG = 10 * 60_000;

export function useBusinesses() {
  return useQuery({
    queryKey: qk.businesses.all,
    queryFn: async (): Promise<Business[]> => {
      const { data, error } = await supabase()
        .from('businesses')
        .select('id, name, code, sort_order, active')
        .eq('active', true)
        .order('sort_order');

      if (error) throw error;
      return (data ?? []) as Business[];
    },
    staleTime: LONG,
  });
}

export function useSuppliers() {
  return useQuery({
    queryKey: qk.suppliers.all,
    queryFn: async (): Promise<Supplier[]> => {
      const { data, error } = await supabase()
        .from('suppliers')
        .select('id, name, default_terms_days, contact_name, contact_phone, notes, active')
        .eq('active', true)
        .order('name');

      if (error) throw error;
      return (data ?? []) as Supplier[];
    },
    staleTime: LONG,
  });
}

/**
 * Create a supplier from inside the sheet. Spec §7.3: `+ Add "bid" as a new
 * supplier`, without leaving the flow.
 *
 * Terms are left null deliberately. Asking for payment terms mid-entry would
 * put a decision in the way of the fifteen seconds; they are filled in later
 * from the supplier screen, where there is time to look them up.
 */
export interface CreateSupplierInput {
  /**
   * Generated on the client, and it is what makes adding a supplier work at a
   * dock with no signal.
   *
   * The sheet used to wait for the database to hand back an id before it could
   * put the new supplier on the invoice. Offline that wait never ends — the
   * write is paused, not refused — so the flow stopped dead at the one
   * moment this app exists to make fast. With the id decided here the sheet has
   * everything it needs immediately, and both writes queue in the order they
   * were made: the supplier first, then the invoice that references it.
   */
  id: string;
  name: string;
  actorId: string;
}

export function registerSupplierMutations(queryClient: QueryClient) {
  queryClient.setMutationDefaults(mk.suppliers.create, {
    mutationFn: async ({ id, name, actorId }: CreateSupplierInput): Promise<void> => {
      const { error } = await supabase()
        .from('suppliers')
        .upsert(
          { id, name: name.trim(), created_by: actorId },
          { onConflict: 'id', ignoreDuplicates: true },
        );

      if (error) {
        // suppliers_name_ci is a unique index on active suppliers. Reached when
        // two people add the same supplier, or when one person adds it offline
        // and again online before the queue drains.
        if (error.code === '23505') {
          throw new Error(`There is already a supplier called ${name.trim()}.`);
        }
        throw error;
      }
    },

    /*
     * Optimistic, so the sheet can select the supplier it has just made without
     * waiting for anything. The row comes from `optimisticSupplier` below,
     * which is the single definition of what a brand-new supplier looks like —
     * so the cache and the screen cannot disagree about it.
     */
    onMutate: ({ id, name }: CreateSupplierInput) => {
      queryClient.setQueryData<Supplier[]>(qk.suppliers.all, (current) =>
        [...(current ?? []), optimisticSupplier(id, name)].sort((a, b) =>
          a.name.localeCompare(b.name),
        ),
      );
    },

    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: qk.suppliers.all });
    },
  });
}

/**
 * A supplier as it exists the instant it is created, before the database has
 * seen it.
 *
 * Terms are null deliberately. Asking for payment terms mid-entry would put a
 * decision in the way of the fifteen seconds; they are filled in later from the
 * supplier screen, where there is time to look them up.
 */
export function optimisticSupplier(id: string, name: string): Supplier {
  return {
    id,
    name: name.trim(),
    default_terms_days: null,
    contact_name: null,
    contact_phone: null,
    notes: null,
    active: true,
  };
}

export function useCreateSupplier() {
  return useMutation<void, Error, CreateSupplierInput>({ mutationKey: mk.suppliers.create });
}
