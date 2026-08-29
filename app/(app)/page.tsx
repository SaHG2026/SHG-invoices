'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useCurrentProfile, useSignOut } from '@/lib/queries/session';
import { useUnpaidInvoices } from '@/lib/queries/invoices';
import { AddInvoiceSheet } from '@/components/invoice/AddInvoiceSheet';
import { greet } from '@/lib/greeting';
import { formatDay, formatDayWithYear, sydneyToday } from '@/lib/date';
import { formatCents } from '@/lib/money';
import { summarise } from '@/lib/derive/select';
import { formatDaysLate, URGENCY_COLOUR, urgencyOf } from '@/lib/derive/urgency';

/**
 * Phase 3 dashboard.
 *
 * Still not the real one — that is Phase 4 (ARCHITECTURE §16), with Overall
 * plus the four businesses and the due spine. This exists so the add-invoice
 * sheet has somewhere to open from and something to land in, which is what
 * makes the fifteen-second run timeable on a real phone.
 */
export default function Dashboard() {
  const { data: profile } = useCurrentProfile();
  const { data: invoices = [], isLoading } = useUnpaidInvoices();
  const signOut = useSignOut();
  const [sheetOpen, setSheetOpen] = useState(false);

  // The greeting depends on the current time, which the server does not know.
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => setNow(new Date()), []);
  const today = useMemo(() => (now ? sydneyToday(now) : null), [now]);

  const summary = useMemo(() => summarise(invoices), [invoices]);
  const recent = useMemo(
    () => [...invoices].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 12),
    [invoices],
  );

  if (!profile) return null;

  return (
    <main className="mx-auto min-h-dvh max-w-[560px] px-4 pb-28 pt-8">
      <header className="mb-8">
        <p className="figure-date text-xs uppercase tracking-widest text-mute">
          {today ? formatDayWithYear(today) : ' '}
        </p>
        <h1 className="text-h1 text-ink">{now ? greet(profile.display_name) : ' '}</h1>
      </header>

      <section className="mb-8 border-t border-hair pt-5">
        <p className="text-xs uppercase tracking-widest text-mute">Owing</p>
        <p className="money mt-1 text-total text-ink" style={{ textAlign: 'left' }}>
          {formatCents(summary.total_cents)}
        </p>
        <p className="mt-1 text-sm text-mute">
          {summary.invoice_count === 0
            ? 'Nothing outstanding.'
            : `across ${summary.invoice_count} invoice${summary.invoice_count === 1 ? '' : 's'} · ${summary.supplier_count} supplier${summary.supplier_count === 1 ? '' : 's'}`}
        </p>
      </section>

      <section className="mb-8">
        <p className="mb-2 text-xs uppercase tracking-widest text-mute">Recently added</p>

        {isLoading ? (
          <p className="text-sm text-mute">Loading…</p>
        ) : recent.length === 0 ? (
          <p className="border-t border-hair pt-4 text-sm text-mute">
            No invoices yet. Add one with the + button.
          </p>
        ) : (
          <ul className="border-t border-hair bg-card">
            {recent.map((invoice) => {
              const urgency = today ? urgencyOf(invoice.due_date, today) : 'later';
              const late = today ? formatDaysLate(invoice.due_date, today) : null;
              return (
                <li key={invoice.id} className="relative border-b border-hair last:border-b-0">
                  <span
                    aria-hidden
                    className="absolute inset-y-0 left-0 w-[3px]"
                    style={{ backgroundColor: URGENCY_COLOUR[urgency] }}
                  />
                  <div className="flex h-row items-center gap-3 pl-4 pr-3">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-ink">
                        {invoice.supplier.name}
                      </span>
                      <span className="figure-date block truncate text-xs text-mute">
                        {formatDay(invoice.due_date)}
                        {late ? ` · ${late}` : ''} · {invoice.business.code}
                        {invoice.internal_ref ? ` · ${invoice.internal_ref}` : ' · saving…'}
                      </span>
                    </span>
                    <span className="money shrink-0 text-sm text-ink">
                      {formatCents(invoice.amount_cents)}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="mb-8">
        <Link
          href="/specimen"
          className="touch flex items-center rounded-sm border border-hair bg-card px-3 text-sm text-ink"
        >
          Design tokens (Phase 1 review page)
        </Link>
      </section>

      <footer className="border-t border-hair pt-4">
        <button
          type="button"
          onClick={() => signOut.mutate()}
          disabled={signOut.isPending}
          className="touch w-full rounded-sm border border-hair px-4 text-sm text-ink disabled:opacity-40"
        >
          {signOut.isPending ? 'Signing out…' : `Sign out (${profile.display_name})`}
        </button>
      </footer>

      {/*
        Global, and reachable from every screen. ARCHITECTURE §16: reading the
        ledger is hierarchical, writing to it is not — making someone walk into
        a business first would spend three of the fifteen seconds on navigation.
      */}
      <button
        type="button"
        onClick={() => setSheetOpen(true)}
        aria-label="Add invoice"
        className="fixed right-4 z-40 flex size-14 items-center justify-center rounded-sm bg-gold text-h1 text-ink shadow-[0_2px_12px_rgba(18,56,75,0.24)]"
        style={{ bottom: `calc(1rem + env(safe-area-inset-bottom, 0px))` }}
      >
        +
      </button>

      <AddInvoiceSheet open={sheetOpen} onClose={() => setSheetOpen(false)} />
    </main>
  );
}
