'use client';

import { useMemo, useState } from 'react';
import { useUnpaidInvoices } from '@/lib/queries/invoices';
import { useBusinesses } from '@/lib/queries/reference';
import { useProfiles } from '@/lib/queries/session';
import { AppChrome, useSydneyToday } from '@/components/app/AppChrome';
import { InvoiceRow } from '@/components/invoice/InvoiceRow';
import { MarkPaidSheet } from '@/components/invoice/MarkPaidSheet';
import type { InvoiceRow as Invoice } from '@/lib/types';
import { formatCents } from '@/lib/money';
import { filterInvoices, SORT_OPTIONS, sortInvoices, summarise, type SortKey } from '@/lib/derive/select';
import { filterByScope, scopeHref, scopeLabel, type Scope } from '@/lib/scope';

/**
 * The full pending list. Spec §7.4.
 *
 * "Sticky footer shows the total of whatever is currently filtered. That
 * number changing as you filter is the whole point of the screen."
 *
 * So the total and the list are computed from the same array, one after the
 * other, in this component. Notes §3 calls a total that silently shows
 * everything while the list shows a subset "a trust-destroying bug that looks
 * like a display glitch" — it cannot happen here, because there is nowhere
 * else for either number to come from.
 */
export function PendingList({ scope }: { scope: Scope }) {
  const { data: invoices = [], isLoading } = useUnpaidInvoices();
  const { data: businesses = [] } = useBusinesses();
  const { data: people = [] } = useProfiles();
  const today = useSydneyToday();

  const [sort, setSort] = useState<SortKey>('due');
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [paying, setPaying] = useState<Invoice[]>([]);

  /*
   * One chain: scope, then filters, then sort. The footer total is computed
   * from `visible` — the very array the list maps over — so the two cannot
   * describe different sets of invoices.
   */
  const visible = useMemo(() => {
    if (!today) return [];
    const scoped = filterByScope(invoices, scope, businesses);
    const filtered = filterInvoices(scoped, { supplierId, overdueOnly, today });
    return sortInvoices(filtered, sort);
  }, [invoices, scope, businesses, supplierId, overdueOnly, sort, today]);

  const summary = useMemo(() => summarise(visible), [visible]);

  /** Suppliers present in this scope, so the filter never offers an empty result. */
  const suppliers = useMemo(() => {
    const scoped = filterByScope(invoices, scope, businesses);
    const seen = new Map<string, string>();
    for (const row of scoped) seen.set(row.supplier_id, row.supplier.name);
    return [...seen.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [invoices, scope, businesses]);

  return (
    <AppChrome back={{ href: scopeHref(scope), label: scopeLabel(scope, businesses) }}>
      <h1 className="text-h1 mb-4 text-ink">Pending</h1>

      {/* Sort. A row of pills, not a dropdown buried in a menu — spec §7.4. */}
      <div className="mb-2 flex flex-wrap gap-2" role="group" aria-label="Sort by">
        {SORT_OPTIONS.map((option) => (
          <button
            key={option.key}
            type="button"
            onClick={() => setSort(option.key)}
            aria-pressed={sort === option.key}
            className={`touch rounded-sm border px-3 text-sm ${
              sort === option.key
                ? 'border-action bg-action text-action-text'
                : 'border-hairline bg-card text-ink'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setOverdueOnly((on) => !on)}
          aria-pressed={overdueOnly}
          className="touch rounded-sm border px-3 text-sm"
          style={
            overdueOnly
              ? {
                  borderColor: 'var(--spine-overdue)',
                  backgroundColor: 'var(--spine-overdue-bg)',
                  color: 'var(--spine-overdue)',
                }
              : undefined
          }
        >
          Overdue only
        </button>

        {suppliers.length > 1 ? (
          <label className="touch flex items-center rounded-sm border border-hairline bg-card px-2 text-sm text-ink">
            <span className="sr-only">Filter by supplier</span>
            <select
              value={supplierId ?? ''}
              onChange={(event) => setSupplierId(event.target.value || null)}
              className="max-w-[10rem] bg-transparent text-sm text-ink outline-none"
            >
              <option value="">All suppliers</option>
              {suppliers.map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      {isLoading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : visible.length === 0 ? (
        <p className="rounded-sm border border-edge bg-card p-4 text-sm text-muted">
          {overdueOnly || supplierId
            ? 'Nothing matches those filters. Clear one to see more.'
            : 'No invoices outstanding here. Add one with the + button.'}
        </p>
      ) : (
        <ul className="overflow-hidden rounded-sm border border-edge bg-card">
          {visible.map((invoice) => (
            <InvoiceRow
              key={invoice.id}
              invoice={invoice}
              today={today!}
              people={people}
              expanded={expandedId === invoice.id}
              onToggle={() =>
                setExpandedId((current) => (current === invoice.id ? null : invoice.id))
              }
              onMarkPaid={() => setPaying([invoice])}
            />
          ))}
        </ul>
      )}

      {/*
        The sticky total. Spec §7.4: watching this change as you filter is the
        whole point of the screen, so it stays on screen while you scroll.
      */}
      <div
        className="fixed inset-x-0 bottom-0 z-30 border-t border-edge bg-card"
        style={{ paddingBottom: `env(safe-area-inset-bottom, 0px)` }}
      >
        <div className="mx-auto flex max-w-[560px] items-center gap-3 px-4 py-3 pr-20">
          <span className="min-w-0 flex-1 text-xs uppercase tracking-widest text-muted">
            {summary.invoice_count} invoice{summary.invoice_count === 1 ? '' : 's'}
            {overdueOnly || supplierId ? ' · filtered' : ''}
          </span>
          <span className="money shrink-0 text-h2 text-ink">
            {formatCents(summary.total_cents)}
          </span>
        </div>
      </div>
      <MarkPaidSheet
        open={paying.length > 0}
        invoices={paying}
        onClose={() => setPaying([])}
        onPaid={() => setExpandedId(null)}
      />
    </AppChrome>
  );
}
