'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { useMemo, useState } from 'react';
import { AppChrome } from '@/components/app/AppChrome';
import { useToast } from '@/components/ui/Toast';
import { useCurrentProfile } from '@/lib/queries/session';
import {
  optimisticCustomer,
  useAllCustomers,
  useCreateCustomer,
} from '@/lib/queries/customers';
import { submitWrite, writeFailureMessage } from '@/lib/offline/submit';
import { filterCustomers, orderCustomers } from '@/lib/derive/customer-match';
import { useOutstandingSales } from '@/lib/queries/sales';
import { receivableByCustomer } from '@/lib/derive/receivables';
import { useSydneyToday } from '@/hooks/use-sydney-today';
import { formatCents } from '@/lib/money';

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
  const { data: sales = [] } = useOutstandingSales();
  const createCustomer = useCreateCustomer();
  const today = useSydneyToday();

  /* What each customer still owes, from the one outstanding-sales array. */
  const owed = useMemo(
    () => (today ? receivableByCustomer(sales, today) : new Map()),
    [sales, today],
  );
  const totalOwed = useMemo(
    () => [...owed.values()].reduce((sum, entry) => sum + entry.total_cents, 0),
    [owed],
  );

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
    const outcome = await submitWrite(createCustomer, {
      id: optimisticCustomer(crypto.randomUUID(), name).id,
      name,
      actorId: profile.id,
    });

    if (outcome.kind === 'failed') {
      // Never lose what somebody typed.
      setNewName(name);
      toast.show(writeFailureMessage(outcome.error, 'Couldn’t add that customer.'), 'problem');
      return;
    }

    toast.show(
      outcome.kind === 'queued' ? `Added ${name} — will send when you’re back online.` : `Added ${name}.`,
    );
  }

  return (
    <AppChrome back={{ href: '/' as Route, label: 'Invoices' }}>
      <h1 className="text-h1 mb-4 text-ink">Customers</h1>

      <section className="mb-4 rounded-sm border border-edge bg-card p-4">
        <p className="text-xs uppercase tracking-widest text-muted">Owed to us</p>
        <p className="money mt-1 text-h1 text-ink" style={{ textAlign: 'left' }}>
          {formatCents(totalOwed)}
        </p>
        <p className="mt-0.5 text-xs text-muted">
          {owed.size === 0
            ? 'Nothing outstanding.'
            : `across ${owed.size} customer${owed.size === 1 ? '' : 's'}`}
        </p>
      </section>

      {/*
        A named panel rather than a bare text field with an Add button.

        The field was there from the start and the client twice reported there
        was no way to add a customer — which means it was not there, in the only
        sense that counts. A placeholder is not a label: it disappears the
        moment you type, and on a screen you have never seen before an empty
        box reads as search, especially with a real search box directly under
        it.
      */}
      <section className="mb-4 rounded-sm border border-edge bg-card p-4">
        <h2 className="mb-2 text-xs uppercase tracking-widest text-muted">Add a customer</h2>
        <form onSubmit={add} className="flex gap-2">
          <input
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            placeholder="Their business name"
            aria-label="New customer name"
            autoCapitalize="words"
            className="touch min-w-0 flex-1 rounded-sm border border-hairline bg-card px-3 text-base text-ink outline-none focus:border-action"
          />
          <button
            type="submit"
            disabled={newName.trim() === '' || createCustomer.isPending}
            className="touch shrink-0 rounded-full bg-action px-5 text-sm font-medium text-action-text disabled:opacity-40"
          >
            {createCustomer.isPending ? 'Adding…' : '+ Add'}
          </button>
        </form>
      </section>

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
          Couldn’t load customers. Run{' '}
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
                {owed.get(customer.id) ? (
                  <span className="shrink-0 text-right">
                    <span className="money block text-sm text-ink">
                      {formatCents(owed.get(customer.id)!.total_cents)}
                    </span>
                    {owed.get(customer.id)!.overdue_count > 0 ? (
                      <span
                        className="block text-[11px]"
                        style={{ color: 'var(--spine-overdue)' }}
                      >
                        {owed.get(customer.id)!.overdue_count} overdue
                      </span>
                    ) : null}
                  </span>
                ) : null}
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
