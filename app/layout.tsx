import type { Metadata, Viewport } from 'next';
import { Archivo, IBM_Plex_Mono, IBM_Plex_Sans } from 'next/font/google';
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
};

export const viewport: Viewport = {
  themeColor: '#12384B',
  width: 'device-width',
  initialScale: 1,
  // The add-invoice sheet has to survive the on-screen keyboard (notes §4),
  // and a zoom-locked viewport is what stops iOS jumping when a field focuses.
  maximumScale: 5,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-AU" className={`${archivo.variable} ${plexSans.variable} ${plexMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
