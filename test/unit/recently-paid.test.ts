import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearRecentlyPaid,
  forgetPaid,
  mergeRecentlyPaid,
  recentlyPaidSnapshot,
  rememberPaid,
} from '@/lib/recently-paid';
import { groupIntoRuns } from '@/lib/derive/runs';
import { onlyUnpaid, summarise } from '@/lib/derive/select';
import { FIXTURE_TODAY, makeInvoices } from '../fixtures/invoices';
import type { InvoiceRow } from '@/lib/types';

/**
 * "Ticking one off is erasing both."
 *
 * Reported from a real phone, and the database was never wrong:
 * `mark_invoices_paid` only touches the ids it is handed. The row was wrong
 * about what had happened.
 *
 * Two invoices from one supplier sharing a due date collapse into a payment
 * run. Tick one, the refetch drops it, the run falls to a single invoice — and
 * a run of one does not render as an expanded group at all, it renders as one
 * plain row somewhere else in the list. Both children left the screen and only
 * one had been paid.
 *
 * The fix keeps the paid invoice on screen, which means it is now sitting in
 * the array every total is computed from. So the other half of this file is
 * the invariant that buys: a paid row must reach no figure anywhere.
 */

const [a, b] = makeInvoices(2);
const supplierRun: InvoiceRow[] = [
  { ...a!, id: 'run-1', supplier_id: 's-0', due_date: FIXTURE_TODAY, amount_cents: 10_000 },
  { ...b!, id: 'run-2', supplier_id: 's-0', due_date: FIXTURE_TODAY, amount_cents: 25_000 },
];

const paid = (row: InvoiceRow): InvoiceRow => ({ ...row, status: 'paid' });

beforeEach(() => clearRecentlyPaid());

describe('the run does not collapse when one of it is paid', () => {
  it('groups two same-supplier same-due invoices into one run', () => {
    // The precondition. Without this the bug cannot happen and the rest of
    // this file proves nothing.
    expect(groupIntoRuns(supplierRun)).toHaveLength(1);
    expect(groupIntoRuns(supplierRun)[0]!.invoices).toHaveLength(2);
  });

  it('keeps both invoices in the run after one is ticked', () => {
    rememberPaid([paid(supplierRun[0]!)]);

    // What the server now returns: only the one still unpaid.
    const fromServer = [supplierRun[1]!];
    const onScreen = mergeRecentlyPaid(fromServer, recentlyPaidSnapshot());

    const runs = groupIntoRuns(onScreen);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.invoices).toHaveLength(2);
    expect(runs[0]!.invoices.filter((i) => i.status === 'paid')).toHaveLength(1);
  });

  it('counts only what is still owed in the run total', () => {
    rememberPaid([paid(supplierRun[0]!)]);
    const onScreen = mergeRecentlyPaid([supplierRun[1]!], recentlyPaidSnapshot());

    // 10,000 has been paid; 25,000 has not.
    expect(groupIntoRuns(onScreen)[0]!.total_cents).toBe(25_000);
  });
});

describe('a paid row on screen reaches no figure', () => {
  it('is left out of the headline total and both counts', () => {
    const onScreen = [supplierRun[1]!, paid(supplierRun[0]!)];
    const summary = summarise(onScreen);

    expect(summary.total_cents).toBe(25_000);
    expect(summary.invoice_count).toBe(1);
    expect(summary.supplier_count).toBe(1);
  });

  it('leaves the total exactly where it was before the row was added back', () => {
    const owed = [supplierRun[1]!];
    expect(summarise(mergeRecentlyPaid(owed, new Map([['x', paid(supplierRun[0]!)]])))).toEqual(
      summarise(owed),
    );
  });

  it('onlyUnpaid drops every non-unpaid status', () => {
    const rows = [
      supplierRun[0]!,
      paid(supplierRun[1]!),
      { ...supplierRun[1]!, id: 'v', status: 'void' as const },
    ];
    expect(onlyUnpaid(rows).map((r) => r.id)).toEqual([supplierRun[0]!.id]);
  });
});

describe('the store itself', () => {
  it('the server wins when a row comes back unpaid', () => {
    // Somebody un-ticked it on another device. Theirs is the true row.
    rememberPaid([paid(supplierRun[0]!)]);
    const merged = mergeRecentlyPaid([supplierRun[0]!], recentlyPaidSnapshot());

    expect(merged).toHaveLength(1);
    expect(merged[0]!.status).toBe('unpaid');
  });

  it('forgets one when it is undone', () => {
    rememberPaid([paid(supplierRun[0]!), paid(supplierRun[1]!)]);
    forgetPaid(supplierRun[0]!.id);

    expect([...recentlyPaidSnapshot().keys()]).toEqual([supplierRun[1]!.id]);
  });

  it('hands back a new map rather than mutating the old one', () => {
    // useSyncExternalStore compares snapshots by identity; mutating in place
    // means the screen never hears about it.
    const before = recentlyPaidSnapshot();
    rememberPaid([paid(supplierRun[0]!)]);
    expect(recentlyPaidSnapshot()).not.toBe(before);
    expect(before.size).toBe(0);
  });

  it('does not churn the array when nothing has been paid', () => {
    const rows = [supplierRun[0]!];
    expect(mergeRecentlyPaid(rows, new Map())).toEqual(rows);
  });
});
