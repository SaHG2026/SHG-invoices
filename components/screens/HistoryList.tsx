'use client';

import { useMemo, useState } from 'react';
import { AppChrome } from '@/components/app/AppChrome';
import { PersonChip } from '@/components/ui/PersonChip';
import { InvoiceRow } from '@/components/invoice/InvoiceRow';
import { useSydneyToday } from '@/hooks/use-sydney-today';
import { useCurrentProfile, useProfiles, useTeam } from '@/lib/queries/session';
import { maySeePaymentHistory } from '@/lib/nav';
import { useBusinesses, useSuppliers } from '@/lib/queries/reference';
import { useHistory } from '@/lib/queries/history';
import { formatCents, sumCents } from '@/lib/money';
import { businessForScope, isAll, scopeHref, scopeLabel, type Scope } from '@/lib/scope';

/**
 * Paid and voided invoices. Spec §7.7.
 *
 * "Filter by payer — 'everything Sujan ticked off in July' should take two
 * taps." So the payer filter is a row of chips rather than anything nested:
 * tap History, tap Sujan. That is the two taps.
 *
 * The total here is deliberately labelled as covering what is shown rather
 * than everything ever paid. History is the one list the database paginates,
 * so a figure at the bottom of it cannot claim to be a complete sum — and
 * quietly implying otherwise is exactly the trust problem notes §3 is about.
 */
