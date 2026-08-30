'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { BusinessMark } from '@/components/ui/BusinessMark';
import { PersonChip } from '@/components/ui/PersonChip';
import { useBusinesses } from '@/lib/queries/reference';
import { useUnpaidInvoices } from '@/lib/queries/invoices';
import { useCurrentProfile } from '@/lib/queries/session';
import { NAV_ITEMS, activeSection, isBusinessActive } from '@/lib/nav';
import { scopeHref } from '@/lib/scope';

/**
 * The side menu.
 *
 * Every destination in the app, in one place, reachable from every screen.
 * It replaces the card of links that ARCHITECTURE §16 put inside The Week and
 * then had to repeat on the suppliers screen — two copies of one list, which
 * is how a destination ends up reachable from one screen and not another.
 *
 * Mounted only while it is open, so the queries behind the counts do not run
 * on every screen that has never opened it. Costs nothing: the unpaid array is
 * already in the cache by the time anybody taps the button.
 *
 * The businesses sit under Invoices rather than beside it because that is what
 * they are — the same ledger, narrowed. Their counts are unpaid invoices, from
 * the one array everything else is derived from (architecture §2), so the menu
 * cannot disagree with the screen it opens.
 */

interface NavDrawerProps {
  onClose: () => void;
}

export function NavDrawer({ onClose }: NavDrawerProps) {
  const pathname = usePathname() ?? '/';
  const { data: profile } = useCurrentProfile();
  const { data: businesses = [] } = useBusinesses();
  const { data: invoices = [] } = useUnpaidInvoices();

  const panelRef = useRef<HTMLDivElement>(null);
  // Open by default: the businesses are the reason most people open this.
  const [showBusinesses, setShowBusinesses] = useState(true);

  const section = activeSection(pathname);

  /*
   * Whether one of the businesses is the page, rather than Invoices itself.
   *
   * Both are highlighted when you are inside a business — the child is where
   * you are, the parent is what it belongs to, and dropping the parent's tint
   * would make the menu look like it had lost you. But only one of them may
   * be `aria-current="page"`: that says "this is the page", and two elements
   * saying it is a contradiction read out loud.
   */
  const insideBusiness = businesses.some((business) => isBusinessActive(pathname, business.code));

  const counts = useMemo(() => {
    const perBusiness = new Map<string, number>();
    for (const invoice of invoices) {
      perBusiness.set(invoice.business_id, (perBusiness.get(invoice.business_id) ?? 0) + 1);
    }
    return perBusiness;
  }, [invoices]);

  // Escape closes, the page behind stays put, and focus comes back to
  // whatever opened this when it goes away.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panelRef.current?.focus();

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      opener?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Menu">
      {/*
        The backdrop is a convenience for the thumb, not a control — the close
        button below announces the same thing, and two elements with one name
        is confusing to hear. Same reasoning as components/ui/Sheet.tsx.
      */}
      <div aria-hidden onClick={onClose} className="scrim-in absolute inset-0 bg-ink/40" />

      <div
        ref={panelRef}
        tabIndex={-1}
        className="drawer-in absolute inset-y-0 left-0 flex w-[86vw] max-w-[300px] flex-col overflow-y-auto overscroll-contain border-r border-edge bg-card outline-none"
      >
        <div className="flex items-start gap-3 border-b border-hairline px-4 py-4">
          {profile ? (
            <Link
              href={'/settings' as Route}
              onClick={onClose}
              className="flex min-w-0 flex-1 items-center gap-3"
            >
              <PersonChip profile={profile} size="lg" />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-ink">
                  {profile.display_name}
                </span>
                <span className="block truncate text-xs text-muted">Sagarmatha Holdings</span>
              </span>
            </Link>
          ) : (
            <span className="flex-1" />
          )}

          <button
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            className="touch -mr-2 -mt-2 flex shrink-0 items-center justify-center rounded-full px-2 text-h2 text-muted"
          >
            ✕
          </button>
        </div>

        <nav aria-label="Sections" className="py-2">
          {NAV_ITEMS.map((item) => {
            const current = section === item.section;
            // The parent of the row you are actually on is highlighted, but
            // it is not the page.
            const isThePage = current && !(item.expandable && insideBusiness);

            return (
              <div key={item.section}>
                <div className="relative flex items-center">
                  {current ? (
                    <span
                      aria-hidden
                      className="absolute inset-y-0 left-0 w-[3px]"
                      style={{ backgroundColor: 'var(--action)' }}
                    />
                  ) : null}

                  <Link
                    href={item.href}
                    onClick={onClose}
                    aria-current={isThePage ? 'page' : undefined}
                    className={`touch flex min-w-0 flex-1 items-center px-4 py-2 text-base active:bg-pressed ${
                      current ? 'font-medium text-action' : 'text-ink'
                    }`}
                    style={current ? { backgroundColor: 'var(--action-bg)' } : undefined}
                  >
                    {item.label}
                  </Link>

                  {item.expandable ? (
                    <button
                      type="button"
                      onClick={() => setShowBusinesses((shown) => !shown)}
                      aria-expanded={showBusinesses}
                      aria-label={showBusinesses ? 'Hide businesses' : 'Show businesses'}
                      className="touch flex shrink-0 items-center justify-center px-3 text-muted"
                      style={current ? { backgroundColor: 'var(--action-bg)' } : undefined}
                    >
                      <Chevron open={showBusinesses} />
                    </button>
                  ) : null}
                </div>

                {item.expandable && showBusinesses ? (
                  <ul>
                    {businesses.map((business) => {
                      const here = isBusinessActive(pathname, business.code);
                      const count = counts.get(business.id) ?? 0;

                      return (
                        <li key={business.id} className="relative flex items-center">
                          {here ? (
                            <span
                              aria-hidden
                              className="absolute inset-y-0 left-0 w-[3px]"
                              style={{ backgroundColor: 'var(--action)' }}
                            />
                          ) : null}
                          <Link
                            href={scopeHref(business.code.toLowerCase())}
                            onClick={onClose}
                            aria-current={here ? 'page' : undefined}
                            className={`touch flex min-w-0 flex-1 items-center gap-2 py-2 pl-6 pr-4 text-sm active:bg-pressed ${
                              here ? 'font-medium text-action' : 'text-ink'
                            }`}
                            style={here ? { backgroundColor: 'var(--action-bg)' } : undefined}
                          >
                            <BusinessMark business={business} size="sm" />
                            <span className="min-w-0 flex-1 truncate">{business.name}</span>
                            {count > 0 ? (
                              <span className="figure-date shrink-0 text-xs text-muted">
                                {count}
                              </span>
                            ) : null}
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </div>
            );
          })}
        </nav>
      </div>
    </div>
  );
}

/**
 * Drawn rather than typed. The obvious character for this is ▸, and it renders
 * at a different size and baseline on every platform — on iOS some arrow
 * glyphs are promoted to emoji outright. Eight lines of SVG is the same shape
 * everywhere, and it inherits the row's colour.
 */
function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      style={{ transform: open ? 'rotate(90deg)' : undefined }}
    >
      <path
        d="M4.5 2.5 8 6l-3.5 3.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
