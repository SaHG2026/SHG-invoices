'use client';

import { useEffect, useRef, useState } from 'react';
import { useFormGuard } from '@/hooks/use-form-guard';

/**
 * The bottom sheet. Spec §7.3 — the only place in the app with a shadow.
 *
 * ---------------------------------------------------------------------------
 * Surviving the keyboard, which is the whole difficulty.
 *
 * Notes §4: "Test with the on-screen keyboard open on a 360px viewport — the
 * save button must remain reachable, not pushed under the keyboard."
 *
 * `100vh` and even `100dvh` do not shrink when the keyboard opens on iOS: the
 * layout viewport stays the full height of the screen and the keyboard is
 * simply drawn on top of it. A sheet anchored to `bottom: 0` therefore puts
 * its save button underneath the keyboard, where it cannot be tapped.
 *
 * `window.visualViewport` reports what is actually visible. The difference
 * between it and the layout viewport is the keyboard, so the sheet is lifted
 * by exactly that much and capped to the space that remains.
 * ---------------------------------------------------------------------------
 */

interface SheetProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  /** Pinned below the scrolling content, always reachable. */
  footer?: React.ReactNode;
}

function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    const measure = () => {
      // What the layout thinks exists, minus what is actually visible.
      const hidden = window.innerHeight - viewport.height - viewport.offsetTop;
      setInset(Math.max(0, Math.round(hidden)));
    };

    measure();
    viewport.addEventListener('resize', measure);
    viewport.addEventListener('scroll', measure);
    return () => {
      viewport.removeEventListener('resize', measure);
      viewport.removeEventListener('scroll', measure);
    };
  }, []);

  return inset;
}

export function Sheet({ open, title, onClose, children, footer }: SheetProps) {
  // While this is mounted nothing refetches on focus, so backgrounding the app
  // to read the paper docket cannot wipe what has been typed (notes §1.1).
  useFormGuard();

  const keyboardInset = useKeyboardInset();
  const panelRef = useRef<HTMLDivElement>(null);

  // Escape closes; the page behind does not scroll while the sheet is up.
  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={title}>
      {/*
        The backdrop is a convenience for mouse and thumb, not a control. It is
        hidden from assistive technology because the explicit close button in the header
        already does the same job — two elements announcing the same name is
        confusing to hear, and a test caught exactly that collision.
        Keyboard users have Escape, handled above.
      */}
      <div aria-hidden onClick={onClose} className="absolute inset-0 bg-ink/40" />

      <div
        ref={panelRef}
        className="absolute inset-x-0 flex flex-col rounded-t-sm bg-card shadow-[0_-2px_24px_rgba(18,56,75,0.18)]"
        style={{
          bottom: keyboardInset,
          // Leave a strip of the page visible so it reads as a sheet over the
          // ledger rather than a new screen.
          maxHeight: `calc(100dvh - ${keyboardInset}px - 32px)`,
        }}
      >
        <header className="flex shrink-0 items-center justify-between border-b border-hair px-4 py-3">
          <h2 className="text-h2 text-ink" style={{ fontFamily: 'var(--font-display)' }}>
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="touch -mr-2 flex items-center justify-center px-2 text-h2 text-mute"
          >
            ✕
          </button>
        </header>

        {/* The only scrolling region. The footer below never leaves. */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">{children}</div>

        {footer ? (
          <div
            className="shrink-0 border-t border-hair bg-card px-4 pt-3"
            style={{ paddingBottom: `calc(0.75rem + env(safe-area-inset-bottom, 0px))` }}
          >
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
