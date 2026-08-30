'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { useMemo, useState } from 'react';
import { useUnpaidInvoices } from '@/lib/queries/invoices';
import { useBusinesses } from '@/lib/queries/reference';
import { useProfiles } from '@/lib/queries/session';
import { AppChrome, useSydneyToday } from '@/components/app/AppChrome';
import { PaymentRunRow } from '@/components/invoice/PaymentRunRow';
import { MarkPaidSheet } from '@/components/invoice/MarkPaidSheet';
import { useTickOff } from '@/hooks/use-tick-off';
import { formatDay } from '@/lib/date';
import { formatCents } from '@/lib/money';
import { summarise } from '@/lib/derive/select';
import { groupIntoRuns } from '@/lib/derive/runs';
import { bucketByUrgency, URGENCY_COLOUR, URGENCY_TINT, type Urgency } from '@/lib/derive/urgency';
import {
  filterByScope,
  historyHref,
  isKnownScope,
  pendingHref,
  scopeLabel,
  type Scope,
} from '@/lib/scope';
import { WEEK_HORIZON_DAYS } from '@/lib/constants';
import type { InvoiceRow } from '@/lib/types';

/**
 * The Week. Spec §7.2 — the screen that answers "what leaves the account, and
 * when", scoped to Overall or to one business.
 *
 * Spec §1's second metric: Mani opens this on Monday morning and knows within
 * three seconds what is due this week and what is already late. So the order
 * is fixed — overdue first, then today, then the week — and each section
 * carries its own total, because the section total is the number you act on.
 */

const SECTION_LABEL: Record<Urgency, string> = {
  overdue: 'Overdue',
  today: 'Today',
  week: `Next ${WEEK_HORIZON_DAYS} days`,
  later: 'Later',
};

export function WeekView({ scope }: { scope: Scope }) {
  const { data: invoices = [], isLoading } = useUnpaidInvoices();
  const { data: businesses = [] } = useBusinesses();
  const { data: people = [] } = useProfiles();
  const today = useSydneyToday();
  const tickOff = useTickOff();

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [paying, setPaying] = useState<InvoiceRow[]>([]);

  const scoped = useMemo(
    () => filterByScope(invoices, scope, businesses),
    [invoices, scope, businesses],
  );
  const summary = useMemo(() => summarise(scoped), [scoped]);
  const buckets = useMemo(
    () => (today ? bucketByUrgency(scoped, today) : null),
    [scoped, today],
  );

  const known = businesses.length === 0 || isKnownScope(scope, businesses);

  return (
    <AppChrome back={{ href: '/' as Route, label: 'Invoices' }}>
      {!known ? (
        <section className="rounded-sm border border-edge bg-card p-4">
          <h1 className="text-h2 text-ink">No such business</h1>
          <p className="mt-2 text-sm text-muted">
            That link points at a business that doesn&rsquo;t exist, or one that has been
            deactivated.
          </p>
          <Link href="/" className="touch mt-3 flex items-center text-sm text-action">
            Back to businesses
          </Link>
        </section>
      ) : (
        <>
          <header className="mb-6">
            <p className="text-xs uppercase tracking-widest text-muted">
              {scopeLabel(scope, businesses)}
            </p>
            <p className="money mt-1 text-total text-ink" style={{ textAlign: 'left' }}>
              {formatCents(summary.total_cents)}
            </p>
            <p className="mt-1 text-sm text-muted">
              {isLoading
                ? 'Loading…'
                : summary.invoice_count === 0
                  ? 'Nothing outstanding.'
                  : `across ${summary.invoice_count} invoice${summary.invoice_count === 1 ? '' : 's'} · ${summary.supplier_count} supplier${summary.supplier_count === 1 ? '' : 's'}`}
            </p>
          </header>

          {/*
            The two views of THIS scope. Suppliers used to sit here too and has
            moved to the side menu: it is the same screen from everywhere, so a
            copy of the link on each business was one list maintained twice.
            These two are not — each is scoped to the business you are in.
          */}
          <nav className="mb-6 overflow-hidden rounded-sm border border-edge bg-card">
            {(
              [
                [pendingHref(scope), 'All pending, sorted and filtered'],
                [historyHref(scope), 'History — what has been paid'],
              ] as const
            ).map(([href, label]) => (
              <Link
                key={label}
                href={href}
                className="flex h-row items-center gap-3 border-b border-hairline px-3 last:border-b-0 active:bg-pressed"
              >
                <span className="flex-1 text-sm text-ink">{label}</span>
                <span aria-hidden className="text-xs text-muted">
                  &rsaquo;
                </span>
              </Link>
            ))}
          </nav>

          {buckets && summary.invoice_count > 0
            ? (Object.keys(SECTION_LABEL) as Urgency[]).map((urgency) => {
                const rows = buckets[urgency];
                if (rows.length === 0) return null;
                const runs = groupIntoRuns(rows);

                return (
                  <section key={urgency} className="mb-6">
                    <div className="mb-1 flex items-baseline justify-between gap-2">
                      <span
                        className="rounded-sm px-2 py-0.5 text-xs uppercase tracking-widest"
                        style={{
                          backgroundColor: URGENCY_TINT[urgency],
                          color: URGENCY_COLOUR[urgency],
                        }}
                      >
                        {SECTION_LABEL[urgency]}
                        {urgency === 'today' && today ? ` · ${formatDay(today)}` : ''}
                      </span>
                      <span className="money text-sm text-ink">
                        {formatCents(rows.reduce((sum, row) => sum + row.amount_cents, 0))}
                      </span>
                    </div>

                    <ul className="overflow-hidden rounded-sm border border-edge bg-card">
                      {runs.map((run) => (
                        <PaymentRunRow
                          key={run.key}
                          run={run}
                          today={today!}
                          people={people}
                          expandedId={expandedId}
                          onToggle={(id) => setExpandedId((current) => (current === id ? null : id))}
                          onMarkPaid={(chosen) => {
                            // One invoice ticks immediately with an undo; a
                            // whole run goes through the sheet, where the
                            // bank reference is worth capturing.
                            if (chosen.length === 1) void tickOff(chosen[0]!);
                            else setPaying(chosen);
                          }}
                        />
                      ))}
                    </ul>
                  </section>
                );
              })
            : null}

          {!isLoading && summary.invoice_count === 0 ? (
            <p className="rounded-sm border border-edge bg-card p-4 text-sm text-muted">
              No invoices outstanding here. Add one with the + button.
            </p>
          ) : null}
        </>
      )}
      <MarkPaidSheet
        open={paying.length > 0}
        invoices={paying}
        onClose={() => setPaying([])}
        onPaid={() => setExpandedId(null)}
      />
    </AppChrome>
  );
}
