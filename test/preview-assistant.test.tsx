import { describe, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { writeFileSync, readFileSync } from 'node:fs';
import { ToastProvider } from '@/components/ui/Toast';
import { BUSINESSES, FIXTURE_TODAY, PROFILES, SUPPLIERS } from './fixtures/invoices';
import type { ActivityEntry, Profile, Supplier } from '@/lib/types';

/**
 * Not a test — a way to LOOK at what an assistant is shown. §57.
 *
 * Three of the four states this round changed, because the fourth (the menu)
 * is already covered by `nav-drawer` and is a list of strings either way.
 *
 * The one that most needs looking at is `2-picker`: the whole of §57.1 is
 * that "Supplier not listed" was in the list with nothing saying what it was
 * for, and "is the affordance there" is a question about a rendered screen,
 * not about an assertion. A test can only check that the hint's text exists
 * somewhere; whether it reads as an instruction is a thing you look at.
 *
 * Skipped unless PREVIEW_OUT is set:
 *   PREVIEW_OUT=/tmp/shg PREVIEW_CSS=.next/static/chunks/*.css \
 *     npx vitest run test/preview-assistant.test.tsx
 */

const ASSISTANT: Profile = { ...PROFILES[1]!, role: 'assistant' };

const UNLISTED: Supplier = {
  id: 's-unlisted',
  name: 'Supplier not listed',
  default_terms_days: null,
  contact_name: null,
  contact_phone: null,
  notes: null,
  active: true,
  is_placeholder: true,
};

const entry = (id: number, action: string, detail: Record<string, unknown> | null = null) =>
  ({
    id,
    entity_type: 'invoice',
    entity_id: `i-${id}`,
    action,
    actor_id: PROFILES[0]!.id,
    detail,
    created_at: '2026-09-11T02:00:00.000Z',
  }) as ActivityEntry;

const ACTIVITY = [
  entry(1, 'created'),
  entry(2, 'paid', { payment_ref: { from: null, to: 'EFT-8891' } }),
  entry(3, 'edited', { amount_cents: { from: 120000, to: 128450 } }),
  entry(4, 'unpaid'),
  entry(5, 'approved'),
];

vi.mock('@/hooks/use-sydney-today', () => ({ useSydneyToday: () => FIXTURE_TODAY }));

vi.mock('@/lib/queries/session', () => ({
  useCurrentProfile: () => ({ data: ASSISTANT, isLoading: false, isError: false }),
  useProfiles: () => ({ data: PROFILES }),
  useTeam: () => ({ data: PROFILES.filter((p) => p.role !== 'builder') }),
  useSignOut: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/lib/queries/detail', () => ({
  useRecentActivity: () => ({ data: ACTIVITY }),
  useAddNote: () => ({ mutateAsync: vi.fn(), mutate: vi.fn(), isPending: false }),
  useInvoice: () => ({ data: null, isLoading: false }),
  useInvoiceActivity: () => ({ data: [] }),
  useInvoiceNotes: () => ({ data: [] }),
}));

vi.mock('@/lib/queries/reference', () => ({
  useBusinesses: () => ({ data: BUSINESSES }),
  useSuppliers: () => ({ data: [...SUPPLIERS, UNLISTED] }),
  useCreateSupplier: () => ({ mutateAsync: vi.fn(), mutate: vi.fn(), isPending: false }),
  optimisticSupplier: (id: string, name: string) => ({
    id,
    name,
    default_terms_days: null,
    contact_name: null,
    contact_phone: null,
    notes: null,
    active: true,
    is_placeholder: false,
  }),
}));

vi.mock('@/lib/queries/invoices', () => ({
  useUnpaidInvoices: () => ({ data: [], isLoading: false }),
  useCreateInvoice: () => ({ mutateAsync: vi.fn(), mutate: vi.fn(), isPending: false }),
  findDuplicates: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/lib/queries/history', () => ({ useHistory: () => ({ data: [], isLoading: false }) }));
vi.mock('@/lib/queries/review', () => ({ useAwaitingReview: () => ({ data: [] }) }));
vi.mock('next/navigation', () => ({ usePathname: () => '/b/all/history' }));

const OUT = process.env.PREVIEW_OUT ?? '';
const CSS = process.env.PREVIEW_CSS ?? '';

describe('preview', () => {
  it.skipIf(!OUT)('what an assistant sees', async () => {
    const { HistoryList } = await import('@/components/screens/HistoryList');
    const { ActivityBell } = await import('@/components/app/ActivityBell');
    const { AddInvoiceSheet } = await import('@/components/invoice/AddInvoiceSheet');

    const css = CSS ? readFileSync(CSS, 'utf8') : '';
    const wrap = (title: string, body: string) =>
      `<!doctype html><html lang="en-AU"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>${css}</style>
<style>body{background:var(--page);margin:0}</style>
</head><body>${body}</body></html>`;

    const writePage = (name: string, title: string) =>
      writeFileSync(`${OUT}/${name}.html`, wrap(title, document.body.innerHTML), 'utf8');

    /* 1 — the history URL, reached directly. */
    let page = render(
      <ToastProvider>
        <HistoryList scope="all" />
      </ToastProvider>,
    );
    writePage('5-history-refused', 'History, for an assistant');
    page.unmount();

    /*
     * 2 — the supplier picker, browsing, which is the screen §57.1 is about.
     * The placeholder should be visible AND the hint under the field should
     * say what it is for. Before the fix the row was there and the hint was
     * not, which is why it read as absent.
     */
    page = render(
      <ToastProvider>
        <AddInvoiceSheet open onClose={() => {}} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show all suppliers' }));
    writePage('6-picker', 'Supplier not listed, and the hint that names it');
    page.unmount();

    /* 3 — the bell, with two payment entries that must not appear. */
    page = render(
      <ToastProvider>
        <ActivityBell />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Activity/ }));
    writePage('7-bell', 'The bell, with payments filtered out');
    page.unmount();
  });
});
