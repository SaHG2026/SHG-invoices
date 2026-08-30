'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { useMemo, useState } from 'react';
import { AppChrome } from '@/components/app/AppChrome';
import { useToast } from '@/components/ui/Toast';
import { useCurrentProfile } from '@/lib/queries/session';
import { useCreateSupplier } from '@/lib/queries/reference';
import { useAllSuppliers } from '@/lib/queries/history';
import { useUnpaidInvoices } from '@/lib/queries/invoices';
import { rankSuppliers } from '@/lib/derive/supplier-match';
import { formatCents } from '@/lib/money';
import { DEFAULT_TERMS_DAYS } from '@/lib/constants';

/**
 * Suppliers. Spec §7.8: list, add, edit, deactivate.
 *
 * Deactivated suppliers are shown, greyed, rather than hidden. One deactivated
 * by mistake would otherwise be unreachable from anywhere in the app and
 * effectively unrecoverable — which is the same failure as deleting, arrived
 * at politely.
 *
 * Suppliers with no payment terms are called out at the top. They are the ones
 * created from the add-invoice sheet, where asking would have cost the fifteen
 * seconds (ARCHITECTURE §18), and setting them here is what makes every future
 * invoice for that supplier date itself correctly.
 */
export function SuppliersList() {
  const toast = useToast();
  const { data: profile } = useCurrentProfile();
  const { data: suppliers = [], isLoading } = useAllSuppliers();
  const { data: unpaid = [] } = useUnpaidInvoices();
  const createSupplier = useCreateSupplier();

  const [query, setQuery] = useState('');
  const [newName, setNewName] = useState('');

  /** Outstanding per supplier, from the one unpaid array already in memory. */
  const owing = useMemo(() => {
    const totals = new Map<string, number>();
    for (const invoice of unpaid) {
      totals.set(
        invoice.supplier_id,
        (totals.get(invoice.supplier_id) ?? 0) + invoice.amount_cents,
      );
    }
    return totals;
  }, [unpaid]);

  const visible = useMemo(() => {
    if (query.trim()) {
      return rankSuppliers(suppliers, query, { limit: suppliers.length });
    }
    const active = suppliers.filter((supplier) => supplier.active);
    const inactive = suppliers.filter((supplier) => !supplier.active);
    const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
    // Inactive always last: they are history, not choices.
    return [...active.sort(byName), ...inactive.sort(byName)];
  }, [suppliers, query]);

  const missingTerms = suppliers.filter(
    (supplier) => supplier.active && supplier.default_terms_days === null,
  ).length;

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (!profile || newName.trim() === '') return;
    const name = newName.trim();
    setNewName('');
    try {
      await createSupplier.mutateAsync({ name, actorId: profile.id });
      toast.show(`Added ${name}.`);
    } catch (error) {
      setNewName(name);
      toast.show(
        error instanceof Error ? error.message : 'Couldn’t add that supplier.',
        'problem',
      );
    }
  }

  return (
    <AppChrome back={{ href: '/' as Route, label: 'Invoices' }}>
      <h1 className="text-h1 mb-3 text-ink">Suppliers</h1>

      <form onSubmit={add} className="mb-3 flex gap-2">
        <input
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          placeholder="Add a supplier"
          aria-label="New supplier name"
          autoCapitalize="words"
          className="touch min-w-0 flex-1 rounded-sm border border-hairline bg-card px-3 text-base text-ink outline-none focus:border-action"
        />
        <button
          type="submit"
          disabled={newName.trim() === '' || createSupplier.isPending}
          className="touch shrink-0 rounded-sm bg-action px-4 text-sm text-action-text disabled:opacity-40"
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
          placeholder="Find a supplier"
          aria-label="Search suppliers"
          className="touch min-w-0 flex-1 bg-transparent px-2 text-base text-ink outline-none"
        />
      </div>

      {missingTerms > 0 && !query ? (
        <p
          className="mb-3 rounded-sm px-3 py-2 text-sm"
          style={{ backgroundColor: 'var(--spine-today-bg)', color: 'var(--spine-today)' }}
        >
          {missingTerms} supplier{missingTerms === 1 ? ' has' : 's have'} no payment terms set, so
          their invoices default to {DEFAULT_TERMS_DAYS} days. Setting them makes every future due
          date right on its own.
        </p>
      ) : null}

      {isLoading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : visible.length === 0 ? (
        <p className="rounded-sm border border-edge bg-card p-4 text-sm text-muted">
          {query
            ? `No supplier matches “${query}”.`
            : 'No suppliers yet. Add the first one above.'}
        </p>
      ) : (
        <ul className="overflow-hidden rounded-sm border border-edge bg-card">
          {visible.map((supplier) => {
            const outstanding = owing.get(supplier.id) ?? 0;
            return (
              <li key={supplier.id} className="border-b border-hairline last:border-b-0">
                <Link
                  href={`/suppliers/${supplier.id}` as Route}
                  className={`flex h-row items-center gap-3 px-3 active:bg-pressed ${
                    supplier.active ? '' : 'opacity-55'
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-ink">{supplier.name}</span>
                    <span className="block truncate text-xs text-muted">
                      {supplier.default_terms_days !== null
                        ? `${supplier.default_terms_days} day terms`
                        : 'No terms set'}
                      {supplier.active ? '' : ' · deactivated'}
                    </span>
                  </span>
                  {outstanding > 0 ? (
                    <span className="money mr-2 shrink-0 text-sm text-ink">
                      {formatCents(outstanding)}
                    </span>
                  ) : null}
                  <span aria-hidden className="shrink-0 text-xs text-muted">
                    &rsaquo;
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </AppChrome>
  );
}
