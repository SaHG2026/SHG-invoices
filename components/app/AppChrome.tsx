'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { useState } from 'react';
import { AddInvoiceSheet } from '@/components/invoice/AddInvoiceSheet';
import { PersonChip } from '@/components/ui/PersonChip';
import { ActivityBell } from './ActivityBell';
import { useCurrentProfile, useSignOut } from '@/lib/queries/session';

/**
 * The shell every signed-in screen sits inside.
 *
 * One place for the header and the `+` button, so they cannot drift between
 * screens and so a screen added later gets both without asking.
 *
 * ARCHITECTURE §16: the `+` is global and reachable from everywhere. Reading
 * the ledger is hierarchical — dashboard, business, list — but writing to it
 * is not. The first metric is fifteen seconds from cold open to a saved
 * invoice, and making somebody walk into a business first would spend three of
 * them on navigation.
 */

interface AppChromeProps {
  children: React.ReactNode;
  /** Shown in the header when you are inside a business rather than at home. */
  back?: { href: Route; label: string };
}

export function AppChrome({ children, back }: AppChromeProps) {
  const { data: profile } = useCurrentProfile();
  const signOut = useSignOut();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-30 border-b border-edge bg-card">
        {/* relative, so the bell panel can hang beneath the bar */}
        <div className="relative mx-auto flex h-14 max-w-[560px] items-center gap-2 px-4">
          {back ? (
            <Link
              href={back.href}
              className="touch -ml-2 flex items-center gap-1 pr-1 text-sm text-action"
            >
              <span aria-hidden>‹</span>
              <span className="truncate">{back.label}</span>
            </Link>
          ) : (
            <span
              className="text-h2 text-ink"
              style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.02em' }}
            >
              SHG
            </span>
          )}

          <span className="flex-1" />

          <ActivityBell />

          {profile ? (
            <button
              type="button"
              onClick={() => setMenuOpen((open) => !open)}
              aria-expanded={menuOpen}
              aria-label={`Signed in as ${profile.display_name}`}
              className="touch flex items-center justify-center"
            >
              <PersonChip profile={profile} />
            </button>
          ) : null}
        </div>

        {menuOpen && profile ? (
          <div className="row-in border-t border-hairline bg-card">
            <div className="mx-auto max-w-[560px] px-4 py-3">
              <p className="text-sm text-ink">
                {profile.display_name}
                {profile.role === 'owner' ? ' · owner' : ''}
              </p>
              <Link
                href="/specimen"
                className="touch mt-2 flex items-center text-sm text-action"
                onClick={() => setMenuOpen(false)}
              >
                Design tokens
              </Link>
              <button
                type="button"
                onClick={() => signOut.mutate()}
                disabled={signOut.isPending}
                className="touch mt-1 flex w-full items-center text-left text-sm text-action disabled:opacity-40"
              >
                {signOut.isPending ? 'Signing out…' : 'Sign out'}
              </button>
            </div>
          </div>
        ) : null}
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

      <AddInvoiceSheet open={sheetOpen} onClose={() => setSheetOpen(false)} />
    </div>
  );
}

export { useSydneyToday } from '@/hooks/use-sydney-today';
