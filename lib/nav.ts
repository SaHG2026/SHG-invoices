import type { Route } from 'next';
import { ALL_SCOPE } from './scope';

/**
 * The side menu, as data.
 *
 * ARCHITECTURE §16 put the business choice in the URL rather than in a filter
 * control, and gave each screen a card of links to the rest of what a scope
 * offers. That worked while there were three destinations. There are now six,
 * the same card was repeated on two screens, and Customers (§17) makes a
 * seventh — so navigation moves into one drawer that every screen shares.
 *
 * The sections and the "which one am I in" rule live here rather than inside
 * the component for the usual reason: highlighting the wrong row is a bug
 * somebody has to see to find, and a pure function over a pathname can be
 * tested at every URL the app has in about a second.
 */

export type NavSection = 'invoices' | 'suppliers' | 'customers' | 'history' | 'settings';

export interface NavItem {
  section: NavSection;
  label: string;
  href: Route;
  /** Whether the four businesses hang off this row. Only Invoices does. */
  expandable?: true;
}

/**
 * In menu order.
 *
 * Invoices points at the dashboard, not at `/b/all`. The dashboard is what the
 * app opens to and what the greeting and the group total live on; the
 * businesses beneath this row are the shortcut past it. Overall's own week
 * view stays one tap away on the dashboard rather than being listed twice.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  { section: 'invoices', label: 'Invoices', href: '/' as Route, expandable: true },
  { section: 'suppliers', label: 'Suppliers', href: '/suppliers' as Route },
  { section: 'customers', label: 'Customers', href: '/customers' as Route },
  { section: 'history', label: 'Paid history', href: `/b/${ALL_SCOPE}/history` as Route },
  { section: 'settings', label: 'Settings', href: '/settings' as Route },
] as const;

/**
 * Which menu row the current URL belongs to.
 *
 * History is tested before Invoices deliberately. Paid history lives at
 * `/b/all/history`, so it sits *inside* the invoice URL space — checked the
 * other way round, every history page would light up Invoices instead.
 */
export function activeSection(pathname: string): NavSection | null {
  const path = normalise(pathname);

  if (path.endsWith('/history')) return 'history';
  if (path === '/' || path.startsWith('/b/') || path.startsWith('/invoices/')) return 'invoices';
  if (path.startsWith('/suppliers')) return 'suppliers';
  if (path.startsWith('/customers')) return 'customers';
  if (path.startsWith('/settings')) return 'settings';
  return null;
}

/**
 * Whether a business row in the menu is the one being looked at.
 *
 * `/b/gmh` and `/b/gmh/pending` are both Hurstville. `/b/gmh/history` is not —
 * that is Paid history, scoped to Hurstville, and it highlights there instead,
 * so exactly one row is ever lit.
 *
 * The comparison is case-insensitive because `businesses.code` is stored
 * upper-case ('GMH') and the URL segment is lower ('/b/gmh').
 */
export function isBusinessActive(pathname: string, code: string): boolean {
  const path = normalise(pathname);
  if (path.endsWith('/history')) return false;

  const prefix = `/b/${code.toLowerCase()}`;
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** Trailing slashes and query strings are not part of which page this is. */
function normalise(pathname: string): string {
  const path = (pathname || '/').split('?')[0]!.split('#')[0]!;
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}
