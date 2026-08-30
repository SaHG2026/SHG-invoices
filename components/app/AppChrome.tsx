'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { AddInvoiceSheet } from '@/components/invoice/AddInvoiceSheet';
import { AddSalesInvoiceSheet } from '@/components/invoice/AddSalesInvoiceSheet';
import { PersonChip } from '@/components/ui/PersonChip';
import { ActivityBell } from './ActivityBell';
import { NavDrawer } from './NavDrawer';
import { useCurrentProfile } from '@/lib/queries/session';

/**
 * The shell every signed-in screen sits inside.
 *
 * One place for the header, the menu and the `+` button, so they cannot drift
 * between screens and so a screen added later gets all three without asking.
 *
 * ARCHITECTURE §16: the `+` is global and reachable from everywhere. Reading
 * the ledger is hierarchical — dashboard, business, list — but writing to it
 * is not. The first metric is fifteen seconds from cold open to a saved
 * invoice, and making somebody walk into a business first would spend three of
 * them on navigation.
 *
 * The menu button is the counterpart: every destination is now one tap from
 * every screen, so the same is true of reading. `back` stays for the screens
 * where it means something specific — this invoice came from that list — and
 * is not a substitute for navigation.
 */

interface AppChromeProps {
  children: React.ReactNode;
  /** Shown in the header when you are inside a business rather than at home. */
  back?: { href: Route; label: string };
  /**
   * How the `+` appears. `floating` is the 56px corner button every list
   * screen uses; `bar` is a full-width button pinned across the bottom, for
   * the dashboard, where adding an invoice is the primary action rather than
   * one of several.
   *
   * Never both: two controls doing one thing, one of them overlapping the
   * other, is worse than either.
   */
  add?: 'floating' | 'bar';
}

