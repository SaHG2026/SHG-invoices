import { describe, expect, it } from 'vitest';
import { NAV_ITEMS, activeSection, isBusinessActive } from '@/lib/nav';
import { businessIdForPath } from '@/lib/scope';
import { BUSINESSES } from '../fixtures/invoices';

/**
 * Which menu row lights up, at every URL the app has.
 *
 * The failure this stands over is specific and easy to ship: Paid history
 * lives at `/b/all/history`, which sits inside the invoice URL space. Checked
 * in the obvious order — Invoices first, because it is first in the menu —
 * every history page highlights Invoices instead, and the menu quietly lies
 * about where you are. It is not the kind of bug a person reports; they just
 * stop trusting the highlight.
 */

const ROUTES = [
  '/',
  '/b/all',
  '/b/gmh',
  '/b/gmh/pending',
  '/b/all/history',
  '/b/gmh/history',
  '/invoices/abc-123',
  '/suppliers',
  '/suppliers/s-1',
  '/customers',
  '/customers/c-1',
  '/settings',
  '/specimen',
] as const;

describe('the menu knows where you are', () => {
  it('puts every invoice screen under Invoices', () => {
    for (const path of ['/', '/b/all', '/b/gmh', '/b/gmh/pending', '/invoices/abc-123']) {
      expect(activeSection(path), path).toBe('invoices');
    }
  });

  it('puts history under Paid history, not under Invoices', () => {
    // The one that breaks if the checks are reordered.
    expect(activeSection('/b/all/history')).toBe('history');
    expect(activeSection('/b/gmh/history')).toBe('history');
  });

  it('recognises the standalone sections', () => {
    expect(activeSection('/suppliers')).toBe('suppliers');
    expect(activeSection('/suppliers/s-1')).toBe('suppliers');
    expect(activeSection('/customers')).toBe('customers');
    expect(activeSection('/customers/c-1')).toBe('customers');
    expect(activeSection('/settings')).toBe('settings');
  });

  it('highlights nothing rather than guessing', () => {
    // The specimen page is in no section. Lighting up a row at random is
    // worse than lighting up none.
    expect(activeSection('/specimen')).toBeNull();
    expect(activeSection('/nonsense')).toBeNull();
  });

  it('lights exactly one row at every route', () => {
    for (const path of ROUTES) {
      const lit = NAV_ITEMS.filter((item) => item.section === activeSection(path));
      expect(lit.length, `${path} lit ${lit.length} rows`).toBeLessThanOrEqual(1);
    }
  });

  it('ignores trailing slashes and query strings', () => {
    expect(activeSection('/customers/')).toBe('customers');
    expect(activeSection('/b/gmh/pending?sort=amount')).toBe('invoices');
    expect(activeSection('/b/all/history?who=p-mani')).toBe('history');
  });
});

describe('the business rows', () => {
  it('matches a business and its pending list', () => {
    expect(isBusinessActive('/b/gmh', 'GMH')).toBe(true);
    expect(isBusinessActive('/b/gmh/pending', 'GMH')).toBe(true);
  });

  it('matches the stored upper-case code against the lower-case URL', () => {
    // businesses.code is 'GMH'; the URL segment is '/b/gmh'. A case-sensitive
    // comparison here would light up no business, ever.
    for (const business of BUSINESSES) {
      expect(isBusinessActive(`/b/${business.code.toLowerCase()}`, business.code)).toBe(true);
    }
  });

  it('does not claim a business when you are in its history', () => {
    // Paid history highlights Paid history, so exactly one row is ever lit.
    expect(isBusinessActive('/b/gmh/history', 'GMH')).toBe(false);
  });

  it('never lets one business match another', () => {
    for (const business of BUSINESSES) {
      const others = BUSINESSES.filter((other) => other.code !== business.code);
      for (const other of others) {
        expect(
          isBusinessActive(`/b/${business.code.toLowerCase()}`, other.code),
          `${business.code} lit ${other.code}`,
        ).toBe(false);
      }
    }
  });

  it('does not match a longer code that starts the same way', () => {
    // '/b/gm' must not light up GMH — a prefix is not a match.
    expect(isBusinessActive('/b/gm', 'GMH')).toBe(false);
    expect(isBusinessActive('/b/gmhx', 'GMH')).toBe(false);
  });

  it('lights no business on Overall', () => {
    for (const business of BUSINESSES) {
      expect(isBusinessActive('/b/all', business.code)).toBe(false);
    }
  });
});

describe('the + knows which business you are standing in', () => {
  it('picks the business from a business URL', () => {
    for (const business of BUSINESSES) {
      const path = `/b/${business.code.toLowerCase()}`;
      expect(businessIdForPath(path, BUSINESSES), path).toBe(business.id);
      expect(businessIdForPath(`${path}/pending`, BUSINESSES)).toBe(business.id);
    }
  });

  it('picks nothing on Overall, where the last one used is still the best guess', () => {
    expect(businessIdForPath('/b/all', BUSINESSES)).toBeNull();
  });

  it('picks nothing outside the business screens', () => {
    for (const path of ['/', '/suppliers', '/customers', '/settings', '/invoices/abc']) {
      expect(businessIdForPath(path, BUSINESSES), path).toBeNull();
    }
  });

  it('picks nothing for a business that does not exist', () => {
    expect(businessIdForPath('/b/nope', BUSINESSES)).toBeNull();
  });
});
