import type { Supplier } from '../types';

/**
 * Ranking the supplier type-ahead. Spec §7.3: "top 5 recent first, then fuzzy
 * match".
 *
 * This is the single biggest lever on the fifteen-second target. Typing a
 * supplier name in full costs four or five seconds on a phone; picking the
 * right one from three characters costs under one. So the ranking has to put
 * the intended supplier first almost every time, and it has to do it from two
 * or three letters, because that is all anyone will type.
 *
 * Pure, so it can be tested against the real supplier list without a browser.
 */

export interface RankOptions {
  /** Supplier ids most recently used on this device, newest first. */
  recentIds?: readonly string[];
  /** How many to show. The list has to fit above the keyboard. */
  limit?: number;
}

/** Higher is better. Ordering matters more than the absolute values. */
function score(name: string, query: string): number {
  const haystack = name.toLowerCase();
  const needle = query.toLowerCase();

  if (haystack === needle) return 1000;
  if (haystack.startsWith(needle)) return 900 - haystack.length;

  // A word start: "food" should find "PFD Food Services".
  const wordStart = new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  if (wordStart.test(haystack)) return 700 - haystack.length;

  const at = haystack.indexOf(needle);
  if (at !== -1) return 500 - at - haystack.length / 100;

  // Subsequence, so "bdf" still finds "Bidfood" — someone typing fast on a
  // phone drops letters, and a miss here means falling back to scrolling.
  let cursor = 0;
  let gaps = 0;
  for (const character of needle) {
    const found = haystack.indexOf(character, cursor);
    if (found === -1) return -1;
    gaps += found - cursor;
    cursor = found + 1;
  }
  return 200 - gaps;
}

/**
 * With no query, recently used suppliers first, then the rest alphabetically.
 * With a query, best match first, recency breaking ties.
 *
 * Inactive suppliers never appear. Spec §7.8: deactivating hides a supplier
 * from the type-ahead but keeps all their history.
 */
export function rankSuppliers(
  suppliers: readonly Supplier[],
  query: string,
  { recentIds = [], limit = 5 }: RankOptions = {},
): Supplier[] {
  const active = suppliers.filter((supplier) => supplier.active);
  const recencyOf = (id: string) => {
    const index = recentIds.indexOf(id);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };

  const trimmed = query.trim();

  if (trimmed === '') {
    return [...active]
      .sort(
        (a, b) => recencyOf(a.id) - recencyOf(b.id) || a.name.localeCompare(b.name),
      )
      .slice(0, limit);
  }

  return active
    .map((supplier) => ({ supplier, points: score(supplier.name, trimmed) }))
    .filter((entry) => entry.points >= 0)
    .sort(
      (a, b) =>
        b.points - a.points ||
        recencyOf(a.supplier.id) - recencyOf(b.supplier.id) ||
        a.supplier.name.localeCompare(b.supplier.name),
    )
    .slice(0, limit)
    .map((entry) => entry.supplier);
}

/**
 * Whether to offer `+ Add "bid" as a new supplier`.
 *
 * Offered unless the typed name already exists exactly, case-insensitively —
 * `suppliers_name_ci` is a unique index on active suppliers, so creating a
 * duplicate would fail at the database anyway. Better to not offer it than to
 * offer it and fail.
 */
export function canCreateSupplier(suppliers: readonly Supplier[], query: string): boolean {
  const trimmed = query.trim();
  if (trimmed.length < 2) return false;
  return !suppliers.some(
    (supplier) => supplier.active && supplier.name.toLowerCase() === trimmed.toLowerCase(),
  );
}