export function AppChrome({ children, back, add = 'floating' }: AppChromeProps) {
  const { data: profile } = useCurrentProfile();
  /*
   * Keyed on the path so the animation replays on every navigation.
   *
   * Without the key React reuses the same <main> across routes and the
   * animation, having already run once, never runs again — the content simply
   * swaps. Which is exactly the "jerky" the client described: nothing was
   * animating between screens at all.
   */
  const pathname = usePathname();

  /*
   * Deli Delights is the only business with two directions, so it is the only
   * place the `+` has to ask which one you mean. Everywhere else the answer is
   * "a supplier invoice" and a question with one right answer is not a
   * question — ARCHITECTURE §17.
   */
  const sellsAsWell = /^\/(b\/ddl|customers)(\/|$)/.test(pathname ?? '');
  const [salesOpen, setSalesOpen] = useState(false);
  const [asking, setAsking] = useState(false);

  function pressedAdd() {
    if (sellsAsWell) setAsking(true);
    else setSheetOpen(true);
  }
  const [sheetOpen, setSheetOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-30 border-b border-edge bg-card">
        {/* relative, so the bell panel can hang beneath the bar */}
        <div className="relative mx-auto flex h-14 max-w-[560px] items-center gap-1 px-4">
          <button
            type="button"
            onClick={() => setMenuOpen(true)}
            aria-label="Menu"
            className="touch -ml-3 flex shrink-0 items-center justify-center px-2 text-ink"
          >
            <MenuGlyph />
          </button>

          {back ? (
            <Link
              href={back.href}
              className="touch flex min-w-0 items-center gap-1 pr-1 text-sm text-action"
            >
              <span aria-hidden>‹</span>
              <span className="truncate">{back.label}</span>
            </Link>
          ) : (
            <span className="flex min-w-0 items-center gap-2">
              {/*
                The same tile as the home screen icon, so the header confirms
                you are in the thing you tapped. A plain <img> rather than
                next/image: one static 28px square from our own origin has
                nothing for the optimiser to do.
              */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/icons/icon-64.png"
                alt=""
                width={28}
                height={28}
                className="shrink-0 rounded-sm"
              />
              <span
                className="truncate text-h2 text-ink"
                style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.02em' }}
              >
                SHG Invoices
              </span>
            </span>
          )}

          <span className="flex-1" />

          {/*
            Home, next to the bell. The logo is a link on paper but it is not
            one here — on a deep screen the header shows a back link instead of
            the wordmark, so the only way home was the menu. Two taps for the
            screen the app opens to.
          */}
          <Link
            href={'/' as Route}
            aria-label="Home"
            className="touch flex shrink-0 items-center justify-center px-1 text-muted"
          >
            <HomeGlyph />
          </Link>

          <ActivityBell />

          {profile ? (
            <Link
              href={'/settings' as Route}
              aria-label={`Signed in as ${profile.display_name} — settings`}
              className="touch flex shrink-0 items-center justify-center"
            >
              <PersonChip profile={profile} />
            </Link>
          ) : null}
        </div>
      </header>

      <main key={pathname} className="screen-in mx-auto max-w-[560px] px-4 pb-28 pt-6">
        {children}
      </main>

      {add === 'floating' ? (
        <button
          type="button"
          onClick={pressedAdd}
          aria-label="Add invoice"
          className="fixed right-4 z-40 flex size-14 items-center justify-center rounded-full bg-action text-h1 text-action-text shadow-[0_2px_12px_rgba(8,47,85,0.28)]"
          style={{ bottom: `calc(1rem + env(safe-area-inset-bottom, 0px))` }}
        >
          +
        </button>
      ) : (
        /*
          Pinned rather than sitting at the end of the page.
          In the mockup it follows a list of four; on a real Monday it follows
          a list of thirty, and a button that has scrolled out of sight is a
          button that is not reachable — which is three seconds off the
          fifteen-second target, on the one screen the app opens to.
        */
        <div
          className="fixed inset-x-0 bottom-0 z-40 border-t border-edge bg-card px-4 pt-3"
          style={{ paddingBottom: `calc(0.75rem + env(safe-area-inset-bottom, 0px))` }}
        >
          <button
            type="button"
            onClick={pressedAdd}
            className="touch mx-auto flex w-full max-w-[528px] items-center justify-center gap-2 rounded-full bg-action px-4 text-base font-medium text-action-text"
          >
            <span aria-hidden>+</span>
            New invoice
          </button>
        </div>
      )}

      {menuOpen ? <NavDrawer onClose={() => setMenuOpen(false)} /> : null}

      {/*
        Which direction? Only asked inside Deli Delights and on the customer
        screens. Two large targets rather than a dropdown: this is the first
        thing between a person and entering an invoice, and it should cost one
        tap and no reading.
      */}
      {asking ? (
        <div
          className="fixed inset-0 z-50 flex items-end"
          role="dialog"
          aria-modal="true"
          aria-label="What kind of invoice?"
        >
          <div
            aria-hidden
            onClick={() => setAsking(false)}
            className="scrim-in absolute inset-0 bg-ink/40"
          />
          <div
            className="sheet-in relative w-full bg-card p-4"
            style={{
              borderTopLeftRadius: 16,
              borderTopRightRadius: 16,
              paddingBottom: `calc(1rem + env(safe-area-inset-bottom, 0px))`,
            }}
          >
            <p className="mb-3 text-xs uppercase tracking-widest text-muted">New invoice</p>

            <button
              type="button"
              onClick={() => {
                setAsking(false);
                setSheetOpen(true);
              }}
              className="touch mb-2 flex w-full flex-col items-start rounded-sm border border-edge px-4 py-3 text-left"
            >
              <span className="text-base font-medium text-ink">From a supplier</span>
              <span className="text-xs text-muted">Money out — something we have to pay</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setAsking(false);
                setSalesOpen(true);
              }}
              className="touch mb-3 flex w-full flex-col items-start rounded-sm border border-edge px-4 py-3 text-left"
            >
              <span className="text-base font-medium text-ink">To a customer</span>
              <span className="text-xs text-muted">Money in — something they owe us</span>
            </button>

            <button
              type="button"
              onClick={() => setAsking(false)}
              className="touch w-full rounded-full border border-hairline text-sm text-ink"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      <AddInvoiceSheet open={sheetOpen} onClose={() => setSheetOpen(false)} />
      <AddSalesInvoiceSheet open={salesOpen} onClose={() => setSalesOpen(false)} />
    </div>
  );
}

/**
 * Drawn rather than typed, for the reason the chevron in NavDrawer is: ☰ is a
 * real character and it renders at three different weights across iOS, Android
 * and desktop, sometimes as an emoji. This is the same three lines everywhere.
 */
function HomeGlyph() {
  return (
    <svg aria-hidden width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path
        d="M2.7 7.2 9 2.4l6.3 4.8v7.2a.9.9 0 0 1-.9.9h-3.6v-4.5H6.2v4.5H3.6a.9.9 0 0 1-.9-.9V7.2Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MenuGlyph() {
  return (
    <svg aria-hidden width="20" height="20" viewBox="0 0 20 20" fill="none">
      <path
        d="M3 5.5h14M3 10h14M3 14.5h14"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

export { useSydneyToday } from '@/hooks/use-sydney-today';
