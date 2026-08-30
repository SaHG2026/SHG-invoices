'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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

/**
 * A keyboard is at least this tall.
 *
 * `window.innerHeight - visualViewport.height` is the difference between what
 * the layout thinks exists and what is actually visible — which is the
 * keyboard, and ALSO the mobile browser's collapsing URL bar. On a phone that
 * bar is worth 60-100px and it moves while you scroll, so the raw difference
 * was reporting a phantom keyboard with no keyboard on screen: the sheet lifted
 * off the bottom for no reason, its height was reduced to match, and the top of
 * it went out of view. That is the "jumps in like crazy" and the clipped
 * business row, from one measurement.
 *
 * No on-screen keyboard is under 150px on any phone; no browser chrome is over
 * it. Anything smaller is treated as not a keyboard.
 */
const KEYBOARD_MIN_PX = 150;

/** Must match the `sheet-in` animation in app/globals.css. */
const ENTRANCE_MS = 260;

interface Viewport {
  /** How much of the bottom is covered by a keyboard. Zero when there is none. */
  keyboard: number;
  /** What is actually visible, in px. Null until measured. */
  height: number | null;
}

function useViewport(): Viewport {
  const [viewport, setViewport] = useState<Viewport>({ keyboard: 0, height: null });

  /*
   * useLayoutEffect, not useEffect: this runs before the browser paints.
   *
   * Measuring after the first paint meant the sheet rendered once at its
   * fallback height and then transitioned to the real one — a second movement
   * on top of the entrance, which is half of what was reported as bouncing.
   * Measured before paint, the first frame is already the right size.
   */
  useLayoutEffect(() => {
    const visual = window.visualViewport;
    if (!visual) return;

    const measure = () => {
      const hidden = window.innerHeight - visual.height - visual.offsetTop;
      setViewport({
        keyboard: hidden >= KEYBOARD_MIN_PX ? Math.round(hidden) : 0,
        height: Math.round(visual.height),
      });
    };

    measure();
    visual.addEventListener('resize', measure);
    visual.addEventListener('scroll', measure);
    return () => {
      visual.removeEventListener('resize', measure);
      visual.removeEventListener('scroll', measure);
    };
  }, []);

  return viewport;
}

export function Sheet({ open, title, onClose, children, footer }: SheetProps) {
  /*
   * Whether the entrance has finished.
   *
   * Height changes are transitioned once the sheet has arrived, and applied
   * instantly while it is still on its way in — where they are invisible,
   * because the panel is still travelling. Without this the entrance and a
   * resize run at once and read as a spring.
   */
  const [settled, setSettled] = useState(false);
  // While this is mounted nothing refetches on focus, so backgrounding the app
  // to read the paper docket cannot wipe what has been typed (notes §1.1).
  useFormGuard();

  const { keyboard, height: visibleHeight } = useViewport();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => setSettled(true), ENTRANCE_MS);
    return () => {
      window.clearTimeout(timer);
      setSettled(false);
    };
  }, [open]);

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
      <div aria-hidden onClick={onClose} className="scrim-in absolute inset-0 bg-ink/40" />

      <div
        ref={panelRef}
        className="sheet-in absolute inset-x-0 flex flex-col bg-card shadow-[0_-2px_24px_rgba(18,56,75,0.18)]"
        style={{
          /*
            Sized to what is visible, not to the layout viewport.
            `100dvh` does not shrink when the keyboard opens on iOS, so a sheet
            capped against it and then lifted above the keyboard had its top
            pushed off the screen — taking the business row with it. Measuring
            visualViewport.height means the sheet is never taller than the
            space it is in, so nothing can be cut off the top and the content
            below it scrolls instead.
          */
          bottom: keyboard,
          maxHeight: visibleHeight ? visibleHeight - 24 : 'calc(100dvh - 24px)',
          // 16px, iOS's own sheet corner. The 4px of spec §9 is a radius for
          // things sitting IN the page; this is the page's edge.
          borderTopLeftRadius: 16,
          borderTopRightRadius: 16,
          /*
            The height changes when the keyboard arrives; the sheet does not
            travel. Growing and shrinking from the top edge reads as the sheet
            making room, where lifting the whole panel reads as it being shoved.
          */
          transition: settled
            ? `max-height 220ms var(--ease-ios), bottom 220ms var(--ease-ios)`
            : undefined,
        }}
      >
        <header className="flex shrink-0 items-center justify-between border-b border-hairline px-4 py-3">
          <h2 className="text-h2 text-ink" style={{ fontFamily: 'var(--font-display)' }}>
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="touch -mr-2 flex items-center justify-center rounded-full px-2 text-h2 text-muted"
          >
            ✕
          </button>
        </header>

        {/* The only scrolling region. The footer below never leaves. */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">{children}</div>

        {footer ? (
          <div
            className="shrink-0 border-t border-hairline bg-card px-4 pt-3"
            style={{ paddingBottom: `calc(0.75rem + env(safe-area-inset-bottom, 0px))` }}
          >
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
