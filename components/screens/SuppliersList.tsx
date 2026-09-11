'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { useMemo, useRef, useState } from 'react';
import { AppChrome } from '@/components/app/AppChrome';
import { useToast } from '@/components/ui/Toast';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { findNearMatches, nearMatchWording } from '@/lib/derive/near-match';
import { useCurrentProfile } from '@/lib/queries/session';
import { optimisticSupplier, useCreateSupplier } from '@/lib/queries/reference';
import { submitWrite, writeFailureMessage } from '@/lib/offline/submit';
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

  /*
   * So the `+` can reach the add field. The panel is at the top of the screen
   * and the list under it is long; the button is under the thumb. Pointing one
   * at the other is a shortcut to the single place a supplier is added, which
   * is not the same as a second way of adding one.
   */
  const addFieldRef = useRef<HTMLInputElement>(null);

  /*
   * `focus()` and nothing else — no `scrollIntoView` beside it.
   *
   * Focusing already scrolls the field into view, and on a phone it also opens
   * the keyboard, which resizes the viewport underneath. A smooth scroll added
   * on top would be a second movement racing the first, which is precisely the
   * bug the supplier type-ahead spent two rounds on ("springs with so much
   * force and then bounces a couple times"). One movement.
   */
  function focusAddField() {
    addFieldRef.current?.focus();
  }

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

  /*
   * "Is this one you already have?" — asked here and nowhere else on this
   * path, because nothing else on it was looking. `lib/derive/near-match.ts`
   * has the reasoning, including why the add-invoice sheet does not need it.
   *
   * Deactivated suppliers are included in what is searched: "you deactivated
   * this one last month" is exactly what somebody needs to hear before making
   * a second copy of it, and `suppliers` here is already the full list.
   */
  const [pendingName, setPendingName] = useState<string | null>(null);
  const nearMatches = useMemo(
    () => (pendingName === null ? [] : findNearMatches(suppliers, pendingName)),
    [suppliers, pendingName],
  );

  function attempt(event: React.FormEvent) {
    event.preventDefault();
    const name = newName.trim();
    if (!profile || name === '') return;

    if (findNearMatches(suppliers, name).length > 0) {
      setPendingName(name);
      return;
    }
    void add(name);
  }

  async function add(name: string) {
    if (!profile) return;
    setNewName('');
    const outcome = await submitWrite(createSupplier, {
      id: optimisticSupplier(crypto.randomUUID(), name).id,
      name,
      actorId: profile.id,
    });

    if (outcome.kind === 'failed') {
      setNewName(name);
      toast.show(writeFailureMessage(outcome.error, 'Couldn’t add that supplier.'), 'problem');
      return;
    }

    toast.show(
      outcome.kind === 'queued' ? `Added ${name} — will send when you’re back online.` : `Added ${name}.`,
    );
  }

  return (
    <AppChrome
      back={{ href: '/' as Route, label: 'Invoices' }}
      addHere={{ label: 'New supplier', onPress: focusAddField }}
    >
      <h1 className="text-h1 mb-3 text-ink">Suppliers</h1>

      {/*
        A named panel rather than a bare text field with an Add button — the
        same fix Customers got in §24.7, which this screen never received.

        It was an unlabelled input whose only wording was placeholder text,
        sitting directly above a real search box. §24.7 wrote down exactly why
        that fails: "a placeholder is not a label: it disappears the moment you
        type, and on a screen you have never seen before an empty box reads as
        search, especially with a real search box directly under it."

        Every word of that was true here too, and it produced the same report
        — that there was no way to add a supplier from the suppliers screen.
        Twice now, on two screens, which makes it a pattern and not a quibble.
      */}
      <section className="mb-3 rounded-sm border border-edge bg-card p-4">
        <h2 className="mb-2 text-xs uppercase tracking-widest text-muted">Add a supplier</h2>
        <form onSubmit={attempt} className="flex gap-2">
          <input
            ref={addFieldRef}
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            placeholder="Their business name"
            aria-label="New supplier name"
            autoCapitalize="words"
            className="touch min-w-0 flex-1 rounded-sm border border-hairline bg-card px-3 text-base text-ink outline-none focus:border-action"
          />
          <button
            type="submit"
            disabled={newName.trim() === '' || createSupplier.isPending}
            className="touch shrink-0 rounded-full bg-action px-5 text-sm font-medium text-action-text disabled:opacity-40"
          >
            {createSupplier.isPending ? 'Adding…' : '+ Add'}
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

      {/*
        Spec §6: a warning, never a block. The way through is the first button,
        and it is named for what it does rather than "OK".

        The existing name is a link, so the answer to "is that the same one?"
        is one tap away instead of a memory test — and tapping it abandons the
        add, which is the right outcome when it turns out to be the same one.
      */}
      <ConfirmDialog
        open={pendingName !== null && nearMatches.length > 0}
        title="Already have this one?"
        points={nearMatches.map(({ entry, reason }) => (
          <span key={entry.id} className="block">
            <Link
              href={`/suppliers/${entry.id}` as Route}
              onClick={() => setPendingName(null)}
              className="text-action underline"
            >
              {entry.name}
            </Link>
            <span className="mt-0.5 block text-sm text-muted">
              {nearMatchWording(reason)}
              {entry.active ? '' : ' · deactivated'}
            </span>
          </span>
        ))}
        question={pendingName ? `Add “${pendingName}” as well?` : undefined}
        confirmLabel="Add it anyway"
        cancelLabel="Go back"
        onConfirm={() => {
          const name = pendingName;
          setPendingName(null);
          if (name) void add(name);
        }}
        onCancel={() => setPendingName(null)}
      />
    </AppChrome>
  );
}
