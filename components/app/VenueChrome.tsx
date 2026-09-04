'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { useState } from 'react';
import { AddVenueInvoiceSheet } from '@/components/invoice/AddVenueInvoiceSheet';
import { ConnectionStatus } from './ConnectionStatus';
import type { StaffInvoice } from '@/lib/types';

/**
 * The shell a venue account sits inside.
 *
 * ---------------------------------------------------------------------------
 * Why this is a second chrome and not a branch inside `AppChrome`
 *
 * `AppChrome` carries the `+` that the fifteen-second target is measured
 * through — spec §1, and the one number the whole app defers to. Putting a
 * role branch inside it would mean every future change to the entry path has
 * to be reasoned about twice, and it would put the app's single measured
 * feature at regression risk to serve two accounts.
 *
 * Duplication is the cheaper mistake here. The two shells share the header
 * bar's shape and nothing else, because a venue has nothing the other one has:
 *
 *   no menu   — one screen needs no navigation
 *   no bell   — `activity_log` is still `is_member()` only, so the feed would
 *               be empty forever, and notes §6 says the interface should not
 *               offer what it cannot do
 *   no back   — there is nowhere above this
 *   no Deli Delights question — the `+` here has exactly one meaning
 * ---------------------------------------------------------------------------
 */
interface VenueChromeProps {
  children: React.ReactNode;
  /**
   * The invoice the screen wants corrected, if any. Lifted here because the
   * sheet lives in the chrome — the `+` opens it — and two sheets, one for
   * adding and one for correcting, would be two copies of a form to keep in
   * step.
   */
  editing?: StaffInvoice | null;
  onCloseEditing?: () => void;
}

export function VenueChrome({ children, editing, onCloseEditing }: VenueChromeProps) {
  const [sheetOpen, setSheetOpen] = useState(false);

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-30 border-b border-edge bg-card">
        <div className="mx-auto flex h-14 max-w-[560px] items-center gap-2 px-4">
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

          <span className="flex-1" />

          <ConnectionStatus />

          {/*
            Settings is the only other screen a venue can reach, and it is how
            they sign out, change their password and set a PIN. It gets a
            labelled control rather than a chip: the chip means "who am I",
            and for a shared shop login that question has no useful answer.
          */}
          <Link
            href={'/settings' as Route}
            aria-label="Settings"
            className="touch flex shrink-0 items-center justify-center px-1 text-muted"
          >
            <GearGlyph />
          </Link>
        </div>
      </header>

      <main className="screen-in mx-auto max-w-[560px] px-4 pb-28 pt-6">{children}</main>

      {/*
        The same 56px floating button, in the same corner, as every list screen
        the four use. A shop phone and an office phone are the same phone held
        the same way, and the one thing both audiences do is add an invoice.
      */}
      <button
        type="button"
        onClick={() => setSheetOpen(true)}
        aria-label="Add invoice"
        className="fixed right-4 z-40 flex size-14 items-center justify-center rounded-full bg-action text-h1 text-action-text shadow-(--shadow-lift)"
        style={{ bottom: `calc(1rem + env(safe-area-inset-bottom, 0px))` }}
      >
        +
      </button>

      <AddVenueInvoiceSheet
        open={sheetOpen || editing != null}
        editing={editing ?? null}
        onClose={() => {
          setSheetOpen(false);
          onCloseEditing?.();
        }}
      />
    </div>
  );
}

/** Stroked to match the header's other glyphs, which are all 20px and 1.5px. */
function GearGlyph() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden
    >
      <circle cx="10" cy="10" r="2.75" />
      <path d="M10 2.2v2M10 15.8v2M17.8 10h-2M4.2 10h-2M15.5 4.5l-1.4 1.4M5.9 14.1l-1.4 1.4M15.5 15.5l-1.4-1.4M5.9 5.9L4.5 4.5" />
    </svg>
  );
}
