import { describe, expect, it } from 'vitest';
import {
  adjustedCents,
  hasAdjustments,
  liveAdjustments,
  netCents,
  sumNetCents,
} from '@/lib/derive/adjustments';
import { summariseReceivable } from '@/lib/derive/receivables';
import type { SalesInvoiceAdjustment, SalesInvoiceRow } from '@/lib/types';

/**
 * J5's arithmetic. ARCHITECTURE §53.
 *
 * Every figure on Deli's side of the app flows through these four functions,
 * so the assertions below are mostly about the two states that would be
 * expensive to get wrong: a voided adjustment still counting, and a net that
 * could go below zero.
 */

function adj(over: Partial<SalesInvoiceAdjustment> = {}): SalesInvoiceAdjustment {
  return {
    id: 'a-1',
    sales_invoice_id: 'sv-1',
    kind: 'discount',
    amount_cents: 4_000,
    reason: 'short delivery',
    created_by: 'p-milan',
    created_at: '2026-09-01T02:00:00.000Z',
    voided_at: null,
    voided_by: null,
    void_reason: null,
    ...over,
  };
}

function sale(over: Partial<SalesInvoiceRow> = {}): SalesInvoiceRow {
  return {
    id: 'sv-1',
    business_id: 'b-ddl',
    customer_id: 'c-1',
    invoice_number: 'DDL-0001',
    invoice_date: '2026-08-28',
    due_date: '2026-09-11',
    amount_cents: 50_000,
    status: 'outstanding',
    received_at: null,
    received_by: null,
    payment_ref: null,
    void_reason: null,
    note: null,
    created_by: 'p-mani',
    created_at: '2026-08-28T02:00:00.000Z',
    updated_at: '2026-08-28T02:00:00.000Z',
    customer: { id: 'c-1', name: 'The Corner Cafe' },
    adjustments: [],
    ...over,
  };
}

describe('netCents', () => {
  it('is the full amount when nothing has been taken off', () => {
    expect(netCents(sale())).toBe(50_000);
    expect(adjustedCents(sale())).toBe(0);
    expect(hasAdjustments(sale())).toBe(false);
  });

  it('takes off a discount', () => {
    const row = sale({ adjustments: [adj()] });
    expect(adjustedCents(row)).toBe(4_000);
    expect(netCents(row)).toBe(46_000);
  });

  it('adds several together', () => {
    const row = sale({
      adjustments: [adj(), adj({ id: 'a-2', kind: 'refund', amount_cents: 1_000 })],
    });
    expect(netCents(row)).toBe(45_000);
  });

  it('treats a refund exactly like a discount, arithmetically', () => {
    /*
     * They are two different EVENTS -- one reduces what is owed before it is
     * settled, the other gives money back after -- and the distinction is for
     * whoever reads the invoice next year. Neither is a different sum.
     */
    const discount = sale({ adjustments: [adj({ kind: 'discount' })] });
    const refund = sale({ adjustments: [adj({ kind: 'refund' })] });
    expect(netCents(discount)).toBe(netCents(refund));
  });

  it('ignores a voided adjustment', () => {
    // Kept for ever (rule 5) and must never reach a figure. This is the one
    // that would be expensive: an undone discount still reducing the total.
    const row = sale({
      adjustments: [adj({ voided_at: '2026-09-02T02:00:00.000Z', voided_by: 'p-mani' })],
    });
    expect(liveAdjustments(row)).toHaveLength(0);
    expect(netCents(row)).toBe(50_000);
    expect(hasAdjustments(row)).toBe(false);
  });

  it('counts the live ones alongside a voided one', () => {
    const row = sale({
      adjustments: [
        adj({ id: 'a-1', voided_at: '2026-09-02T02:00:00.000Z', voided_by: 'p-mani' }),
        adj({ id: 'a-2', amount_cents: 500 }),
      ],
    });
    expect(netCents(row)).toBe(49_500);
  });

  it('never goes below nothing', () => {
    /*
     * `add_sales_adjustment` refuses an amount that would take an invoice
     * past zero, so this cannot happen through the app. Clamped anyway: a
     * negative receivable is a customer owing minus money, and that figure
     * would spread across every screen on Deli's side as a credit nobody
     * agreed to.
     */
    const row = sale({ adjustments: [adj({ amount_cents: 999_999 })] });
    expect(netCents(row)).toBe(0);
  });
});

describe('sumNetCents', () => {
  it('sums at the net, not the issued amount', () => {
    const rows = [
      sale({ id: 'sv-1', adjustments: [adj()] }),
      sale({ id: 'sv-2', amount_cents: 10_000, adjustments: [] }),
    ];
    expect(sumNetCents(rows)).toBe(56_000);
  });

  it('is zero for nothing', () => {
    expect(sumNetCents([])).toBe(0);
  });
});

describe('what customers owe', () => {
  const today = '2026-09-20';

  it('reports the net, not the paper figure', () => {
    /*
     * The change J5 makes to every receivable figure. An invoice for $500
     * with $40 off is $460 owed, and nobody will be chased for the other $40.
     */
    const summary = summariseReceivable([sale({ adjustments: [adj()] })], today);
    expect(summary.total_cents).toBe(46_000);
    expect(summary.invoice_count).toBe(1);
  });

  it('reports overdue at the net too', () => {
    // The overdue figure is the one somebody acts on, so it must not be the
    // one that is still quoting a discount nobody owes.
    const summary = summariseReceivable([sale({ adjustments: [adj()] })], today);
    expect(summary.overdue_cents).toBe(46_000);
    expect(summary.overdue_count).toBe(1);
  });

  it('still counts the invoice when it has been discounted to nothing', () => {
    /*
     * Zero owed is not the same as settled. The invoice is still outstanding
     * until somebody records that it was, and dropping it from the COUNT here
     * would make a list of one row sit under a heading saying none.
     */
    const summary = summariseReceivable(
      [sale({ adjustments: [adj({ amount_cents: 50_000 })] })],
      today,
    );
    expect(summary.total_cents).toBe(0);
    expect(summary.invoice_count).toBe(1);
  });
});
