import { describe, expect, it } from 'vitest';
import {
  onlyOutstanding,
  receivableByCustomer,
  summariseReceivable,
} from '@/lib/derive/receivables';
import { summarise } from '@/lib/derive/select';
import { makeInvoices } from '../fixtures/invoices';
import type { SalesInvoiceRow } from '@/lib/types';

/**
 * What customers owe Deli Delights. ARCHITECTURE §17.
 *
 * The rule these stand over is the client's, given twice: what customers owe
 * must never move what the group owes. It holds structurally — receivables
 * live in their own table, their own query key, their own type and their own
 * derive module, so there is no call that takes both — and the last block
 * below is that stated as a test rather than as a comment.
 */

const TODAY = '2026-09-01';

function sale(over: Partial<SalesInvoiceRow> & { id: string }): SalesInvoiceRow {
  return {
    business_id: 'b-ddl',
    customer_id: 'c-1',
    invoice_number: null,
    invoice_date: '2026-08-01',
    due_date: '2026-09-15',
    amount_cents: 10_000,
    status: 'outstanding',
    received_at: null,
    received_by: null,
    payment_ref: null,
    void_reason: null,
    created_by: 'p-mani',
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    customer: { id: 'c-1', name: 'Harris Farm Markets' },
    ...over,
  };
}

const ROWS: SalesInvoiceRow[] = [
  sale({ id: 'a', amount_cents: 50_000, due_date: '2026-08-10' }), // late
  sale({ id: 'b', amount_cents: 30_000, due_date: '2026-08-25' }), // late
  sale({ id: 'c', amount_cents: 20_000, due_date: '2026-09-20' }), // not yet
  sale({ id: 'd', amount_cents: 99_000, status: 'received', received_at: '2026-08-30T00:00:00Z', received_by: 'p-mani' }),
  sale({ id: 'e', amount_cents: 77_000, status: 'void', void_reason: 'sent twice' }),
];

describe('what is still owed to us', () => {
  it('counts only what is outstanding', () => {
    expect(onlyOutstanding(ROWS).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('totals it, and says how much is late', () => {
    const owed = summariseReceivable(ROWS, TODAY);
    expect(owed.total_cents).toBe(100_000);
    expect(owed.invoice_count).toBe(3);
    expect(owed.overdue_cents).toBe(80_000);
    expect(owed.overdue_count).toBe(2);
  });

  it('leaves received and void money out of both figures', () => {
    // 99,000 received and 77,000 voided. If either leaked, the total would be
    // 199,000 or 177,000 rather than 100,000.
    const owed = summariseReceivable(ROWS, TODAY);
    const everything = ROWS.reduce((sum, row) => sum + row.amount_cents, 0);

    expect(owed.total_cents).toBe(100_000);
    expect(owed.total_cents).toBeLessThan(everything);
    expect(owed.overdue_cents).toBe(80_000);
  });

  it('names the oldest thing outstanding — how long this has been going on', () => {
    expect(summariseReceivable(ROWS, TODAY).oldest_due).toBe('2026-08-10');
  });

  it('is all zero and null when there is nothing owed', () => {
    const none = summariseReceivable([ROWS[3]!], TODAY);
    expect(none.total_cents).toBe(0);
    expect(none.invoice_count).toBe(0);
    expect(none.oldest_due).toBeNull();
  });

  it('splits by customer without losing a cent', () => {
    const two = [...ROWS, sale({ id: 'f', customer_id: 'c-2', amount_cents: 15_000 })];
    const byCustomer = receivableByCustomer(two, TODAY);

    expect(byCustomer.get('c-1')!.total_cents).toBe(100_000);
    expect(byCustomer.get('c-2')!.total_cents).toBe(15_000);

    const summed = [...byCustomer.values()].reduce((s, r) => s + r.total_cents, 0);
    expect(summed).toBe(summariseReceivable(two, TODAY).total_cents);
  });

  it('leaves a customer who owes nothing out of the map entirely', () => {
    // So the list can show a figure only where there is one, rather than $0.00
    // beside everybody who has ever bought anything.
    expect(receivableByCustomer([ROWS[3]!], TODAY).size).toBe(0);
  });
});

describe('the client’s condition: money in never moves money out', () => {
  it('shares no function with the payables side', () => {
    /*
     * summarise() takes InvoiceRow and reads `status === 'unpaid'`; a sales
     * invoice is never 'unpaid', it is 'outstanding'. So even if one were
     * forced through by a cast, it would contribute nothing rather than
     * silently inflating the group's owing.
     */
    const forced = ROWS as unknown as Parameters<typeof summarise>[0];
    expect(summarise(forced).total_cents).toBe(0);
    expect(summarise(forced).invoice_count).toBe(0);
  });

  it('leaves the payables total exactly what the invoices alone say', () => {
    const invoices = makeInvoices(30);
    const owed = summarise(invoices);
    expect(owed.total_cents).toBe(
      invoices.reduce((sum, row) => sum + row.amount_cents, 0),
    );
  });
});
