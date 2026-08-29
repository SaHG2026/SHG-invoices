'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
export function useCreateSupplier() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ name, actorId }: { name: string; actorId: string }): Promise<Supplier> => {
      const { data, error } = await supabase()
        .from('suppliers')
        .insert({ name: name.trim(), created_by: actorId })
        .select('id, name, default_terms_days, contact_name, contact_phone, notes, active')
        .single();

      if (error) {
        // suppliers_name_ci is a unique index on active suppliers.
        if (error.code === '23505') {
          throw new Error(`There is already a supplier called ${name.trim()}.`);
        }
        throw error;
      }
      return data as Supplier;
    },
    onSuccess: (supplier) => {
      // Put it in the cache immediately so the sheet can select it without
      // waiting for a refetch — the person is mid-entry.
      queryClient.setQueryData<Supplier[]>(qk.suppliers.all, (current) =>
        [...(current ?? []), supplier].sort((a, b) => a.name.localeCompare(b.name)),
      );
      queryClient.invalidateQueries({ queryKey: qk.suppliers.all });
    },
  });
}
