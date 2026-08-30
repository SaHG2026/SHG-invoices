'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { useMemo, useState } from 'react';
import { useCurrentProfile } from '@/lib/queries/session';
import { useUnpaidInvoices } from '@/lib/queries/invoices';
import { useBusinesses } from '@/lib/queries/reference';
import { AppChrome, useSydneyToday } from '@/components/app/AppChrome';
import { BusinessMark } from '@/components/ui/BusinessMark';
import { greet } from '@/lib/greeting';
import { formatDayWithYear, type DateStr } from '@/lib/date';
import { formatCents } from '@/lib/money';
import {
  SORT_OPTIONS,
  sortInvoices,
  summarise,
  summariseByBusiness,
  summariseUrgency,
  type SortKey,
} from '@/lib/derive/select';
import { groupIntoRuns } from '@/lib/derive/runs';
import {
  formatDueLabel,
  URGENCY_COLOUR,
  URGENCY_TINT,
  urgencyOf,
  type Urgency,
} from '@/lib/derive/urgency';
import { invoiceHref, pendingHref, scopeHref } from '@/lib/scope';
import type { PaymentRun } from '@/lib/types';

/**
 * The dashboard. ARCHITECTURE §16, redesigned to the client's own mockup.
 *
 * ---------------------------------------------------------------------------
 * What changed, and why it is not just decoration.
 *
 * It used to lead with one number — everything outstanding — and then a list
 * of links to each business. That answered "how much is there", which is not
 * the question spec §1 puts second: Mani opens this on Monday morning and
 * needs to know, within three seconds, what is already late and what leaves
 * the account this week. One combined total answers neither, because it mixes
 * money that is a problem now with money that is not yet anybody's problem.
 *
 * So the headline is two figures instead of one, and the list beneath is the
 * actual invoices in due order rather than a menu. The businesses moved into
 * the side menu, which is what made the space for this.
 *
 * Every figure here — both cards, every row, the business totals — is derived
 * from the one unpaid array (architecture §2). They cannot disagree with each
 * other or with the screens they lead to (notes §3).
 * ---------------------------------------------------------------------------
 */

/**
 * How many payment runs the dashboard shows before handing over to Pending.
 *
 * This is a summary, not the ledger. Six is about a screen's worth on a phone,
 * and the honest thing beneath it is a link that says how many more there are
 * rather than a list that quietly stops.
 */
const COMING_UP_LIMIT = 6;

