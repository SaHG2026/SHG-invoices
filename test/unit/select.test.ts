import { describe, expect, it } from 'vitest';
import { filterInvoices, searchInvoices, sortInvoices, summarise } from '@/lib/derive/select';
import { groupIntoRuns, runInvoiceIds } from '@/lib/derive/runs';
import { sumCents } from '@/lib/money';
import { BUSINESSES, FIXTURE_TODAY, SUPPLIERS, makeInvoices } from '../fixtures/invoices';

const rows = makeInvoices(200);

describe('the sticky footer total — notes §3', () => {
  /**
   * "A total that silently shows everything while the list shows a subset is
   * a trust-destroying bug that looks like a display glitch."
   *
   * The defence is architectural: the total is computed from the same array
   * the list renders. These tests assert that across every filter the screen
   * can produce, so a future refactor that reintroduces a separate total
   * query fails here.
   */
  it('equals the filtered list, for every business filter', () => {
    for (const business of [null, ...BUSINESSES.map((b) => b.id)]) {
      const filtered = filterInvoices(rows, { businessId: business });
      expect(summarise(filtered).total_cents).toBe(sumCents(filtered));
    }
  });

  it('equals the filtered list, for every supplier filter', () => {
    for (const supplier of SUPPLIERS) {
      const filtered = filterInvoices(rows, { supplierId: supplier.id });
      expect(summarise(filtered).total_cents).toBe(sumCents(filtered));
    }
  });

  it('equals the filtered list for combined and overdue-only filters', () => {
    for (const business of BUSINESSES) {
      for (const supplier of SUPPLIERS.slice(0, 4)) {
        const filtered = filterInvoices(rows, {
          businessId: business.id,
          supplierId: supplier.id,
          overdueOnly: true,
          today: FIXTURE_TODAY,
        });
        expect(summarise(filtered).total_cents).toBe(sumCents(filtered));
      }
    }
  });

  it('is unaffected by sorting', () => {
    const filtered = filterInvoices(rows, { businessId: BUSINESSES[0]!.id });
    const before = summarise(filtered).total_cents;
    for (const key of ['due', 'supplier', 'amount', 'added'] as const) {
      expect(sumCents(sortInvoices(filtered, key))).toBe(before);
    }
  });

  it('is zero, not NaN, when a filter matches nothing', () => {
    const filtered = filterInvoices(rows, { supplierId: 'nobody' });
    expect(filtered).toHaveLength(0);
    expect(summarise(filtered).total_cents).toBe(0);
    expect(summarise(filtered).supplier_count).toBe(0);
  });
});

describe('filterInvoices', () => {
  it('refuses to guess what "overdue" means', () => {
    // Urgency is never self-derived — `today` must be handed in.
    expect(() => filterInvoices(rows, { overdueOnly: true })).toThrow(/today/);
  });

  it('filters by due-date range inclusively', () => {
    const filtered = filterInvoices(rows, { dueFrom: '2026-08-28', dueTo: '2026-09-04' });
    for (const row of filtered) {
      expect(row.due_date >= '2026-08-28').toBe(true);
      expect(row.due_date <= '2026-09-04').toBe(true);
    }
  });

  it('treats a null business as "All businesses"', () => {
    expect(filterInvoices(rows, { businessId: null })).toHaveLength(rows.length);
  });
});

describe('sortInvoices', () => {
  it('does not mutate the cached array', () => {
    const snapshot = rows.map((r) => r.id);
    sortInvoices(rows, 'amount');
    expect(rows.map((r) => r.id)).toEqual(snapshot);
  });

  it('keeps every invoice in every sort', () => {
    for (const key of ['due', 'supplier', 'amount', 'added'] as const) {
      expect(sortInvoices(rows, key)).toHaveLength(rows.length);
    }
  });

  it('sorts amount largest first', () => {
    const sorted = sortInvoices(rows, 'amount');
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]!.amount_cents <= sorted[i - 1]!.amount_cents).toBe(true);
    }
  });

  it('sorts due date earliest first', () => {
    const sorted = sortInvoices(rows, 'due');
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]!.due_date >= sorted[i - 1]!.due_date).toBe(true);
    }
  });
});

