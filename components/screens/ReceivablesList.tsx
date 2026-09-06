'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { Route } from 'next';
import { AppChrome } from '@/components/app/AppChrome';
import { SalesInvoiceRowItem } from '@/components/invoice/SalesInvoiceRowItem';
import { useSydneyToday } from '@/hooks/use-sydney-today';
import { useOutstandingSales } from '@/lib/queries/sales';
import { summariseReceivable } from '@/lib/derive/receivables';
import { formatCents } from '@/lib/money';
import { compareDates, formatDayWithYear } from '@/lib/date';
import type { SalesInvoiceRow } from '@/lib/types';

/**
 * Everything still owed to Deli, in one place.
 *
 * HANDOFF §7 carried this as "a global list of issued invoices — worth adding
 * when a customer becomes the wrong index". It became the wrong index the
 * moment the client asked to *"add Receivables in there to track the pending
 * receivables"*: chasing money is a job you do across every customer at once,
 * and doing it from the customer list means opening six pages to find the two
 * with anything in them.
 *
 * This is the mirror of PendingList, one ledger over, and it deliberately
 * borrows that screen's shape: a total at the top, the list under it, and
 * every figure derived from the same array (rule 4). The vocabulary stays
 * `received`, never `paid` — §17, you do not pay an invoice you issued.
 */

type Sort = 'due' | 'largest' | 'customer';

const SORT_LABEL: Record<Sort, string> = {
  due: 'By due',
  largest: 'Largest',
  customer: 'By customer',
};

export function ReceivablesList() {
  const today = useSydneyToday();
  const { data: sales = [], isLoading, isError } = useOutstandingSales();
  const [sort, setSort] = useState<Sort>('due');

  /*
   * One array, one total. The figure at the top is a `useMemo` over exactly
   * the rows rendered beneath it, so the two cannot disagree — the failure the
   * notes call trust-destroying, on the screen where a wrong total means
   * chasing somebody for money they do not owe.
   */
  const owed = useMemo(
    () => (today ? summariseReceivable(sales, today) : null),
    [sales, today],
  );

  const ordered = useMemo(() => {
    const rows = [...sales];
    if (sort === 'largest') return rows.sort((a, b) => b.amount_cents - a.amount_cents);
    if (sort === 'customer') {
      return rows.sort((a, b) => a.customer.name.localeCompare(b.customer.name));
    }
    /*
     * By due date, and an invoice with no due date sorts LAST.
     *
     * Not first, and not mixed in. Something with no agreed deadline cannot be
     * the most urgent thing on a chasing list, and putting it at the top would
     * be the screen inventing the urgency the switch exists to avoid.
     */
    return rows.sort((a, b) => {
      if (a.due_date === null && b.due_date === null) return 0;
      if (a.due_date === null) return 1;
      if (b.due_date === null) return -1;
      return compareDates(a.due_date, b.due_date);
    });
  }, [sales, sort]);

  return (
    <AppChrome back={{ href: '/b/ddl' as Route, label: 'Deli Delights' }}>
      <h1 className="text-h1 mb-1 text-ink">Receivables</h1>
      <p className="mb-4 text-sm text-muted">
        Invoices Deli has sent that nobody has paid yet.
      </p>

      <section className="mb-4 rounded-sm border border-edge bg-card p-4">
        <p className="text-xs uppercase tracking-widest text-muted">Owed to us</p>
        <p className="money mt-1 text-total text-ink" style={{ textAlign: 'left' }}>
          {formatCents(owed?.total_cents ?? 0)}
        </p>
        <p className="mt-1 text-sm text-muted">
          {!owed || owed.invoice_count === 0
            ? 'Nothing outstanding.'
            : `across ${owed.invoice_count} invoice${owed.invoice_count === 1 ? '' : 's'}${
                owed.oldest_due ? ` · oldest due ${formatDayWithYear(owed.oldest_due)}` : ''
              }`}
        </p>
        {owed && owed.overdue_count > 0 ? (
          <p className="mt-1 text-sm" style={{ color: 'var(--spine-overdue)' }}>
            {formatCents(owed.overdue_cents)} past due.
          </p>
        ) : null}
      </section>

      {sales.length > 1 ? (
        <div className="mb-3 flex gap-1">
          {(Object.keys(SORT_LABEL) as Sort[]).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setSort(option)}
              aria-pressed={sort === option}
              className={`touch rounded-full border px-3 text-xs ${
                sort === option
                  ? 'border-action bg-action text-action-text'
                  : 'border-hairline bg-card text-muted'
              }`}
            >
              {SORT_LABEL[option]}
            </button>
          ))}
        </div>
      ) : null}

      {isError ? (
        <p className="rounded-sm border border-edge bg-card p-4 text-sm text-muted">
          Couldn’t load these. Check your signal and pull down to try again.
        </p>
      ) : isLoading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : ordered.length === 0 ? (
        <p className="rounded-sm border border-edge bg-card p-4 text-sm text-muted">
          Nothing outstanding. Every invoice Deli has sent has been received.
        </p>
      ) : (
        <ul className="overflow-hidden rounded-sm border border-edge bg-card">
          {ordered.map((row: SalesInvoiceRow) => (
            <SalesInvoiceRowItem
              key={row.id}
              row={row}
              today={today}
              /* Whose invoice it is, because this list crosses customers and
                 the number alone does not say. */
              showCustomer
            />
          ))}
        </ul>
      )}

      <Link
        href={'/customers' as Route}
        className="touch mt-4 flex items-center justify-center rounded-sm border border-hairline bg-card text-sm text-action"
      >
        Customers &rsaquo;
      </Link>
    </AppChrome>
  );
}
