'use client';

import { useMemo, useState } from 'react';
import { VenueChrome } from '@/components/app/VenueChrome';
import { useVenueInvoices } from '@/lib/queries/venue';
import { useCurrentProfile } from '@/lib/queries/session';
import { byMonth, stillCorrectable } from '@/lib/derive/venue';
import { formatDay, formatMonth } from '@/lib/date';
import { formatCents } from '@/lib/money';
import { useNow } from '@/hooks/use-now';
import type { StaffInvoice } from '@/lib/types';

/**
 * The whole of the app, for a venue account.
 *
 * ---------------------------------------------------------------------------
 * Why this is a screen of its own rather than the dashboard with rows filtered
 *
 * Because the dashboard cannot be made honest for this audience. Everything on
 * it — the week view, the spine, the urgency colours, "what leaves the account
 * this week" — is built on payment status, which a venue account cannot see
 * (CATCH_UP_010 §3). Reusing it would mean an overdue badge on an invoice paid
 * a fortnight ago, on the one screen a shop is meant to trust.
 *
 * So the question changed, and the screen changed with it. The dashboard
 * answers "what do we owe this week". This answers "was that delivery
 * logged, and for how much" — which is what a shop actually needs to know, and
 * the reason these accounts exist: management reviews rather than types.
 *
 * What follows from that: no urgency, no totals framed as liability, no
 * approval state. Spec §3.5 rules out an approval workflow, and none is being
 * smuggled in here — an invoice a shop enters is simply an invoice, marked
 * with the venue's chip so management can see where it came from.
 * ---------------------------------------------------------------------------
 */
export function VenueInvoices() {
  const { data: profile } = useCurrentProfile();
  const { data: invoices = [], isLoading, isError } = useVenueInvoices();
  const [editing, setEditing] = useState<StaffInvoice | null>(null);

  /*
   * Ticked, not read once.
   *
   * The Edit control has to disappear when the five minutes are up. Without a
   * clock it would sit there for as long as the phone stayed open, and tapping
   * it would produce a save the database refuses — a button that stops working
   * before it stops being offered, which is worse than no button because the
   * person has already decided what they were going to do.
   *
   * Fifteen seconds is fine: the cost of being up to fifteen seconds generous
   * is one refused save with a sentence explaining it.
   */
  const now = useNow(15_000);

  // ARCHITECTURE §2: the same array the rows render is the one every figure
  // below is computed from, so a month heading cannot disagree with its rows.
  const months = useMemo(() => byMonth(invoices), [invoices]);

  return (
    <VenueChrome editing={editing} onCloseEditing={() => setEditing(null)}>
      <h1 className="text-h1 text-ink">Invoices</h1>
      <p className="mt-1 text-sm text-muted">
        {profile ? `Logged for ${profile.display_name}` : 'Logged for this shop'}
      </p>

      {isLoading ? (
        <p className="mt-8 text-sm text-muted">Loading…</p>
      ) : isError ? (
        /*
         * Named, not "an error occurred" (spec §8). The realistic causes are a
         * dead connection and a profile that has been deactivated, and the
         * second one looks identical from here — so the sentence covers what
         * to do rather than guessing which it was.
         */
        <p className="mt-8 text-sm text-ink">
          Couldn’t load your invoices. Check your connection and pull down to try again — anything
          you have entered is safe.
        </p>
      ) : months.length === 0 ? (
        <p className="mt-8 text-sm text-muted">
          Nothing logged yet. Tap <span aria-hidden>+</span> to add the first invoice.
        </p>
      ) : (
        months.map((month) => (
          <section key={month.key} className="mt-6">
            <div className="mb-2 flex items-baseline justify-between gap-3">
              <h2 className="text-xs uppercase tracking-widest text-muted">
                {formatMonth(month.key)}
              </h2>
              {/*
                A record of what was entered, never a liability. This figure
                moves when somebody logs an invoice and never when somebody
                pays one — which is exactly the property that makes it safe to
                put in front of an account that must not learn about payments.
              */}
              <span className="text-xs text-muted">
                {month.invoices.length === 1 ? '1 invoice' : `${month.invoices.length} invoices`}
                {' · '}
                <span className="money">{formatCents(month.total_cents)}</span>
              </span>
            </div>

            <ul className="overflow-hidden rounded-sm border border-edge bg-card">
              {month.invoices.map((invoice, index) => (
                <li
                  key={invoice.id}
                  className={index > 0 ? 'border-t border-hairline' : undefined}
                >
                  {/*
                    Not a link. There is no invoice detail screen for a venue,
                    because detail is notes, the activity stream and the
                    payment history — none of which they may read. A row that
                    opens nothing should not look like it opens something
                    (notes §6).
                  */}
                  <div className="flex items-center gap-3 px-3 py-3">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-base text-ink">
                        {invoice.supplier_name}
                      </span>
                      <span className="block truncate text-xs text-muted">
                        {formatDay(invoice.invoice_date)}
                        {invoice.invoice_number ? ` · ${invoice.invoice_number}` : ''}
                        {/*
                          The reference is stamped by a database trigger, so a
                          row that has just been entered and not yet sent has
                          none. Showing an invented one would be a lie that
                          changes under whoever read it.
                        */}
                        {invoice.internal_ref ? ` · ${invoice.internal_ref}` : ''}
                      </span>
                    </span>
                    <span className="money shrink-0 text-base text-ink">
                      {formatCents(invoice.amount_cents)}
                    </span>
                    {/*
                      Only inside the window, and `now === null` on the first
                      render means nothing is offered until the clock is real —
                      the server has no clock the phone agrees with, and a
                      button that appears and then vanishes on hydration is
                      worse than one that arrives a frame late.

                      The database decides whether the save is allowed
                      (CATCH_UP_010's `staff_update`). This decides whether to
                      ask.
                    */}
                    {now !== null && stillCorrectable(invoice, now) ? (
                      <button
                        type="button"
                        onClick={() => setEditing(invoice)}
                        aria-label={`Correct ${invoice.supplier_name}, ${formatCents(invoice.amount_cents)}`}
                        className="touch -my-3 shrink-0 px-1 text-sm text-action"
                      >
                        Edit
                      </button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </VenueChrome>
  );
}
