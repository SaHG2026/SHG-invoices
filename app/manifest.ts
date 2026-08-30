import type { MetadataRoute } from 'next';

/**
 * The PWA manifest, from the client's icon set.
 *
 * Written as a route rather than a static public/manifest.json so the brand
 * navy is declared once and TypeScript checks the shape. Next serves it at
 * /manifest.webmanifest and links it automatically.
 *
 * Phase 7 is where the PWA proper lands — service worker, offline shell, the
 * write queue. This is only the part that makes the app installable, brought
 * forward because the icons arrived and because push notifications on iOS
 * require the app to be on the home screen first (ARCHITECTURE §8.1). Getting
 * it installable early means that requirement is already met when Phase 7
 * turns push on.
 */

/**
 * The app's own deep green. Also the splash and browser chrome.
 *
 * The one hex outside app/globals.css, and unavoidably so: a web manifest is
 * JSON served at build time, and JSON cannot read a CSS variable. It is kept
 * in sync by hand with `--brand`. If the brand green ever changes, both move.
 */
export const BRAND_GREEN = '#04351E';

export default function manifest(): MetadataRoute.Manifest {
  return {
    // The name people call it. `short_name` is the home-screen label, kept to
    // three characters because both iOS and Android truncate it — and a
    // truncated label is worse than a short one. Changing either only shows up
    // on a device that reinstalls the app; an existing home-screen icon keeps
    // whatever it was added with.
    name: 'SHG Invoices',
    short_name: 'SHG',
    description: 'Supplier invoices and payments for Sagarmatha Holdings Group',
    start_url: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: BRAND_GREEN,
    theme_color: BRAND_GREEN,
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      {
        src: '/icons/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
