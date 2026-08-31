'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import type { Route } from 'next';

/**
 * The error boundary for every signed-in screen.
 *
 * Before this file, a thrown render error anywhere under `(app)` took the
 * whole app to a blank white page — no header, no menu, no way back except the
 * phone's own back button, and no indication whether anything had been saved.
 *
 * ---------------------------------------------------------------------------
 * Three things this page says, in the order somebody standing in a shop needs
 * them:
 *
 * 1. **Your data is fine.** It is the first question and the app is the only
 *    thing that can answer it. This screen broke; the ledger did not, and
 *    nothing here writes.
 * 2. **Try again**, which for a transient failure — a fetch that lost the
 *    network mid-render — is genuinely all it takes. `reset()` re-renders the
 *    segment without a full reload, so the query cache survives.
 * 3. **A way out**, because "try again" failing twice is a dead end otherwise.
 *
 * What it does NOT say is what went wrong. `error.message` from a production
 * React build is a digest — "Minified React error #418" — which tells the
 * person nothing and reads as if the app is blaming them. It goes to the
 * console instead, where it is useful to whoever is asked to look.
 * ---------------------------------------------------------------------------
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The one place the detail exists. Left as console rather than sent
    // anywhere: there is no error-reporting service in this project and adding
    // one would put every invoice number in it.
    console.error('[shg] screen failed to render', error);
  }, [error]);

  return (
    <main className="mx-auto flex min-h-dvh max-w-[560px] flex-col justify-center px-6">
      <p className="mb-2 text-xs uppercase tracking-widest text-muted">Something went wrong</p>

      <h1 className="mb-4 text-h1 text-ink" style={{ fontFamily: 'var(--font-display)' }}>
        This screen didn&rsquo;t load
      </h1>

      <p className="mb-6 text-base text-ink">
        Nothing has been lost. No invoice was changed, and anything waiting to send is still on this
        phone.
      </p>

      <button
        type="button"
        onClick={reset}
        className="touch mb-3 flex w-full items-center justify-center rounded-full bg-action px-4 text-base font-medium text-action-text"
      >
        Try again
      </button>

      <Link
        href={'/' as Route}
        className="touch flex w-full items-center justify-center rounded-full border border-hairline px-4 text-base text-ink"
      >
        Go home
      </Link>

      {error.digest ? (
        <p className="mt-6 text-xs text-muted">
          Reference <span style={{ fontFamily: 'var(--font-mono)' }}>{error.digest}</span>
        </p>
      ) : null}
    </main>
  );
}
