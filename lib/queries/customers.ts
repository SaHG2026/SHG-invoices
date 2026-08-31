'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { mk } from '@/lib/offline/keys';
import { supabase } from '@/lib/supabase/browser';
import { qk } from './keys';
import type { Customer } from '@/lib/types';

/**
 * Deli Delights' customers. ARCHITECTURE §17.
 *
 * The deliberate shape of this file is what it does NOT do. There is no total,
 * no outstanding, no count of anything owing. A customer record is who they
 * are and how to reach them, full stop — so there is no code path by which a
 * customer can reach the owed or pending figures, which are derived only from
 * `useUnpaidInvoices` (architecture §2). That is a structural guarantee, not a
 * convention somebody has to remember.
 *
 * Money in arrives with `sales_invoices` and `receipts` in their own phase,
 * against their own tables and their own totals.
 */

const LONG = 10 * 60_000;

const COLUMNS = 'id, name, contact_name, contact_phone, contact_email, notes, active';

/** Active customers only — what a picker would offer. */
export function useCustomers() {
  return useQuery({
    queryKey: qk.customers.all,
    queryFn: async (): Promise<Customer[]> => {
      const { data, error } = await supabase()
        .from('customers')
        .select(COLUMNS)
        .eq('active', true)
        .order('name');

      if (error) throw error;
      return (data ?? []) as Customer[];
    },
    staleTime: LONG,
  });
}

/**
 * Every customer, including deactivated ones.
 *
 * Same reasoning as `useAllSuppliers`: hidden and deactivated is unreachable
 * and unrecoverable, which is deleting arrived at politely.
 */
export function useAllCustomers() {
  return useQuery({
    queryKey: qk.customers.withInactive,
    queryFn: async (): Promise<Customer[]> => {
      const { data, error } = await supabase().from('customers').select(COLUMNS).order('name');

      if (error) throw error;
      return (data ?? []) as Customer[];
    },
    staleTime: 60_000,
  });
}

export interface CreateCustomerInput {
  /** Decided here rather than by the database, for the reason in `optimisticSupplier`. */
  id: string;
  name: string;
  actorId: string;
}

/** A customer as it exists before the database has seen it. */
export function optimisticCustomer(id: string, name: string): Customer {
  return {
    id,
    name: name.trim(),
    contact_name: null,
    contact_phone: null,
    contact_email: null,
    notes: null,
    active: true,
  };
}

export function registerCustomerMutations(queryClient: QueryClient) {
  const insertInto = (customer: Customer) => (current: Customer[] | undefined) =>
    [...(current ?? []).filter((existing) => existing.id !== customer.id), customer].sort((a, b) =>
      a.name.localeCompare(b.name),
    );

  queryClient.setMutationDefaults(mk.customers.create, {
    mutationFn: async ({ id, name, actorId }: CreateCustomerInput): Promise<void> => {
      const { error } = await supabase()
        .from('customers')
        .upsert(
          { id, name: name.trim(), created_by: actorId },
          { onConflict: 'id', ignoreDuplicates: true },
        );

      if (error) {
        // customers_name_ci is a unique index on active customers.
        if (error.code === '23505') {
          throw new Error(`There is already a customer called ${name.trim()}.`);
        }
        throw error;
      }
    },
    onMutate: ({ id, name }: CreateCustomerInput) => {
      const optimistic = optimisticCustomer(id, name);
      queryClient.setQueryData<Customer[]>(qk.customers.all, insertInto(optimistic));
      queryClient.setQueryData<Customer[]>(qk.customers.withInactive, insertInto(optimistic));
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: qk.customers.all });
      queryClient.invalidateQueries({ queryKey: qk.customers.withInactive });
    },
  });

  queryClient.setMutationDefaults(mk.customers.update, {
    mutationFn: async ({
      id,
      ...changes
    }: Partial<Customer> & { id: string }): Promise<Customer> => {
      const { data, error } = await supabase()
        .from('customers')
        .update(changes)
        .eq('id', id)
        .select(COLUMNS)
        .single();

      if (error) {
        if (error.code === '23505') {
          throw new Error('There is already an active customer with that name.');
        }
        throw error;
      }
      return data as Customer;
    },
    onSuccess: (customer: Customer) => {
      const replace = (current: Customer[] | undefined) =>
        (current ?? []).map((existing) => (existing.id === customer.id ? customer : existing));

      queryClient.setQueryData<Customer[]>(qk.customers.all, replace);
      queryClient.setQueryData<Customer[]>(qk.customers.withInactive, replace);
      queryClient.invalidateQueries({ queryKey: qk.customers.all });
      queryClient.invalidateQueries({ queryKey: qk.customers.withInactive });
    },
  });
}

export function useCreateCustomer() {
  return useMutation<void, Error, CreateCustomerInput>({ mutationKey: mk.customers.create });
}

export function useUpdateCustomer() {
  return useMutation<Customer, Error, Partial<Customer> & { id: string }>({
    mutationKey: mk.customers.update,
  });
}