export default function Dashboard() {
  const { data: profile } = useCurrentProfile();
  const { data: invoices = [], isLoading } = useUnpaidInvoices();
  const { data: businesses = [] } = useBusinesses();
  const today = useSydneyToday();

  const [sort, setSort] = useState<SortKey>('due');
  const [sortOpen, setSortOpen] = useState(false);

  const summary = useMemo(() => summarise(invoices), [invoices]);
  const urgency = useMemo(
    () => (today ? summariseUrgency(invoices, today) : null),
    [invoices, today],
  );
  const perBusiness = useMemo(
    () => (today ? summariseByBusiness(invoices, businesses, today) : []),
    [invoices, businesses, today],
  );

  /*
   * Sorted first, then grouped, then flattened into what a card renders.
   *
   * Two things are deliberate here.
   *
   * groupIntoRuns always returns runs in due order, which is right for the
   * default and wrong for the other three sorts. Sorting the invoices and then
   * keying the groups off the order they arrive in means "biggest amount"
   * genuinely puts the biggest run first, rather than putting the earliest run
   * first and calling it sorted.
   *
   * And this returns null — not an empty array — until `today` is known.
   * `useSydneyToday` reads the clock in an effect, because storage and dates
   * cannot be touched during render without breaking hydration, so the first
   * render genuinely has no today. The first version of this passed `today!`
   * into the card and every render threw. Computing the date-dependent strings
   * in here, where today is narrowed to a real value, means a card cannot be
   * constructed without one.
   */
  const cards = useMemo((): ComingUpCard[] | null => {
    if (!today) return null;

    const grouped = groupIntoRuns(sortInvoices(invoices, sort));
    let ordered = grouped;

    if (sort !== 'due') {
      const rank = new Map<string, number>();
      sortInvoices(invoices, sort).forEach((invoice, index) => {
        const key = `${invoice.supplier_id}:${invoice.due_date}`;
        if (!rank.has(key)) rank.set(key, index);
      });
      ordered = [...grouped].sort((a, b) => (rank.get(a.key) ?? 0) - (rank.get(b.key) ?? 0));
    }

    return ordered.map((run) => toCard(run, today));
  }, [invoices, sort, today]);

  const shown = cards?.slice(0, COMING_UP_LIMIT) ?? [];
  const sortLabel = SORT_OPTIONS.find((option) => option.key === sort)?.label ?? 'Due date';

  /*
   * The longer of the two figures decides the type size for both.
   *
   * Sized per card, they would differ whenever one total has an extra digit,
   * and two headline numbers set at two sizes reads as one of them mattering
   * more. Sized from the longest, they stay a pair.
   */
  const figureChars = Math.max(
    formatCents(urgency?.overdue.total_cents ?? 0).length,
    formatCents(urgency?.next7.total_cents ?? 0).length,
  );

  return (
    <AppChrome add="bar">
      {/*
        Kept, and made small. ARCHITECTURE §16 calls the greeting "the one
        place in the app allowed any [warmth]" and the Phase 4 gate names it.
        The mockup does not show it; dropping a signed-off thing during a
        visual pass is not a visual decision, so it stays until asked.
      */}
      <header className="mb-4">
        {/*
          The greeting is the page heading, not decoration above one. Made
          small rather than demoted to a <p>: a screen whose first heading is
          "Coming up" has no h1 at all, which is a real navigation problem for
          anybody moving by headings.
        */}
        <h1 className="text-base text-ink">
          {today && profile ? greet(profile.display_name) : ' '}
        </h1>
        <p className="figure-date text-xs uppercase tracking-widest text-muted">
          {today ? formatDayWithYear(today) : ' '}
        </p>
      </header>

      <div className="mb-6 grid grid-cols-2 gap-3">
        <StatCard
          label="Overdue"
          cents={urgency?.overdue.total_cents ?? 0}
          tone="overdue"
          chars={figureChars}
          loading={isLoading || !urgency}
          detail={
            urgency && urgency.overdue.invoice_count > 0
              ? `${count(urgency.overdue.invoice_count, 'invoice')} · ${count(
                  urgency.overdue.supplier_count,
                  'supplier',
                )}`
              : 'Nothing late'
          }
        />
        <StatCard
          label="Next 7 days"
          cents={urgency?.next7.total_cents ?? 0}
          tone="plain"
          chars={figureChars}
          loading={isLoading || !urgency}
          detail={
            urgency && urgency.next7.invoice_count > 0
              ? count(urgency.next7.invoice_count, 'invoice')
              : 'Nothing due'
          }
        />
      </div>

      <section className="mb-6">
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <h2 className="text-h2 text-ink">Coming up</h2>
          <button
            type="button"
            onClick={() => setSortOpen((open) => !open)}
            aria-expanded={sortOpen}
            className="touch flex items-center text-sm text-action"
          >
            Sort: {sortLabel.toLowerCase()}
          </button>
        </div>

        {sortOpen ? (
          <div role="group" aria-label="Sort by" className="row-in mb-2 flex flex-wrap gap-2">
            {SORT_OPTIONS.map((option) => (
              <button
                key={option.key}
                type="button"
                onClick={() => {
                  setSort(option.key);
                  setSortOpen(false);
                }}
                aria-pressed={sort === option.key}
                className="touch rounded-full border px-3 text-sm"
                style={
                  sort === option.key
                    ? {
                        backgroundColor: 'var(--action-bg)',
                        borderColor: 'var(--action)',
                        color: 'var(--action)',
                      }
                    : { borderColor: 'var(--hairline)', color: 'var(--text)' }
                }
              >
                {option.label}
              </button>
            ))}
          </div>
        ) : null}

        {isLoading || cards === null ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : cards.length === 0 ? (
          <p className="rounded-sm border border-edge bg-card p-4 text-sm text-muted">
            Nothing outstanding. Add an invoice with the button below.
          </p>
        ) : (
          <>
            <ul aria-label="Coming up" className="flex flex-col gap-2">
              {shown.map((card) => (
                <RunCard key={card.key} card={card} />
              ))}
            </ul>

            {cards.length > shown.length ? (
              <Link
                href={pendingHref('all')}
                className="touch mt-2 flex items-center justify-center rounded-sm border border-edge bg-card text-sm text-action"
              >
                See all {count(summary.invoice_count, 'invoice')} pending
              </Link>
            ) : null}
          </>
        )}
      </section>

      {/*
        The businesses. Also in the side menu, but with counts rather than
        money — and "what does Hurstville owe" is a different question from
        "how many are outstanding there". The Phase 4 gate asks for a total per
        business, so the totals live here.
      */}
      <section>
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <h2 className="text-h2 text-ink">Businesses</h2>
          <Link
            href={scopeHref('all')}
            className="touch flex items-baseline gap-2 text-sm text-action"
          >
            <span>Overall</span>
            <span className="money text-sm">{formatCents(summary.total_cents)}</span>
          </Link>
        </div>

        <ul className="overflow-hidden rounded-sm border border-edge bg-card">
          {perBusiness.map((entry) => (
            <li key={entry.business.id} className="border-b border-hairline last:border-b-0">
              <Link
                href={scopeHref(entry.business.code.toLowerCase())}
                className="flex h-row items-center gap-3 px-3 active:bg-pressed"
              >
                <BusinessMark business={entry.business} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-ink">{entry.business.name}</span>
                  <span className="block truncate text-xs text-muted">
                    {entry.invoice_count === 0
                      ? 'Nothing outstanding'
                      : count(entry.invoice_count, 'invoice')}
                    {entry.overdue_count > 0 ? (
                      <>
                        {' · '}
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
      </section>
    </AppChrome>
  );
}

/** '3 invoices' / '1 invoice'. */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * One of the two headline figures.
 *
 * Overdue is coloured; the week is not. Two coloured cards side by side is two
 * alarms, and an alarm that is always on stops being read — the week's money
 * is expected, and only the late money is a problem.
 */
function StatCard({
  label,
  cents,
  detail,
  tone,
  chars,
  loading,
}: {
  label: string;
  cents: number;
  detail: string;
  tone: 'overdue' | 'plain';
  /** Length of the longest figure on the row, so both cards set the same size. */
  chars: number;
  loading: boolean;
}) {
  const isAlarm = tone === 'overdue' && cents > 0;

  /*
   * The figure shrinks to fit rather than overflowing its card.
   *
   * Two half-width cards on a 360px phone leave about 134px for the number.
   * At the full 28px display size that holds nine or ten characters —
   * "$18,347.88" and no more — so the first six-figure overdue total would
   * have run off the edge of the card. Measured, not guessed: $118,347.88
   * came out at 153px inside a 147px box on a 390px viewport, and 360px is
   * the width notes §4 says to test at.
   *
   * `cqw` is a percentage of this card's own width, so the number fits on any
   * screen without the component knowing what screen it is on. The 0.58 is the
   * mono advance width plus a little air, measured at 0.525. `min` keeps 28px
   * as the ceiling, so the ordinary case is unchanged.
   */
  const fontSize = `min(var(--text-h1), ${(100 / (Math.max(chars, 1) * 0.58)).toFixed(2)}cqw)`;

  return (
    <div
      className="rounded-sm border border-edge bg-card p-3"
      style={{ containerType: 'inline-size' }}
    >
      <p
        className="text-xs uppercase tracking-widest"
        style={{ color: isAlarm ? 'var(--spine-overdue)' : 'var(--muted)' }}
      >
        {label}
      </p>
      <p
        className="money mt-1"
        style={{
          fontSize,
          lineHeight: 1.15,
          textAlign: 'left',
          color: isAlarm ? 'var(--spine-overdue)' : 'var(--text)',
        }}
      >
        {loading ? ' ' : formatCents(cents)}
      </p>
      <p className="mt-0.5 text-xs text-muted">{loading ? ' ' : detail}</p>
    </div>
  );
}

/**
 * What a Coming up card renders — already resolved against a known `today`.
 *
 * Deliberately strings and not a PaymentRun plus a date. The card cannot then
 * be handed a null today, cannot re-derive urgency differently from the pill
 * beside it, and can be tested by passing it a literal.
 */
interface ComingUpCard {
  key: string;
  href: Route;
  supplier: string;
  /** '2 invoices · GMH', or '#HW-2281 · MJR' for a run of one. */
  subtitle: string;
  amountCents: number;
  dueLabel: string;
  urgency: Urgency;
}

/**
 * A payment run, resolved for display.
 *
 * Tapping goes where the invoice can be acted on — the record itself for a
 * single invoice, that business's week for a run, where the whole run ticks in
 * one transaction. Deliberately no tick on the card: the dashboard is what you
 * read to decide what to do, and a one-tap irreversible-feeling control on a
 * summary you are scrolling is how the wrong thing gets ticked.
 */
function toCard(run: PaymentRun, today: DateStr): ComingUpCard {
  const single = run.invoices.length === 1 ? run.invoices[0]! : null;
  const business = run.invoices[0]!.business;

  const identifier = single
    ? single.invoice_number
      ? `#${single.invoice_number}`
      : 'No invoice number'
    : count(run.invoices.length, 'invoice');

  return {
    key: run.key,
    href: single ? invoiceHref(single.id) : scopeHref(business.code.toLowerCase()),
    supplier: run.supplier.name,
    subtitle: `${identifier} · ${business.code}`,
    amountCents: run.total_cents,
    dueLabel: formatDueLabel(run.due_date, today),
    urgency: urgencyOf(run.due_date, today),
  };
}

function RunCard({ card }: { card: ComingUpCard }) {
  return (
    <li>
      <Link
        href={card.href}
        className="flex items-center gap-3 rounded-sm border border-edge bg-card px-3 py-2.5 active:bg-pressed"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-ink">{card.supplier}</span>
          <span className="figure-date mt-0.5 block truncate text-xs text-muted">
            {card.subtitle}
          </span>
        </span>

        <span className="flex shrink-0 flex-col items-end gap-1">
          <span className="money text-sm text-ink">{formatCents(card.amountCents)}</span>
          <span
            className="rounded-sm px-1.5 py-0.5 text-[11px]"
            style={{
              backgroundColor: URGENCY_TINT[card.urgency],
              color: URGENCY_COLOUR[card.urgency],
            }}
          >
            {card.dueLabel}
          </span>
        </span>
      </Link>
    </li>
  );
}
