/**
 * What this device remembers between sessions.
 *
 * Two things, both purely conveniences that shave seconds off the add-invoice
 * flow, and both safe to lose: the business you last logged against, and the
 * suppliers you have used lately.
 *
 * Per device rather than per account on purpose. Whoever holds the Hurstville
 * phone is almost always logging Hurstville invoices, and that is true no
 * matter which of the four is signed in. Storing it server-side would make it
 * follow the person instead of the shop, which is the wrong way round.
 *
 * Every read tolerates storage being unavailable — private browsing, cleared
 * site data — and falls back to a sensible default rather than throwing.
 */

const BUSINESS_KEY = 'shg.business.selected';
const SUPPLIERS_KEY = 'shg.suppliers.recent';

/** Enough to fill the type-ahead before anyone types. Spec §7.3: top 5. */
const RECENT_LIMIT = 8;

export function readLastBusinessId(): string | null {
  try {
    return localStorage.getItem(BUSINESS_KEY);
  } catch {
    return null;
  }
}

export function writeLastBusinessId(businessId: string): void {
  try {
    localStorage.setItem(BUSINESS_KEY, businessId);
  } catch {
    /* the sheet just opens on the first business instead */
  }
}

export function readRecentSupplierIds(): string[] {
  try {
    const raw = localStorage.getItem(SUPPLIERS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/** Most recent first, no duplicates, capped. */
export function pushRecentSupplierId(supplierId: string): void {
  try {
    const next = [supplierId, ...readRecentSupplierIds().filter((id) => id !== supplierId)].slice(
      0,
      RECENT_LIMIT,
    );
    localStorage.setItem(SUPPLIERS_KEY, JSON.stringify(next));
  } catch {
    /* the type-ahead falls back to alphabetical */
  }
}
