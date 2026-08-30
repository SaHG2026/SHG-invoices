'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { useState } from 'react';
import { AddInvoiceSheet } from '@/components/invoice/AddInvoiceSheet';
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
}

export function AppChrome({ children, back }: AppChromeProps) {
  const { data: profile } = useCurrentProfile();
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

      <main className="mx-auto max-w-[560px] px-4 pb-28 pt-6">{children}</main>

      <button
        type="button"
        onClick={() => setSheetOpen(true)}
        aria-label="Add invoice"
        className="fixed right-4 z-40 flex size-14 items-center justify-center rounded-sm bg-action text-h1 text-action-text shadow-[0_2px_12px_rgba(8,47,85,0.28)]"
        style={{ bottom: `calc(1rem + env(safe-area-inset-bottom, 0px))` }}
      >
        +
      </button>

      {menuOpen ? <NavDrawer onClose={() => setMenuOpen(false)} /> : null}

      <AddInvoiceSheet open={sheetOpen} onClose={() => setSheetOpen(false)} />
    </div>
  );
}

/**
 * Drawn rather than typed, for the reason the chevron in NavDrawer is: ☰ is a
 * real character and it renders at three different weights across iOS, Android
 * and desktop, sometimes as an emoji. This is the same three lines everywhere.
 */
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
