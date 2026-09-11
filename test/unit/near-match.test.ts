import { describe, expect, it } from 'vitest';
import { findNearMatches, normaliseName } from '@/lib/derive/near-match';

/**
 * The case this exists for, in the client's own words:
 *
 *   "there is a supplier by the name Global Foods Department and a manager
 *   enters it as its full name. but another manager has been entering it as
 *   GFD."
 *
 * The unique index catches character-for-character repeats and nothing else.
 * Everything below is something it lets through.
 *
 * Two properties are asserted throughout and they pull against each other:
 * it must catch the shortenings and misspellings people actually type, and it
 * must leave two genuinely different businesses alone. The second half is the
 * one that gets forgotten, so there are as many tests of it as of the first.
 */

const supplier = (name: string) => ({ id: name, name });

const EXISTING = [
  supplier('Global Foods Department'),
  supplier('Bidfood'),
  supplier('PFD Food Services'),
  supplier('Sydney Seafoods Pty Ltd'),
  supplier('Himalaya Spice House'),
].map((entry) => ({ ...entry, active: true }));

const matched = (candidate: string) =>
  findNearMatches(EXISTING, candidate).map((match) => match.entry.name);

describe('normaliseName', () => {
  it('drops case, punctuation and company noise', () => {
    expect(normaliseName('Global Foods Pty. Ltd.')).toBe('global foods');
    expect(normaliseName('  GLOBAL   FOODS  ')).toBe('global foods');
  });

  it('spells out an ampersand rather than dropping it', () => {
    expect(normaliseName('Tom & Jerry')).toBe('tom jerry');
    expect(normaliseName('Tom and Jerry')).toBe('tom jerry');
  });

  it('leaves a name that is only noise words as empty', () => {
    expect(normaliseName('The Company')).toBe('');
  });
});

describe('the initials case — the one that was asked about', () => {
  it('catches GFD against Global Foods Department', () => {
    expect(matched('GFD')).toContain('Global Foods Department');
  });

  it('catches it the other way round too', () => {
    const existing = [{ id: 'a', name: 'GFD', active: true }];
    expect(findNearMatches(existing, 'Global Foods Department')).toHaveLength(1);
  });

  it('says why, so the dialog can explain itself', () => {
    expect(findNearMatches(EXISTING, 'GFD')[0]?.reason).toBe('initials');
  });

  it('is not confused by punctuation in the initials', () => {
    expect(matched('G.F.D.')).toContain('Global Foods Department');
  });
});

describe('the same name written differently', () => {
  it('catches a company suffix added', () => {
    expect(matched('Bidfood Pty Ltd')).toContain('Bidfood');
  });

  it('catches punctuation and spacing differences', () => {
    expect(matched('Bid-food')).toContain('Bidfood');
  });
});

describe('a longer or shorter version of the same name', () => {
  it('catches the full name when the short one exists', () => {
    expect(matched('Bidfood Australia')).toContain('Bidfood');
  });

  it('catches the short name when the full one exists', () => {
    expect(matched('Global Foods')).toContain('Global Foods Department');
  });

  it('matches whole words only — "foods" is not "Sydney Seafoods"', () => {
    // "Seafoods" ends with "foods" and is a different business.
    expect(matched('Foods')).not.toContain('Sydney Seafoods Pty Ltd');
  });
});

describe('a misspelling', () => {
  it('catches one letter wrong in a long name', () => {
    expect(matched('Bidfoods')).toContain('Bidfood');
  });

  it('catches two letters wrong in a longer one', () => {
    expect(matched('Himalya Spice Hous')).toContain('Himalaya Spice House');
  });

  it('leaves short names alone, where two letters is most of the word', () => {
    const existing = [{ id: 'a', name: 'Coles', active: true }];
    // Three letters different out of five. Not a typo, a different shop.
    expect(findNearMatches(existing, 'Coops')).toHaveLength(0);
  });
});

describe('what it must NOT flag', () => {
  it('leaves two genuinely different suppliers alone', () => {
    expect(matched('Bhatbhateni Imports')).toHaveLength(0);
  });

  it('does not flag on one or two characters typed', () => {
    expect(matched('B')).toHaveLength(0);
  });

  it('does not flag a name that shares only a common word', () => {
    expect(matched('Melbourne Spice Traders')).toHaveLength(0);
  });

  it('returns nothing against an empty list', () => {
    expect(findNearMatches([], 'Anything')).toHaveLength(0);
  });

  it('ignores an existing entry whose name is all noise', () => {
    const existing = [{ id: 'a', name: 'The Company', active: true }];
    expect(findNearMatches(existing, 'Ltd')).toHaveLength(0);
  });
});

describe('what comes back', () => {
  it('puts the surest reason first', () => {
    const existing = [
      { id: 'spelling', name: 'Global Foods Departmnt', active: true },
      { id: 'same', name: 'G.F.D', active: true },
    ];
    // "GFD" is the same name as "G.F.D" once punctuation is gone, and is a
    // misspelling of neither. The exact-after-normalising one leads.
    expect(findNearMatches(existing, 'GFD')[0]?.entry.id).toBe('same');
  });

  it('caps how many it shows — a dialog is read, not scrolled', () => {
    const many = Array.from({ length: 12 }, (_, index) => ({
      id: String(index),
      name: `Global Foods Department ${index}`,
      active: true,
    }));
    expect(findNearMatches(many, 'Global Foods Department').length).toBeLessThanOrEqual(4);
  });

  it('includes a deactivated entry, which is the whole point of searching it', () => {
    const existing = [{ id: 'a', name: 'Bidfood', active: false }];
    expect(findNearMatches(existing, 'Bidfood Pty Ltd')).toHaveLength(1);
  });
});
