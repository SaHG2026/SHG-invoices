import { describe, expect, it } from 'vitest';
import { BUSINESSES, FIXTURE_TODAY, makeInvoices } from '../fixtures/invoices';
import {
  filterInvoices,
  onlyUnpaid,
  searchInvoices,
  sortInvoices,
  summarise,
  summariseByBusiness,
  summariseUrgency,
} from '@/lib/derive/select';
import { bucketByUrgency } from '@/lib/derive/urgency';
import { groupIntoRuns } from '@/lib/derive/runs';
import { sumCents } from '@/lib/money';

/**
 * The 200-row pass. Spec §9: "Tested with a 200-invoice list."
 *
 * ---------------------------------------------------------------------------
 * What this measures, and what it deliberately does not
 *
 * Wall-clock assertions in a test suite are a way of getting a red build on a
 * busy machine, so the budgets below are loose enough to be about *shape*
 * rather than speed: they catch an accidental O(n²) — a `.find` inside a
 * `.map` over the same array is the usual way one appears — and they say
 * nothing about milliseconds on a phone. That number comes from a phone.
 *
 * The correctness half is the part with teeth. At forty rows an off-by-one in
 * a total is invisible; at two hundred, with runs and buckets and three
 * filters, the invariants either hold or they do not.
 * ---------------------------------------------------------------------------
 */

const ROWS = makeInvoices(200);
const today = FIXTURE_TODAY;

/** Generous on purpose. See above: this is a shape check, not a benchmark. */
const BUDGET_MS = 50;

function timed(work: () => unknown): number {
  const started = performance.now();
  work();
  return performance.now() - started;
}

describe('two hundred invoices', () => {
  it('has two hundred to work with', () => {
    expect(ROWS).toHaveLength(200);
  });

  it('filters, sorts, searches and buckets well inside budget', () => {
    expect(timed(() => filterInvoices(ROWS, { today }))).toBeLessThan(BUDGET_MS);
    expect(timed(() => sortInvoices(ROWS, 'due'))).toBeLessThan(BUDGET_MS);
    expect(timed(() => sortInvoices(ROWS, 'amount'))).toBeLessThan(BUDGET_MS);
    expect(timed(() => searchInvoices(ROWS, 'bid 11'))).toBeLessThan(BUDGET_MS);
    expect(timed(() => bucketByUrgency(ROWS, today))).toBeLessThan(BUDGET_MS);
    expect(timed(() => groupIntoRuns(ROWS))).toBeLessThan(BUDGET_MS);
    expect(timed(() => summarise(ROWS))).toBeLessThan(BUDGET_MS);
    expect(timed(() => summariseUrgency(ROWS, today))).toBeLessThan(BUDGET_MS);
  });

  /**
   * The whole screen's work, done the way a screen does it: filter, then sort,
   * then group, then total. Ten times over, so a quadratic step shows up as
   * something other than noise.
   */
  it('does a full screen render pass ten times over inside budget', () => {
    const elapsed = timed(() => {
      for (let i = 0; i < 10; i += 1) {
        const visible = sortInvoices(filterInvoices(ROWS, { today }), 'due');
        groupIntoRuns(visible);
        summariseUrgency(visible, today);
      }
    });

    expect(elapsed).toBeLessThan(BUDGET_MS * 10);
  });
});

/**
 * ARCHITECTURE §2 and the rule in HANDOFF §4.4: one array, one total. Every
 * figure on a screen comes from the same array the list renders.
 *
 * These are the invariant at scale. A total computed separately from the list
 * it sits under is the bug the notes call trust-destroying, and it is the kind
 * that only appears once there are enough rows for nobody to check by eye.
 */
describe('one array, one total — at two hundred rows', () => {
  it('the headline total is the sum of exactly the rows shown', () => {
    const visible = filterInvoices(ROWS, { today });
    expect(summarise(visible).total_cents).toBe(sumCents(onlyUnpaid(visible)));
  });

  it('holds under a business filter', () => {
    const businessId = ROWS[0]!.business_id;
    const visible = filterInvoices(ROWS, { today, businessId });

    expect(visible.length).toBeGreaterThan(0);
    expect(visible.length).toBeLessThan(ROWS.length);
    expect(summarise(visible).total_cents).toBe(sumCents(onlyUnpaid(visible)));
  });

  it('holds under a search, which is the filter most likely to drift', () => {
    const visible = searchInvoices(ROWS, 'bid');
    expect(summarise(visible).total_cents).toBe(sumCents(onlyUnpaid(visible)));
  });

  it('buckets partition the list — every row in exactly one', () => {
    const buckets = bucketByUrgency(ROWS, today);
    const counted =
      buckets.overdue.length + buckets.today.length + buckets.week.length + buckets.later.length;

    expect(counted).toBe(ROWS.length);

    const ids = new Set([
      ...buckets.overdue.map((row) => row.id),
      ...buckets.today.map((row) => row.id),
      ...buckets.week.map((row) => row.id),
      ...buckets.later.map((row) => row.id),
    ]);
    expect(ids.size).toBe(ROWS.length);
  });

  it('the two dashboard cards agree with the buckets under them', () => {
    const buckets = bucketByUrgency(ROWS, today);
    const cards = summariseUrgency(ROWS, today);

    expect(cards.overdue.total_cents).toBe(sumCents(onlyUnpaid(buckets.overdue)));
    expect(cards.next7.total_cents).toBe(
      sumCents(onlyUnpaid([...buckets.today, ...buckets.week])),
    );
  });

  it('per-business totals add up to the whole, and to their own rows', () => {
    const perBusiness = summariseByBusiness(ROWS, BUSINESSES, today);
    const summed = perBusiness.reduce((total, row) => total + row.total_cents, 0);

    expect(summed).toBe(summarise(ROWS).total_cents);
  });

  it('payment runs partition the list, and no invoice is in two', () => {
    const runs = groupIntoRuns(ROWS);
    const ids = runs.flatMap((run) => run.invoices.map((invoice) => invoice.id));

    expect(ids).toHaveLength(ROWS.length);
    expect(new Set(ids).size).toBe(ROWS.length);
  });

  it('a run total is the sum of its own unpaid rows, never of all of them', () => {
    for (const run of groupIntoRuns(ROWS)) {
      expect(run.total_cents).toBe(sumCents(onlyUnpaid(run.invoices)));
    }
  });
});
