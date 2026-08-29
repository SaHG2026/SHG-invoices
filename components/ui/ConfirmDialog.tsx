'use client';

import { useEffect } from 'react';

/**
 * "This looks odd — is it deliberate?"
 *
 * Deliberately a popup rather than an inline panel. An inline warning appears
 * somewhere in a form you have already stopped reading — you have hit save and
 * your attention has left the fields. A popup takes over, states the one fact,
 * and asks one question.
 *
 * It is styled to be noticed: a filled gold band, the title in the display
 * face, the facts in a ruled block. Gold rather than brick, because spec §9
 * reserves brick for overdue and says "never decoratively" — a duplicate is a
 * question, not an emergency.
 *
 * It never blocks. Spec §6: "Never silently block." Every use has a way
 * through, and the way through is the first button.
 */

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** One block per thing that looks odd. Usually one. */
  points: React.ReactNode[];
  /** The question, asked once, under the facts. */
  question?: string;
  /** The way through. Named for what it does, per spec §8. */
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  points,
  question,
  confirmLabel,
  cancelLabel = 'Go back',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onCancel();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center px-6"
      role="alertdialog"
      aria-modal="true"
      aria-label={title}
    >
      {/*
        The backdrop is a convenience for mouse and thumb, not a control. It is
        hidden from assistive technology because the explicit button below
        already does the same job — two elements announcing the same name is
        confusing to hear, and a test caught exactly that collision.
        Keyboard users have Escape, handled above.
      */}
      <div aria-hidden onClick={onCancel} className="absolute inset-0 bg-ink/60" />

      <div className="row-in relative w-full max-w-[380px] overflow-hidden rounded-sm bg-card shadow-[0_6px_36px_rgba(18,56,75,0.35)]">
        <div className="bg-gold px-4 py-3">
          <h2
            className="text-h2 text-ink"
            style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.02em' }}
          >
            {title}
          </h2>
        </div>

        <div className="px-4 py-4">
          <ul>
            {points.map((point, index) => (
              <li
                key={index}
                className="border-t border-hair py-3 text-base leading-snug text-ink first:border-t-0 first:pt-0"
              >
                {point}
              </li>
            ))}
          </ul>

          {question ? <p className="mt-3 text-base font-medium text-ink">{question}</p> : null}

          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={onConfirm}
              className="touch flex-1 rounded-sm bg-ink px-3 text-base text-snow"
            >
              {confirmLabel}
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="touch flex-1 rounded-sm border border-hair bg-card px-3 text-base text-ink"
            >
              {cancelLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
