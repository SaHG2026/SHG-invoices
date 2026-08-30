'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { useCurrentProfile } from '@/lib/queries/session';
import { useUnpaidInvoices } from '@/lib/queries/invoices';
import { useBusinesses } from '@/lib/queries/reference';
import { AppChrome, useSydneyToday } from '@/components/app/AppChrome';
import { greet } from '@/lib/greeting';
import { formatDayWithYear } from '@/lib/date';
import { formatCents } from '@/lib/money';
import { summarise, summariseByBusiness } from '@/lib/derive/select';
import { scopeHref } from '@/lib/scope';

/**
 * The dashboard. ARCHITECTURE §16.
 *
 * Answers one question before anything else: what does the group owe, and
 * which business needs looking at. Everything below is a way into that.
 *
 * Every figure here is derived from the one unpaid-invoice array, so the
 * headline, the Overall row and the four business rows cannot disagree with
 * each other or with the lists they lead to (notes §3).
 */
export default function Dashboard() {
  const { data: profile } = useCurrentProfile();
  const { data: invoices = [], isLoading } = useUnpaidInvoices();
  const { data: businesses = [] } = useBusinesses();
  const today = useSydneyToday();

  const summary = useMemo(() => summarise(invoices), [invoices]);
  const perBusiness = useMemo(
    () => (today ? summariseByBusiness(invoices, businesses, today) : []),
    [invoices, businesses, today],
  );

  return (
    <AppChrome>
      <header className="mb-6">
        <p className="figure-date text-xs uppercase tracking-widest text-muted">
          {today ? formatDayWithYear(today) : '\u00a0'}
        </p>
        <h1 className="text-h1 text-ink">
          {today && profile ? greet(profile.display_name) : '\u00a0'}
        </h1>
      </header>

      <section className="mb-6 rounded-sm border border-edge bg-card p-4">
        <p className="text-xs uppercase tracking-widest text-muted">Owing</p>
        <p className="money mt-1 text-total text-ink" style={{ textAlign: 'left' }}>
          {formatCents(summary.total_cents)}
        </p>
        <p className="mt-1 text-sm text-muted">
          {isLoading
            ? 'Loading\u2026'
            : summary.invoice_count === 0
              ? 'Nothing outstanding.'
              : `across ${summary.invoice_count} invoice${summary.invoice_count === 1 ? '' : 's'} \u00b7 ${summary.supplier_count} supplier${summary.supplier_count === 1 ? '' : 's'}`}
        </p>
      </section>

      <nav aria-label="Businesses">
        <Link
          href={scopeHref('all')}
          className="mb-2 flex h-row items-center gap-3 rounded-sm border border-edge bg-card px-3 active:bg-pressed"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-ink">Overall</span>
            <span className="block text-xs text-muted">Every business together</span>
          </span>
          <span className="money shrink-0 text-sm text-ink">{formatCents(summary.total_cents)}</span>
          <span aria-hidden className="shrink-0 text-xs text-muted">
            &rsaquo;
          </span>
        </Link>

        <ul className="overflow-hidden rounded-sm border border-edge bg-card">
          {perBusiness.map((entry) => (
            <li key={entry.business.id} className="border-b border-hairline last:border-b-0">
              <Link
                href={scopeHref(entry.business.code.toLowerCase())}
                className="flex h-row items-center gap-3 px-3 active:bg-pressed"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-ink">{entry.business.name}</span>
                  <span className="block truncate text-xs text-muted">
                    {entry.invoice_count === 0
                      ? 'Nothing outstanding'
                      : `${entry.invoice_count} invoice${entry.invoice_count === 1 ? '' : 's'}`}
                    {entry.overdue_count > 0 ? (
                      <>
                        {' \u00b7 '}
                        <span style={{ color: 'var(--spine-overdue)' }}>
                          {entry.overdue_count} overdue
                        </span>
                      </>
                    ) : null}
                  </span>
                </span>
                <span className="money shrink-0 text-sm text-ink">
                  {formatCents(entry.total_cents)}
                </span>
                <span aria-hidden className="shrink-0 text-xs text-muted">
                  &rsaquo;
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </AppChrome>
  );
}
