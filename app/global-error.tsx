'use client';

import { useEffect } from 'react';

/**
 * The last boundary. Catches what `(app)/error.tsx` cannot: a failure in the
 * root layout itself — the fonts, the providers, the query client.
 *
 * It replaces the whole document, which is why it renders its own `<html>` and
 * `<body>`: at the point this runs, the layout that would normally provide
 * them is the thing that broke.
 *
 * **Styled inline, with no class names.** Every other screen in this app uses
 * tokens from `app/globals.css`, and rule 3 says hex belongs only there. This
 * is the one file that cannot rely on that stylesheet having loaded — a failure
 * in the root layout is exactly the case where it has not. Inline styles with
 * literal colours are the only thing guaranteed to render, and a boundary that
 * renders unstyled white-on-white is not a boundary. The values are the brand
 * green and paper from `globals.css`, copied deliberately, like the one in
 * `app/manifest.ts`.
 */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    console.error('[shg] the app failed to start', error);
  }, [error]);

  return (
    <html lang="en-AU">
      <body
        style={{
          margin: 0,
          minHeight: '100dvh',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          padding: '0 24px',
          background: '#FBFAF7',
          color: '#04351E',
          fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif',
        }}
      >
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: '0 0 16px' }}>
          SHG Invoices didn&rsquo;t start
        </h1>

        <p style={{ fontSize: 16, lineHeight: 1.5, margin: '0 0 24px' }}>
          Nothing has been lost — this is the app failing to open, not the ledger. Closing it and
          opening it again usually fixes it.
        </p>

        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            minHeight: 44,
            border: 'none',
            borderRadius: 999,
            background: '#04351E',
            color: '#FBFAF7',
            fontSize: 16,
            fontWeight: 500,
          }}
        >
          Reload
        </button>

        {error.digest ? (
          <p style={{ fontSize: 12, opacity: 0.6, marginTop: 24 }}>Reference {error.digest}</p>
        ) : null}
      </body>
    </html>
  );
}
