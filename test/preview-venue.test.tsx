import { describe, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { writeFileSync, readFileSync } from 'node:fs';
import { ToastProvider } from '@/components/ui/Toast';
import { PROFILES, SUPPLIERS, VENUE_PROFILE } from './fixtures/invoices';
import type { StaffInvoice } from '@/lib/types';

/**
 * Not a test — a way to look at the venue screen.
 *
 * The sibling of `preview-dashboard.test.tsx`, and it matters more than that
 * one did: these accounts do not exist yet. Until `CATCH_UP_010` §8 is run
 * there is no venue login to sign in as, so this is the ONLY way to see what a
 * shop will be shown — before the accounts are created, and without a deploy.
 *
 * Skipped by default. ARCHITECTURE §21.6 has the four commands; this one takes
 * the same two environment variables.
 */

/**
 * A believable month and a bit. Deliberately hand-written rather than derived
 * from `makeInvoices`: that fixture builds `InvoiceRow`s, which carry `status`
 * and `paid_at` — the exact columns a venue never receives. Reusing it would
 * mean the preview was rendering a shape the real screen can never be given.
 */
const rows: StaffInvoice[] = [
  ['Bidfood', 'BF-9142', '2026-09-03', 522000],
  ['Sydney Fresh Produce', 'SF-2201', '2026-09-03', 86440],
  ['Anchor Dairy', null, '2026-09-01', 118050],
  ['Coca-Cola Europacific', 'CCE-55180', '2026-08-28', 240900],
  ['Bidfood', 'BF-9098', '2026-08-24', 498300],
  ['Riverina Meats', 'RM-771', '2026-08-19', 315600],
  ['Southern Cross Packaging', null, '2026-08-11', 42750],
].map(([supplier, number, date, cents], index) => ({
  id: `preview-${index}`,
  business_id: 'b-gmp',
  supplier_id: `s-${index}`,
  supplier_name: supplier as string,
  invoice_number: number as string | null,
  internal_ref: `GMP-${(date as string).slice(2).replace(/-/g, '')}-0${index + 1}`,
  invoice_date: date as string,
  due_date: date as string,
  amount_cents: cents as number,
  created_at: `${date as string}T09:${String(index * 7).padStart(2, '0')}:00.000Z`,
}));

vi.mock('@/lib/queries/venue', () => ({
  useVenueInvoices: () => ({ data: rows, isLoading: false, isError: false }),
  useCreateVenueInvoice: () => ({ mutateAsync: vi.fn(), isPending: false }),
  findVenueDuplicates: vi.fn(),
}));

vi.mock('@/lib/queries/session', () => ({
  useCurrentProfile: () => ({ data: VENUE_PROFILE, isLoading: false, isError: false }),
  useProfiles: () => ({ data: PROFILES }),
}));

vi.mock('@/lib/queries/reference', () => ({
  useSuppliers: () => ({ data: SUPPLIERS }),
  useCreateSupplier: () => ({ mutateAsync: vi.fn(), isPending: false }),
  optimisticSupplier: (id: string, name: string) => ({
    id,
    name,
    default_terms_days: null,
    contact_name: null,
    contact_phone: null,
    notes: null,
    active: true,
  }),
}));

vi.mock('@/lib/offline/pending', () => ({
  useQueuedWriteCount: () => 0,
  useIsOnline: () => true,
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/venue',
  useRouter: () => ({ replace: vi.fn() }),
}));

const OUT = process.env.PREVIEW_OUT ?? '';
const CSS = process.env.PREVIEW_CSS ?? '';

describe('preview', () => {
  it.skipIf(!OUT)('venue', async () => {
    const { VenueInvoices } = await import('@/components/screens/VenueInvoices');
    const { AddVenueInvoiceSheet } = await import('@/components/invoice/AddVenueInvoiceSheet');

    const list = render(
      <ToastProvider>
        <VenueInvoices />
      </ToastProvider>,
    );
    const listHtml = list.container.innerHTML;
    list.unmount();

    const sheet = render(
      <ToastProvider>
        <VenueInvoices />
        <AddVenueInvoiceSheet open onClose={() => {}} />
      </ToastProvider>,
    );
    const sheetHtml = sheet.container.innerHTML;

    const css = CSS ? readFileSync(CSS, 'utf8') : '';

    // One page per state — the sheet is position:fixed and would cover the
    // list if they shared a page. Same reasoning as the dashboard preview.
    const page = (title: string, body: string) =>
      `<!doctype html><html lang="en-AU"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>${css}</style>
<style>body{background:var(--page);margin:0}</style>
</head><body>${body}</body></html>`;

    writeFileSync(OUT, page('Venue preview', listHtml), 'utf8');
    writeFileSync(OUT.replace(/\.html$/, '-sheet.html'), page('Venue sheet', sheetHtml), 'utf8');

    sheet.unmount();
  });
});
