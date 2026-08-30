import { describe, expect, it } from 'vitest';
import {
  ALL_SCOPE,
  businessForScope,
  filterByScope,
  isAll,
  isKnownScope,
  parseScope,
  scopeHref,
  scopeLabel,
  scopeShortLabel,
} from '@/lib/scope';
import { summariseByBusiness, summarise } from '@/lib/derive/select';
import { sumCents } from '@/lib/money';
import { BUSINESSES, FIXTURE_TODAY, makeInvoices } from '../fixtures/invoices';

const rows = makeInvoices(200);

describe('parseScope', () => {
  it('reads a business code, however it was typed', () => {
    expect(parseScope('gmh')).toBe('gmh');
    expect(parseScope('GMH')).toBe('gmh');
    expect(parseScope('  Gmh  ')).toBe('gmh');
  });

  it('treats nothing as Overall', () => {
    expect(parseScope(undefined)).toBe(ALL_SCOPE);
    expect(parseScope('')).toBe(ALL_SCOPE);
    expect(parseScope('   ')).toBe(ALL_SCOPE);
    expect(isAll(parseScope(undefined))).toBe(true);
  });
});

describe('isKnownScope', () => {
  /**
   * A URL somebody typed, or an old link to a business since deactivated, must
   * not silently show every business's invoices as though it were that one.
   * Getting this wrong shows Hurstville's total under Deli Delights' name.
   */
  it('accepts Overall and every real code', () => {
    expect(isKnownScope('all', BUSINESSES)).toBe(true);
    for (const business of BUSINESSES) {
      expect(isKnownScope(business.code.toLowerCase(), BUSINESSES)).toBe(true);
    }
  });

  it('rejects anything else', () => {
    for (const bogus of ['xyz', 'gm', 'gmhh', 'undefined', 'null']) {
      expect(isKnownScope(bogus, BUSINESSES)).toBe(false);
    }
  });
});

describe('filterByScope', () => {
  it('returns everything for Overall', () => {
    expect(filterByScope(rows, 'all', BUSINESSES)).toHaveLength(rows.length);
  });

  it('returns only that business', () => {
    for (const business of BUSINESSES) {
      const scoped = filterByScope(rows, business.code.toLowerCase(), BUSINESSES);
      expect(scoped.length).toBeGreaterThan(0);
      for (const row of scoped) expect(row.business_id).toBe(business.id);
    }
  });

  it('returns nothing rather than everything for an unknown scope', () => {
    // The dangerous failure is showing all four businesses under one name.
    expect(filterByScope(rows, 'xyz', BUSINESSES)).toHaveLength(0);
  });

  it('splits the invoices exactly — no row lost, none counted twice', () => {
    const perBusiness = BUSINESSES.flatMap((business) =>
      filterByScope(rows, business.code.toLowerCase(), BUSINESSES),
    );
    expect(perBusiness).toHaveLength(rows.length);
    expect(new Set(perBusiness.map((row) => row.id)).size).toBe(rows.length);
  });

  it('does not mutate the array it was given', () => {
    const snapshot = rows.map((row) => row.id);
    filterByScope(rows, 'gmh', BUSINESSES);
    expect(rows.map((row) => row.id)).toEqual(snapshot);
  });
});

describe('labels and links', () => {
  it('names the scope in full and in short', () => {
    expect(scopeLabel('all', BUSINESSES)).toBe('All businesses');
    expect(scopeShortLabel('all', BUSINESSES)).toBe('Overall');
    expect(scopeLabel('gmh', BUSINESSES)).toBe('GroceryMate Hurstville');
    expect(scopeShortLabel('gmh', BUSINESSES)).toBe('GMH');
  });

  it('says so rather than lying about an unknown scope', () => {
    expect(scopeLabel('xyz', BUSINESSES)).toBe('Unknown business');
    expect(businessForScope('xyz', BUSINESSES)).toBeNull();
  });

  it('builds readable links', () => {
    expect(scopeHref('all')).toBe('/b/all');
    expect(scopeHref('gmh')).toBe('/b/gmh');
  });
});

describe('summariseByBusiness', () => {
  const summaries = summariseByBusiness(rows, BUSINESSES, FIXTURE_TODAY);

  it('lists every business, including any owing nothing', () => {
    expect(summaries).toHaveLength(BUSINESSES.length);
    // A missing row is indistinguishable from a business nobody set up.
    const none = summariseByBusiness([], BUSINESSES, FIXTURE_TODAY);
    expect(none).toHaveLength(BUSINESSES.length);
    for (const entry of none) {
      expect(entry.total_cents).toBe(0);
      expect(entry.invoice_count).toBe(0);
    }
  });

  it('the per-business totals add up to the overall total', () => {
    // Notes §3: if these ever disagree, the dashboard is lying about money.
    const combined = summaries.reduce((sum, entry) => sum + entry.total_cents, 0);
    expect(combined).toBe(sumCents(rows));
    expect(combined).toBe(summarise(rows).total_cents);
  });

  it('each business total matches its own filtered list', () => {
    for (const entry of summaries) {
      const scoped = filterByScope(rows, entry.business.code.toLowerCase(), BUSINESSES);
      expect(entry.total_cents).toBe(sumCents(scoped));
      expect(entry.invoice_count).toBe(scoped.length);
    }
  });

  it('puts whoever is most overdue at the top', () => {
    for (let i = 1; i < summaries.length; i++) {
      expect(summaries[i - 1]!.overdue_cents).toBeGreaterThanOrEqual(summaries[i]!.overdue_cents);
    }
  });

  it('counts overdue against the day it was given, not today', () => {
    const early = summariseByBusiness(rows, BUSINESSES, '2026-01-01');
    for (const entry of early) expect(entry.overdue_count).toBe(0);
  });
});
