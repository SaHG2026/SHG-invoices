import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Offline — SHG Invoices' };

/**
 * What the service worker serves when a page is asked for and there is no
 * network.
 *
 * It exists because the alternative was the browser's own dinosaur, which says
 * nothing about the thing people will actually be worried about at that
 * moment: whether the invoice they just entered is gone.
 *
 * So the page answers that question first and says nothing else. It carries no
 * figures and no cached lists — ARCHITECTURE §7 is explicit that reads are
 * never persisted, and a screen showing Tuesday's totals with no date on them
 * is worse than a screen showing none.
 */
export default function OfflinePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-[560px] flex-col justify-center px-6">
      <p className="mb-2 text-xs uppercase tracking-widest text-muted">No connection</p>

      <h1 className="mb-4 text-h1 text-ink" style={{ fontFamily: 'var(--font-display)' }}>
        You&rsquo;re offline
      </h1>

      <p className="mb-3 text-base text-ink">
        Anything you saved is on this phone and will send by itself when the signal comes back.
      </p>

      <p className="text-sm text-muted">
        Totals and lists need the network, so they are not shown rather than shown out of date.
      </p>
    </main>
  );
}