export function HistoryList({ scope }: { scope: Scope }) {
  const today = useSydneyToday();
  const { data: profile, isLoading: profileLoading } = useCurrentProfile();
  // Everybody, for naming whoever paid a given invoice.
  const { data: people = [] } = useProfiles();
  // The three who pay things, for the filter chips. ARCHITECTURE §28.2.
  const { data: team = [] } = useTeam();
  const { data: businesses = [] } = useBusinesses();
  const { data: suppliers = [] } = useSuppliers();

  const [search, setSearch] = useState('');
  const [paidBy, setPaidBy] = useState<string | null>(null);
  const [includeVoid, setIncludeVoid] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const business = businessForScope(scope, businesses);
  const filters = useMemo(
    () => ({
      businessId: isAll(scope) ? null : (business?.id ?? null),
      paidBy,
      search,
      includeVoid,
    }),
    [scope, business, paidBy, search, includeVoid],
  );

  const { data: invoices = [], isLoading } = useHistory(filters, suppliers);
  const shownTotal = useMemo(() => sumCents(invoices), [invoices]);

  /*
   * The third door, and the only one that is not a link: this URL.
   *
   * Hiding the menu row and the week view's link would leave a bookmark, a
   * back button and a typed address all still working — and a screen somebody
   * can still reach is a screen that is not hidden. The queries above still
   * run, because RLS is what actually decides (CATCH_UP_027 makes it so);
   * this is the interface not offering what it has been told not to show.
   *
   * `profileLoading` is waited on deliberately. `isAssistant(undefined)` is
   * false, so rendering before the profile arrives would flash the whole
   * history at the one person who must not see it -- the same "must not
   * flicker in this direction" the owner's controls have (tiers.test.tsx).
   */
  if (profileLoading) {
    return (
      <AppChrome back={{ href: scopeHref(scope), label: scopeLabel(scope, businesses) }}>
        <p className="text-sm text-muted">Loading…</p>
      </AppChrome>
    );
  }

  if (!maySeePaymentHistory(profile)) {
    return (
      <AppChrome back={{ href: scopeHref(scope), label: scopeLabel(scope, businesses) }}>
        <h1 className="text-h1 mb-3 text-ink">History</h1>
        <p className="rounded-sm border border-edge bg-card p-4 text-sm text-muted">
          Paid invoices aren&rsquo;t part of your access. What is still owed is on{' '}
          <span className="text-ink">Invoices</span>.
        </p>
      </AppChrome>
    );
  }

  return (
    <AppChrome back={{ href: scopeHref(scope), label: scopeLabel(scope, businesses) }}>
      <h1 className="text-h1 mb-3 text-ink">History</h1>

      <div className="mb-3 flex items-center rounded-sm border border-hairline bg-card">
        <span aria-hidden className="pl-3 text-sm text-muted">
          &#9906;
        </span>
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Supplier, invoice number or amount"
          aria-label="Search history"
          className="touch min-w-0 flex-1 bg-transparent px-2 text-base text-ink outline-none"
        />
        {search ? (
          <button
            type="button"
            onClick={() => setSearch('')}
            aria-label="Clear search"
            className="touch shrink-0 px-3 text-sm text-muted"
          >
            &times;
          </button>
        ) : null}
      </div>

      {/* Payer. One tap from here — spec §7.7. */}
      <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label="Filter by who paid">
        <button
          type="button"
          onClick={() => setPaidBy(null)}
          aria-pressed={paidBy === null}
          className={`touch rounded-full border px-3 text-sm ${
            paidBy === null
              ? 'border-action bg-action text-action-text'
              : 'border-hairline bg-card text-ink'
          }`}
        >
          Anyone
        </button>

        {team.map((person) => (
          <button
            key={person.id}
            type="button"
            onClick={() => setPaidBy(paidBy === person.id ? null : person.id)}
            aria-pressed={paidBy === person.id}
            className={`touch flex items-center gap-2 rounded-full border px-3 text-sm ${
              paidBy === person.id
                ? 'border-action bg-action text-action-text'
                : 'border-hairline bg-card text-ink'
            }`}
          >
            <PersonChip profile={person} />
            {person.display_name}
          </button>
        ))}
      </div>

      <label className="mb-4 flex items-center gap-2 text-sm text-muted">
        <input
          type="checkbox"
          checked={includeVoid}
          onChange={(event) => setIncludeVoid(event.target.checked)}
          className="size-4"
        />
        Include voided
      </label>

      {isLoading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : invoices.length === 0 ? (
        <p className="rounded-sm border border-edge bg-card p-4 text-sm text-muted">
          {search || paidBy
            ? 'Nothing matches. Clear a filter to see more.'
            : 'Nothing has been paid yet. Invoices appear here once they are ticked off.'}
        </p>
      ) : (
        <>
          <ul className="overflow-hidden rounded-sm border border-edge bg-card">
            {invoices.map((invoice) => (
              <HistoryRow
                key={invoice.id}
                invoice={invoice}
                today={today}
                people={people}
                expanded={expandedId === invoice.id}
                onToggle={() =>
                  setExpandedId((current) => (current === invoice.id ? null : invoice.id))
                }
              />
            ))}
          </ul>

          <p className="mt-3 flex items-baseline justify-between gap-3 text-sm text-muted">
            <span>
              {invoices.length} shown
              {invoices.length === 50 ? ' (most recent)' : ''}
            </span>
            <span className="money text-ink">{formatCents(shownTotal)}</span>
          </p>
        </>
      )}
    </AppChrome>
  );
}

/**
 * A history row.
 *
 * Reuses the list row so a paid invoice reads the same here as anywhere else,
 * but with the payer's chip rather than the author's — on this screen the
 * question is who settled it, and spec §7.5 wants that chip on every line of a
 * payment history. Voided rows are struck through and never tickable.
 */
function HistoryRow({
  invoice,
  today,
  people,
  expanded,
  onToggle,
}: {
  invoice: Parameters<typeof InvoiceRow>[0]['invoice'];
  today: string | null;
  people: Parameters<typeof InvoiceRow>[0]['people'];
  expanded: boolean;
  onToggle: () => void;
}) {
  const payer = people.find((person) => person.id === invoice.paid_by);

  return (
    <li className={invoice.status === 'void' ? 'opacity-60 [&_*]:line-through' : ''}>
      <ul>
        <InvoiceRow
          invoice={payer ? { ...invoice, created_by: payer.id } : invoice}
          today={today ?? invoice.due_date}
          people={people}
          expanded={expanded}
          onToggle={onToggle}
          showSpine={false}
        />
      </ul>
    </li>
  );
}
