'use client';

import { useEffect } from 'react';

/**
 * A small centred dialog for "this looks odd, is it deliberate?".
 *
 * Deliberately a popup rather than an inline panel. An inline warning appears
 * somewhere in a form you have already stopped reading — you have hit save,
 * your attention has left the fields. A popup takes over, states the one fact,
 * and asks one question.
 *
 * It never blocks. Spec §6 on duplicates: "Never silently block." Every use of
 * this has a way through, and the way through is the first button.
 */

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** One line per thing that looks odd. Usually one. */
  points: React.ReactNode[];
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
      <div aria-hidden onClick={onCancel} className="absolute inset-0 bg-ink/50" />

      <div className="relative w-full max-w-[360px] rounded-sm border-l-[3px] border-gold bg-card p-4 shadow-[0_4px_28px_rgba(18,56,75,0.28)]">
        <h2 className="text-h2 text-ink" style={{ fontFamily: 'var(--font-display)' }}>
          {title}
        </h2>

        <ul className="mt-3">
          {points.map((point, index) => (
            <li key={index} className="border-t border-hair py-2 text-sm text-ink first:border-t-0">
              {point}
            </li>
          ))}
        </ul>

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={onConfirm}
            className="touch flex-1 rounded-sm bg-ink px-3 text-sm text-snow"
          >
            {confirmLabel}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="touch flex-1 rounded-sm border border-hair bg-card px-3 text-sm text-ink"
          >
            {cancelLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
