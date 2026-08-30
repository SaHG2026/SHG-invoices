import type { Metadata, Viewport } from 'next';
import { Archivo, IBM_Plex_Mono, IBM_Plex_Sans } from 'next/font/google';
import { Providers } from './providers';
import { BRAND_NAVY } from './manifest';
import './globals.css';

/**
 * Spec §9. Archivo for display — a grotesque with slightly squared terminals
 * that reads as signage rather than as a startup. Plex Sans for body, Plex
 * Mono for every figure, because money is mono and dockets are mono.
 *
 * Loaded through next/font so they are self-hosted at build time: no request
 * to Google at runtime, no layout shift, and they work on a back dock with
 * bad wifi.
 */
const archivo = Archivo({
  subsets: ['latin'],
  weight: ['600', '700'],
  variable: '--font-archivo',
  display: 'swap',
});

const plexSans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-sans',
  display: 'swap',
});

const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-plex-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'SHG Payments',
  description: 'Sagarmatha Holdings Group — supplier invoices and payments',
  // iOS ignores the manifest's icons for the home screen and uses this one.
  appleWebApp: { capable: true, title: 'SHG Pay', statusBarStyle: 'black-translucent' },
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/icons/icon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
    apple: [{ url: '/icons/icon-180.png', sizes: '180x180', type: 'image/png' }],
  },
};

export const viewport: Viewport = {
  // Matches the icon artwork's own navy, so the splash screen and the browser
  // chrome are the same colour as the thing you tapped to get here.
  themeColor: BRAND_NAVY,
  width: 'device-width',
  initialScale: 1,
  // The add-invoice sheet has to survive the on-screen keyboard (notes §4),
  // and a zoom-locked viewport is what stops iOS jumping when a field focuses.
  maximumScale: 5,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-AU" className={`${archivo.variable} ${plexSans.variable} ${plexMono.variable}`}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
