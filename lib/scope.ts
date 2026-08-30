import type { Route } from 'next';
import type { Business, InvoiceRow } from './types';

/**
 * Which slice of the ledger you are looking at.
 *
 * ARCHITECTURE §16: the dashboard lists Overall plus the four businesses, and
 * choosing one scopes every screen below it. That choice lives in the URL —
 * `/b/all`, `/b/gmh` — rather than in a filter control, because it is a place
 * you have navigated to, not a setting you have adjusted. Back goes back, a
 * link can be shared, and reloading keeps you where you were.
 *
 * The business CODE is used rather than its id: `/b/gmh` is readable, and the
 * codes are already load-bearing — they are stamped into every internal ref.
 */

export const ALL_SCOPE = 'all';

/** Lower-cased business code, or 'all'. */
export type Scope = string;

export function parseScope(param: string | undefined): Scope {
  const value = (param ?? '').trim().toLowerCase();
  return value === '' ? ALL_SCOPE : value;
}

export function isAll(scope: Scope): boolean {
  return scope === ALL_SCOPE;
}

/** The business a scope refers to, or null for Overall and for nonsense. */
export function businessForScope(scope: Scope, businesses: readonly Business[]): Business | null {
  if (isAll(scope)) return null;
  return businesses.find((business) => business.code.toLowerCase() === scope) ?? null;
}

/**
 * Whether a scope names something real.
 *
 * A URL somebody typed, or an old link to a business since deactivated, must
 * not silently show every business's invoices as though it were that one.
 */
export function isKnownScope(scope: Scope, businesses: readonly Business[]): boolean {
  return isAll(scope) || businessForScope(scope, businesses) !== null;
}

export function scopeLabel(scope: Scope, businesses: readonly Business[]): string {
  if (isAll(scope)) return 'All businesses';
  return businessForScope(scope, businesses)?.name ?? 'Unknown business';
}

export function scopeShortLabel(scope: Scope, businesses: readonly Business[]): string {
  if (isAll(scope)) return 'Overall';
  return businessForScope(scope, businesses)?.code ?? '—';
}

/*
 * Cast, in one place, with a reason.
 *
 * `typedRoutes` checks Link hrefs against the routes that exist, which is
 * worth having — it catches a link to a page that was renamed. It cannot check
 * a segment computed at runtime, and a scope is exactly that. Confining the
 * cast to these two functions means every call site stays checked, and the
 * only unchecked thing is the shape of a URL that `isKnownScope` validates
 * separately.
 */
export function scopeHref(scope: Scope): Route {
  return `/b/${scope}` as Route;
}

export function pendingHref(scope: Scope): Route {
  return `/b/${scope}/pending` as Route;
}

export function invoiceHref(id: string): Route {
  return `/invoices/${id}` as Route;
}

export function historyHref(scope: Scope): Route {
  return `/b/${scope}/history` as Route;
}

/**
 * Narrow the one client-side array to this scope.
 *
 * Architecture §2: filtering here rather than in the query is what makes it
 * impossible for a scoped total to disagree with the scoped list under it.
 */
export function filterByScope(
  rows: readonly InvoiceRow[],
  scope: Scope,
  businesses: readonly Business[],
): InvoiceRow[] {
  if (isAll(scope)) return [...rows];
  const business = businessForScope(scope, businesses);
  if (!business) return [];
  return rows.filter((row) => row.business_id === business.id);
}

/**
 * The business you are currently looking at, from the URL.
 *
 * The `+` is global (ARCHITECTURE §16) and pre-selected the last business used
 * on this device, which is right from the dashboard and wrong from inside a
 * business: standing in Majheri and adding an invoice to Hurstville because
 * that is where you were yesterday is a mistake the interface invited.
 *
 * Returns null for Overall and for every screen that is not a business, where
 * "the last one you used" is still the best available guess.
 */
export function businessIdForPath(
  pathname: string,
  businesses: readonly Business[],
): string | null {
  const match = /^\/b\/([^/?#]+)/.exec(pathname);
  if (!match) return null;

  const scope = parseScope(match[1]);
  if (isAll(scope)) return null;
  return businessForScope(scope, businesses)?.id ?? null;
}
