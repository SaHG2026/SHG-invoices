import { describe, expect, it } from 'vitest';
import { canCreateSupplier, rankSuppliers } from '@/lib/derive/supplier-match';
import { SUPPLIERS } from '../fixtures/invoices';
import type { Supplier } from '@/lib/types';

/**
 * The type-ahead is the biggest single lever on the fifteen-second target.
 * Typing "Bhatbhateni Imports" costs about five seconds on a phone; picking it
 * from three letters costs under one. So what matters is not that the right
 * supplier appears somewhere in the list — it is that it appears FIRST, from
 * the two or three characters someone will actually type.
 *
 * These assert position, not membership.
 */

const names = (list: Supplier[]) => list.map((s) => s.name);
const id = (name: string) => SUPPLIERS.find((s) => s.name === name)!.id;

describe('rankSuppliers with a query', () => {
  it('puts an exact prefix first — "bid" finds Bidfood before Bidvest', () => {
    expect(names(rankSuppliers(SUPPLIERS, 'bid'))[0]).toBe('Bidfood');
    expect(names(rankSuppliers(SUPPLIERS, 'bid'))).toContain('Bidvest');
  });

  it('is case-insensitive', () => {
    expect(names(rankSuppliers(SUPPLIERS, 'BIDF'))[0]).toBe('Bidfood');
    expect(names(rankSuppliers(SUPPLIERS, 'bIdF'))[0]).toBe('Bidfood');
  });

  it('matches on a word that is not the first — "food" finds PFD Food Services', () => {
    expect(names(rankSuppliers(SUPPLIERS, 'food'))).toContain('PFD Food Services');
  });

  it('survives dropped letters, because thumbs drop letters', () => {
    // "bdf" is Bidfood with the vowels missed.
    expect(names(rankSuppliers(SUPPLIERS, 'bdf'))).toContain('Bidfood');
    // "hmly" for Himalayan.
    expect(names(rankSuppliers(SUPPLIERS, 'hmly'))).toContain('Himalayan Wholesale');
  });

  it('finds the long awkward names from three letters', () => {
    expect(names(rankSuppliers(SUPPLIERS, 'bha'))[0]).toBe('Bhatbhateni Imports');
    expect(names(rankSuppliers(SUPPLIERS, 'eve'))[0]).toBe('Everest Spice Traders');
    expect(names(rankSuppliers(SUPPLIERS, 'riv'))[0]).toBe('Riverina Meats');
  });

  it('returns nothing for a query that matches nothing', () => {
    expect(rankSuppliers(SUPPLIERS, 'zzzzzz')).toHaveLength(0);
  });

  it('never shows more than the limit — the list sits above a keyboard', () => {
    expect(rankSuppliers(SUPPLIERS, 'e').length).toBeLessThanOrEqual(5);
    expect(rankSuppliers(SUPPLIERS, 'e', { limit: 3 })).toHaveLength(3);
  });

  it('breaks a genuine tie by what this device used recently', () => {
    // "Bidfood" and "Bidvest" are the same length and share the same prefix,
    // so they score identically — there is no better answer available from the
    // text alone. The one used yesterday is the better guess.
    expect(names(rankSuppliers(SUPPLIERS, 'bid'))[0]).toBe('Bidfood');
    expect(names(rankSuppliers(SUPPLIERS, 'bid', { recentIds: [id('Bidvest')] }))[0]).toBe(
      'Bidvest',
    );
  });

  it('does not let recency beat a genuinely better match', () => {
    // "an" is a prefix of Anchor Dairy but only a substring of Himalayan
    // Wholesale. Recency is a tie-breaker, not a thumb on the scale.
    const ranked = names(
      rankSuppliers(SUPPLIERS, 'an', { recentIds: [id('Himalayan Wholesale')] }),
    );
    expect(ranked[0]).toBe('Anchor Dairy');
    expect(ranked).toContain('Himalayan Wholesale');
  });

  it('ignores leading and trailing spaces', () => {
    expect(names(rankSuppliers(SUPPLIERS, '  bid  '))[0]).toBe('Bidfood');
  });
});

describe('rankSuppliers with no query', () => {
  it('shows recently used suppliers first, in the order they were used', () => {
    const recent = [id('Anchor Dairy'), id('Riverina Meats')];
    expect(names(rankSuppliers(SUPPLIERS, '', { recentIds: recent })).slice(0, 2)).toEqual([
      'Anchor Dairy',
      'Riverina Meats',
    ]);
  });

  it('falls back to alphabetical when nothing has been used yet', () => {
    const listed = names(rankSuppliers(SUPPLIERS, '', { limit: 3 }));
    expect(listed).toEqual([...listed].sort((a, b) => a.localeCompare(b)));
  });

  it('caps at five, per spec §7.3', () => {
    expect(rankSuppliers(SUPPLIERS, '')).toHaveLength(5);
  });
});

describe('inactive suppliers', () => {
  const withInactive: Supplier[] = [
    ...SUPPLIERS,
    { ...SUPPLIERS[0]!, id: 's-gone', name: 'Closed Down Foods', active: false },
  ];

  it('never appear in the type-ahead — spec §7.8', () => {
    expect(names(rankSuppliers(withInactive, 'closed'))).not.toContain('Closed Down Foods');
    expect(names(rankSuppliers(withInactive, ''))).not.toContain('Closed Down Foods');
  });

  it('do not block creating a new supplier with the same name', () => {
    expect(canCreateSupplier(withInactive, 'Closed Down Foods')).toBe(true);
  });
});

describe('canCreateSupplier', () => {
  it('offers to create a name that does not exist', () => {
    expect(canCreateSupplier(SUPPLIERS, 'New Wholesaler')).toBe(true);
  });

  it('does not offer a name that already exists, whatever the case', () => {
    // suppliers_name_ci is a unique index, so the insert would fail anyway.
    // Better not to offer than to offer and fail.
    expect(canCreateSupplier(SUPPLIERS, 'Bidfood')).toBe(false);
    expect(canCreateSupplier(SUPPLIERS, 'bidfood')).toBe(false);
    expect(canCreateSupplier(SUPPLIERS, '  BIDFOOD  ')).toBe(false);
  });

  it('stays quiet until there is enough typed to be a name', () => {
    expect(canCreateSupplier(SUPPLIERS, '')).toBe(false);
    expect(canCreateSupplier(SUPPLIERS, 'b')).toBe(false);
    expect(canCreateSupplier(SUPPLIERS, 'bi')).toBe(true);
  });
});
