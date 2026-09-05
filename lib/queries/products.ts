'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { mk } from '@/lib/offline/keys';
import { supabase } from '@/lib/supabase/browser';
import { qk } from './keys';
import type { Product } from '@/lib/types';

/**
 * What Deli sells, and what it costs.
 *
 * The shape of `lib/queries/reference.ts` one table over, and deliberately so
 * — a price list and a supplier list are the same kind of thing: small, read
 * constantly, changed rarely, and needed the instant a compose screen opens.
 *
 * The one difference worth naming: a product's price is a **default**, not a
 * fact about any invoice. Every line copies the price at the moment it is
 * issued (CATCH_UP_015 §2), so changing one here changes what the next invoice
 * suggests and nothing that has already been printed.
 */

const COLUMNS = 'id, business_id, name, unit, unit_price_cents, active';
const LONG = 10 * 60_000;

/** The price list, for composing. Active only. */
export function useProducts(businessId: string | null) {
  return useQuery({
    queryKey: qk.products.forBusiness(businessId ?? ''),
    queryFn: async (): Promise<Product[]> => {
      const { data, error } = await supabase()
        .from('products')
        .select(COLUMNS)
        .eq('business_id', businessId!)
        .eq('active', true)
        .order('name');

      if (error) throw error;
      return (data ?? []) as Product[];
    },
    enabled: businessId !== null && businessId !== '',
    staleTime: LONG,
  });
}

/**
 * Every product, removed ones included.
 *
 * The admin list needs both, for the reason the supplier list does: one
 * removed by mistake would otherwise be unreachable from anywhere in the app
 * and effectively unrecoverable, which is the same failure as deleting,
 * arrived at politely.
 */
export function useAllProducts(businessId: string | null) {
  return useQuery({
    queryKey: qk.products.withInactive(businessId ?? ''),
    queryFn: async (): Promise<Product[]> => {
      const { data, error } = await supabase()
        .from('products')
        .select(COLUMNS)
        .eq('business_id', businessId!)
        .order('name');

      if (error) throw error;
      return (data ?? []) as Product[];
    },
    enabled: businessId !== null && businessId !== '',
    staleTime: 60_000,
  });
}

export interface CreateProductInput {
  /** Generated on the client, so a replayed write is a no-op — notes §1.5. */
  id: string;
  business_id: string;
  name: string;
  unit: string | null;
  unit_price_cents: number;
  created_by: string;
}

export function registerProductMutations(queryClient: QueryClient) {
  queryClient.setMutationDefaults(mk.products.create, {
    mutationFn: async (input: CreateProductInput): Promise<void> => {
      const { error } = await supabase()
        .from('products')
        .upsert(input, { onConflict: 'id', ignoreDuplicates: true });

      if (error) {
        // `products_name_ci` is unique on active names per business. Reached
        // when two people add the same thing, or one person adds it offline
        // and again online before the queue drains.
        if (error.code === '23505') {
          throw new Error(`There is already a product called ${input.name.trim()}.`);
        }
        throw error;
      }
    },
    onSettled: (_d: unknown, _e: unknown, input: CreateProductInput) => {
      queryClient.invalidateQueries({ queryKey: qk.products.all });
      void input;
    },
  });

  queryClient.setMutationDefaults(mk.products.update, {
    mutationFn: async ({
      id,
      ...changes
    }: Partial<Product> & { id: string }): Promise<Product> => {
      const { data, error } = await supabase()
        .from('products')
        .update(changes)
        .eq('id', id)
        .select(COLUMNS)
        .single();

      if (error) {
        if (error.code === '23505') {
          throw new Error('There is already an active product with that name.');
        }
        throw error;
      }
      return data as Product;
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: qk.products.all });
    },
  });
}

export function useCreateProduct() {
  return useMutation<void, Error, CreateProductInput>({ mutationKey: mk.products.create });
}

export function useUpdateProduct() {
  return useMutation<Product, Error, Partial<Product> & { id: string }>({
    mutationKey: mk.products.update,
  });
}
