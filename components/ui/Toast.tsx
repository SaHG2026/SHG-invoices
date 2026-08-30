'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

/**
 * Confirmations. Spec §8: "The action name survives into the confirmation —
 * 'Mark paid' becomes 'Marked paid'." No emoji, no exclamation marks.
 *
 * Three tones rather than the usual success/error pair, because notes §1.5
 * needs a third: a write sitting in the offline queue has not succeeded, and
 * giving it a success toast is a lie the person will act on. "Saved — will
 * send when you're back online" is honest; a tick is not.
 */

export type ToastTone = 'done' | 'queued' | 'problem';

interface ToastAction {
  label: string;
  onAct: () => void;
}

interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
  action?: ToastAction;
}

interface ToastApi {
  show: (message: string, tone?: ToastTone, action?: ToastAction) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside <ToastProvider>');
  return context;
}

/**
  * Each tone carries its own text colour rather than inheriting one. A blind
  * rename briefly left dark text on the navy action colour, which was
  * unreadable — the pairing is part of the token, not an afterthought.
  */
const TONE_STYLE: Record<ToastTone, string> = {
  done: 'bg-ink text-white',
  queued: 'bg-today text-white',
  problem: 'bg-overdue text-white',
};

/**
 * Long enough to read a figure and reach for Undo, short enough not to be in
 * the way. An action that can only be undone for four seconds is not much of
 * an undo, so anything offering one gets longer.
 */
const VISIBLE_MS = 4000;
const VISIBLE_WITH_ACTION_MS = 8000;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const show = useCallback(
    (message: string, tone: ToastTone = 'done', action?: ToastAction) => {
      setToasts((current) => [
        ...current,
        { id: Date.now() + Math.random(), tone, message, ...(action ? { action } : {}) },
      ]);
    },
    [],
  );

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  useEffect(() => {
    const first = toasts[0];
    if (!first) return;
    const timer = setTimeout(
      () => setToasts((current) => current.slice(1)),
      first.action ? VISIBLE_WITH_ACTION_MS : VISIBLE_MS,
    );
    return () => clearTimeout(timer);
  }, [toasts]);

  const api = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        // Announced to screen readers without stealing focus mid-entry.
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 z-[60] flex flex-col items-center gap-2"
        style={{ bottom: `calc(1rem + env(safe-area-inset-bottom, 0px))` }}
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`row-in pointer-events-auto mx-4 flex max-w-[calc(100%-2rem)] items-center gap-3 rounded-sm px-4 py-3 text-sm ${TONE_STYLE[toast.tone]}`}
          >
            <span className="min-w-0">{toast.message}</span>
            {toast.action ? (
              <button
                type="button"
                onClick={() => {
                  toast.action!.onAct();
                  dismiss(toast.id);
                }}
                className="shrink-0 font-medium underline"
              >
                {toast.action.label}
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