describe('groupIntoRuns — spec §6', () => {
  const runs = groupIntoRuns(rows);

  it('collapses only invoices sharing both supplier and due date', () => {
    for (const run of runs) {
      for (const invoice of run.invoices) {
        expect(invoice.supplier_id).toBe(run.supplier.id);
        expect(invoice.due_date).toBe(run.due_date);
      }
    }
  });

  it('loses no invoice and duplicates none', () => {
    const ids = runs.flatMap(runInvoiceIds);
    expect(ids).toHaveLength(rows.length);
    expect(new Set(ids).size).toBe(rows.length);
  });

  it('actually groups something — the fixture has real collisions', () => {
    expect(runs.length).toBeLessThan(rows.length);
    expect(runs.some((run) => run.invoices.length > 1)).toBe(true);
  });

  it('run totals sum to the same figure as the flat list', () => {
    expect(sumCents(runs.flatMap((r) => r.invoices))).toBe(sumCents(rows));
    expect(runs.reduce((acc, run) => acc + run.total_cents, 0)).toBe(sumCents(rows));
  });

  it('orders runs by due date', () => {
    for (let i = 1; i < runs.length; i++) {
      expect(runs[i]!.due_date >= runs[i - 1]!.due_date).toBe(true);
    }
  });
});

describe('summarise', () => {
  it('counts distinct suppliers, not invoices', () => {
    const summary = summarise(rows);
    expect(summary.invoice_count).toBe(200);
    expect(summary.supplier_count).toBeLessThanOrEqual(SUPPLIERS.length);
    expect(summary.supplier_count).toBeGreaterThan(1);
  });
});

describe('searchInvoices', () => {
  /**
   * Somebody looking for an invoice half-remembers it. The search has to work
   * from a fragment of a supplier name and a fragment of a number, typed
   * together, in either order.
   */
  it('finds by supplier name, however partial', () => {
    for (const query of ['bidfood', 'Bidfood', 'bid', 'food']) {
      const found = searchInvoices(rows, query);
      expect(found.length).toBeGreaterThan(0);
      for (const row of found) {
        expect(row.supplier.name.toLowerCase()).toContain(query.toLowerCase());
      }
    }
  });

  it('finds by invoice number', () => {
    const withNumber = rows.find((row) => row.invoice_number !== null)!;
    const found = searchInvoices(rows, withNumber.invoice_number!);
    expect(found.map((row) => row.id)).toContain(withNumber.id);
  });

  it('finds by the internal reference, though it is no longer displayed', () => {
    // It is the only guaranteed-unique handle, so it stays searchable — for
    // finding an invoice from a bank statement or an older note.
    const target = rows[5]!;
    expect(searchInvoices(rows, target.internal_ref).map((row) => row.id)).toContain(target.id);
  });

  it('needs every word to match, not the whole phrase', () => {
    const target = rows.find((row) => row.invoice_number !== null)!;
    const query = `${target.supplier.name.slice(0, 3)} ${target.invoice_number}`;

    const found = searchInvoices(rows, query);
    expect(found.map((row) => row.id)).toContain(target.id);
    // Words in either order find the same thing.
    const reversed = searchInvoices(rows, query.split(' ').reverse().join(' '));
    expect(reversed.map((row) => row.id)).toEqual(found.map((row) => row.id));
  });

  it('finds by business code', () => {
    const found = searchInvoices(rows, 'gmh');
    expect(found.length).toBeGreaterThan(0);
    for (const row of found) expect(row.business.code).toBe('GMH');
  });

  it('returns everything for an empty or blank query', () => {
    for (const query of ['', '   ', '\t']) {
      expect(searchInvoices(rows, query)).toHaveLength(rows.length);
    }
  });

  it('returns nothing for a query that matches nothing', () => {
    expect(searchInvoices(rows, 'zzzzzzzz')).toHaveLength(0);
  });

  it('does not mutate the array it was given', () => {
    const snapshot = rows.map((row) => row.id);
    searchInvoices(rows, 'bid');
    expect(rows.map((row) => row.id)).toEqual(snapshot);
  });

  it('survives an invoice with no number', () => {
    const withoutNumber = rows.filter((row) => row.invoice_number === null);
    expect(withoutNumber.length).toBeGreaterThan(0);
    expect(() => searchInvoices(withoutNumber, 'anything')).not.toThrow();
  });
});
