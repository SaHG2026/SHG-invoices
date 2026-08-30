'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { useMemo, useState } from 'react';
import { AppChrome } from '@/components/app/AppChrome';
import { useToast } from '@/components/ui/Toast';
import { useCurrentProfile } from '@/lib/queries/session';
import { useAllCustomers, useCreateCustomer } from '@/lib/queries/customers';
import { filterCustomers, orderCustomers } from '@/lib/derive/customer-match';

/**
 * Customers. ARCHITECTURE §17 — the first screen of the second ledger.
 *
 * Deli Delights sells as well as buys, and the client asked to be able to
 * track who it sells to without that touching what the group owes. So this
 * screen holds names and contacts and no money at all: there is no figure on
 * it to add up, which is why it cannot move the owed or pending totals. That
 * is a property of the data, not a rule somebody has to keep remembering.
 *
 * Said out loud on the screen too, once, because a ledger that quietly leaves
 * numbers out is worse than one that says which numbers it is leaving out.
 *
 * Deactivated customers stay visible, greyed, for the same reason deactivated
 * suppliers do: one deactivated by mistake would otherwise be unreachable and
 * unrecoverable, which is deleting arrived at politely.
 */
export function CustomersList() {
  const toast = useToast();
  const { data: profile } = useCurrentProfile();
  const { data: customers = [], isLoading, isError } = useAllCustomers();
  const createCustomer = useCreateCustomer();

  const [query, setQuery] = useState('');
  const [newName, setNewName] = useState('');

  const visible = useMemo(
    () => orderCustomers(filterCustomers(customers, query)),
    [customers, query],
  );

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (!profile || newName.trim() === '') return;
    const name = newName.trim();
    setNewName('');
    try {
      await createCustomer.mutateAsync({ name, actorId: profile.id });
      toast.show(`Added ${name}.`);
    } catch (error) {
      // Never lose what somebody typed.
      setNewName(name);
      toast.show(
        error instanceof Error ? error.message : 'Couldn’t add that customer.',
        'problem',
      );
    }
  }

  return (
    <AppChrome back={{ href: '/' as Route, label: 'Invoices' }}>
      <h1 className="text-h1 mb-1 text-ink">Customers</h1>
      <p className="mb-4 text-sm text-muted">
        Who Deli Delights sells to. Nothing here counts toward what the group owes — this is the
        other direction.
      </p>

      <form onSubmit={add} className="mb-3 flex gap-2">
        <input
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          placeholder="Add a customer"
          aria-label="New customer name"
          autoCapitalize="words"
          className="touch min-w-0 flex-1 rounded-sm border border-hairline bg-card px-3 text-base text-ink outline-none focus:border-action"
        />
        <button
          type="submit"
          disabled={newName.trim() === '' || createCustomer.isPending}
          className="touch shrink-0 rounded-full bg-action px-4 text-sm text-action-text disabled:opacity-40"
        >
          Add
        </button>
      </form>

      <div className="mb-3 flex items-center rounded-sm border border-hairline bg-card">
        <span aria-hidden className="pl-3 text-sm text-muted">
          &#9906;
        </span>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find a customer"
          aria-label="Search customers"
          className="touch min-w-0 flex-1 bg-transparent px-2 text-base text-ink outline-none"
        />
      </div>

      {isError ? (
        /*
          An empty list and a missing table look identical from here, and only
          one of them is "no customers yet". Saying the wrong one is the same
          class of dishonesty as a total that disagrees with its list: it is
          not wrong on screen, it is wrong about what happened.
        */
        <p className="rounded-sm border border-edge bg-card p-4 text-sm text-muted">
          Couldn’t load customers. If this is the first time you’ve opened this screen, the
          customers table hasn’t been created yet — run{' '}
          <span className="font-mono text-xs">CATCH_UP_004.sql</span> in Supabase.
        </p>
      ) : isLoading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : visible.length === 0 ? (
        <p className="rounded-sm border border-edge bg-card p-4 text-sm text-muted">
          {query
            ? `No customer matches “${query}”.`
            : 'No customers yet. Add the first one above.'}
        </p>
      ) : (
        <ul className="overflow-hidden rounded-sm border border-edge bg-card">
          {visible.map((customer) => (
            <li key={customer.id} className="border-b border-hairline last:border-b-0">
              <Link
                href={`/customers/${customer.id}` as Route}
                className={`flex h-row items-center gap-3 px-3 active:bg-pressed ${
                  customer.active ? '' : 'opacity-55'
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-ink">{customer.name}</span>
                  <span className="block truncate text-xs text-muted">
                    {customer.contact_name || customer.contact_phone || 'No contact set'}
                    {customer.active ? '' : ' · deactivated'}
                  </span>
                </span>
                <span aria-hidden className="shrink-0 text-xs text-muted">
                  &rsaquo;
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </AppChrome>
  );
}
