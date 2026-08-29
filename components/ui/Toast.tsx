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

interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
}

interface ToastApi {
  show: (message: string, tone?: ToastTone) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside <ToastProvider>');
  return context;
}

const TONE_STYLE: Record<ToastTone, string> = {
  done: 'bg-ink text-snow',
  queued: 'bg-gold text-ink',
  problem: 'bg-brick text-snow',
};

/** Long enough to read a reference number, short enough not to be in the way. */
const VISIBLE_MS = 4000;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const show = useCallback((message: string, tone: ToastTone = 'done') => {
    setToasts((current) => [...current, { id: Date.now() + Math.random(), tone, message }]);
  }, []);

  useEffect(() => {
    if (toasts.length === 0) return;
    const timer = setTimeout(() => setToasts((current) => current.slice(1)), VISIBLE_MS);
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
          <p
            key={toast.id}
            className={`row-in mx-4 max-w-[calc(100%-2rem)] rounded-sm px-4 py-3 text-sm ${TONE_STYLE[toast.tone]}`}
          >
            {toast.message}
          </p>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
