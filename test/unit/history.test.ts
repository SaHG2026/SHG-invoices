import { describe, expect, it } from 'vitest';
import {
  buildHistorySearch,
  outstandingFor,
  spendByMonth,
  spendTotal,
} from '@/lib/derive/history';
import { SUPPLIERS, makeInvoices } from '../fixtures/invoices';
import type { Invoice, Supplier } from '@/lib/types';

/**
 * History is the one list filtered by the database rather than in the browser,
 * because it grows without bound. That means turning what somebody typed into
 * a query string — and a query string built from user input is exactly where
 * care is owed.
 */

describe('buildHistorySearch', () => {
  it('searches the invoice number and the internal reference', () => {
    const { or } = buildHistorySearch('INV-1234', SUPPLIERS);
    expect(or).toContain('invoice_number.ilike.*INV-1234*');
    expect(or).toContain('internal_ref.ilike.*INV-1234*');
  });

  it('resolves supplier names to ids, so "bid" finds Bidfood', () => {
    // The word "bid" appears nowhere on an invoice row; the supplier list is
    // small and cached, so the match happens here rather than in a join.
    const { or, supplierIds } = buildHistorySearch('bid', SUPPLIERS);
    const bidfood = SUPPLIERS.find((s) => s.name === 'Bidfood')!;

    expect(supplierIds).toContain(bidfood.id);
    expect(or).toContain(`supplier_id.in.(${supplierIds.join(',')})`);
  });

  it('searches by amount, however it was typed — spec §7.7', () => {
    for (const query of ['5220', '5,220.00', '$5,220.00']) {
      expect(buildHistorySearch(query, SUPPLIERS).or).toContain('amount_cents.eq.522000');
    }
  });

  it('does not add an amount clause for something that is not a number', () => {
    expect(buildHistorySearch('Bidfood', SUPPLIERS).or).not.toContain('amount_cents');
  });

  it('returns nothing to filter on for a blank query', () => {
    for (const query of ['', '   ', '\t']) {
      expect(buildHistorySearch(query, SUPPLIERS)).toEqual({ or: null, supplierIds: [] });
    }
  });

  describe('cannot be broken out of', () => {
    /**
     * The `or=(a.ilike.*x*,b.eq.1)` syntax is comma and parenthesis delimited.
     * A supplier called "Smith, Jones & Co", or a stray bracket, would change
     * the SHAPE of the query rather than the value being searched for.
     */
    it('strips the delimiters from whatever was typed', () => {
      const { or } = buildHistorySearch('a,b(c)d*e', SUPPLIERS);
      const value = or!.split('invoice_number.ilike.*')[1]!.split('*')[0]!;
      expect(value).not.toMatch(/[,()*]/);
    });

    it('produces a balanced clause list for hostile input', () => {
      for (const nasty of [
        'x,amount_cents.gt.0',
        'a)or(b',
        '*',
        ',,,,',
        '(((',
        "'; drop table invoices; --",
      ]) {
        const { or } = buildHistorySearch(nasty, SUPPLIERS);
        if (or === null) continue;
        // Every clause is still `column.operator.value`, and the only commas
        // are the ones separating clauses we generated.
        const generated = or.split(',').filter((part) => !/^[0-9a-f-]{2,}\)?$/i.test(part));
        for (const clause of generated) {
          expect(clause).toMatch(/^[a-z_]+\.(ilike|eq|in)\./);
        }
      }
    });

    it('keeps a supplier whose name contains a comma out of the shape', () => {
      const awkward: Supplier[] = [
        { ...SUPPLIERS[0]!, id: 's-comma', name: 'Smith, Jones & Co' },
      ];
      const { or, supplierIds } = buildHistorySearch('Smith Jones', awkward);
      // Stripping the comma from the query means it no longer matches the
      // name — a small loss of precision, and no chance of a broken query.
      expect(supplierIds).toHaveLength(0);
      expect(or).not.toContain('Smith,');
    });
  });
});

describe('spendByMonth — spec §7.5', () => {
  const invoices = makeInvoices(200) as unknown as Invoice[];

  it('gives exactly six months, oldest first', () => {
    const spend = spendByMonth(invoices, '2026-08-28');
    expect(spend).toHaveLength(6);
    expect(spend.map((m) => m.month)).toEqual([
      '2026-03',
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
    ]);
  });

  it('counts backwards over a year boundary', () => {
    // Month arithmetic, not day arithmetic — months are not 30 days long.
    const spend = spendByMonth([], '2026-02-15');
    expect(spend.map((m) => m.month)).toEqual([
      '2025-09',
      '2025-10',
      '2025-11',
      '2025-12',
      '2026-01',
      '2026-02',
    ]);
  });

  it('keeps empty months rather than skipping them', () => {
    // A sparkline that silently drops months lies about its own x-axis.
    const spend = spendByMonth([], '2026-08-28');
    expect(spend).toHaveLength(6);
    expect(spendTotal(spend)).toBe(0);
  });

  it('counts by invoice date, not payment date', () => {
    // "How much do we buy from them" is decided when the goods are invoiced.
    // Paying two months late must not move the spend into the wrong month.
    const invoice = {
      ...invoices[0]!,
      invoice_date: '2026-06-10',
      due_date: '2026-06-24',
      paid_at: '2026-08-30T00:00:00.000Z',
      status: 'paid' as const,
      amount_cents: 100_000,
    };
    const spend = spendByMonth([invoice], '2026-08-28');

    expect(spend.find((m) => m.month === '2026-06')!.total_cents).toBe(100_000);
    expect(spend.find((m) => m.month === '2026-08')!.total_cents).toBe(0);
  });

  it('leaves voided invoices out — they drop from every total', () => {
    const voided = {
      ...invoices[0]!,
      invoice_date: '2026-08-10',
      status: 'void' as const,
      amount_cents: 999_999,
    };
    expect(spendTotal(spendByMonth([voided], '2026-08-28'))).toBe(0);
  });

  it('labels each month readably', () => {
    const spend = spendByMonth([], '2026-08-28');
    expect(spend.map((m) => m.label)).toEqual(['Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug']);
  });
});

describe('outstandingFor', () => {
  const invoices = makeInvoices(20) as unknown as Invoice[];

  it('counts only unpaid invoices', () => {
    const mixed: Invoice[] = [
      { ...invoices[0]!, status: 'unpaid', amount_cents: 100 },
      { ...invoices[1]!, status: 'paid', amount_cents: 500 },
      { ...invoices[2]!, status: 'void', amount_cents: 900 },
    ];
    const result = outstandingFor(mixed);
    expect(result.total_cents).toBe(100);
    expect(result.count).toBe(1);
  });

  it('reports the oldest due date, for chasing', () => {
    const mixed: Invoice[] = [
      { ...invoices[0]!, status: 'unpaid', due_date: '2026-09-11' },
      { ...invoices[1]!, status: 'unpaid', due_date: '2026-08-14' },
      { ...invoices[2]!, status: 'unpaid', due_date: '2026-10-01' },
    ];
    expect(outstandingFor(mixed).oldest_due).toBe('2026-08-14');
  });

  it('is zero rather than NaN when nothing is outstanding', () => {
    expect(outstandingFor([])).toEqual({ total_cents: 0, count: 0, oldest_due: null });
  });
});
