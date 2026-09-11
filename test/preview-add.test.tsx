import { describe, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { writeFileSync, readFileSync } from 'node:fs';
import { ToastProvider } from '@/components/ui/Toast';
import { BUSINESSES, FIXTURE_TODAY, PROFILES, SUPPLIERS, makeInvoices } from './fixtures/invoices';
import type { Profile, Supplier } from '@/lib/types';

/**
 * Not a test — a way to LOOK at the four states this round added.
 *
 * The same device as `preview-supplier`, and here for the reason HANDOFF §5
 * gives: two defects in Rounds B and D were invisible to passing assertions
 * and obvious in a browser. Everything below is asserted somewhere else; none
 * of those assertions can see a dialog that is the wrong width, a panel that
 * collides with the search box under it, or a sheet with four options where
 * the thumb expects two.
 *
 * Four pages, because they are four different moments and only one of them
 * can be on screen at a time:
 *
 *   1-suppliers      the titled Add panel, above the search box
 *   2-choice         the `+` asking, on a screen that is not Deli's
 *   3-near-match     "already have this one?", the GFD case
 *   4-unlisted       an assistant on the placeholder, note refused
 *
 * Skipped unless PREVIEW_OUT is set:
 *   PREVIEW_OUT=/tmp/shg PREVIEW_CSS=.next/static/chunks/*.css \
 *     npx vitest run test/preview-add.test.tsx
 */

const invoices = makeInvoices(40);

/* The one seeded placeholder row, for page 4. */
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

const ASSISTANT: Profile = {
  ...PROFILES[1]!,
  role: 'assistant',
};

vi.mock('@/hooks/use-sydney-today', () => ({ useSydneyToday: () => FIXTURE_TODAY }));

/*
 * A knob, not a constant. Pages 1-3 are a manager's screen and page 4 is an
 * assistant's, and §39.8's lesson is that a mock which cannot produce a real
 * state guarantees bugs in it.
 */
const who = { current: PROFILES[0]! };

vi.mock('@/lib/queries/session', () => ({
  useCurrentProfile: () => ({ data: who.current, isLoading: false, isError: false }),
  useProfiles: () => ({ data: PROFILES }),
  useTeam: () => ({ data: PROFILES.filter((person) => person.role !== 'builder') }),
  useSignOut: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/lib/queries/invoices', () => ({
  useUnpaidInvoices: () => ({ data: invoices, isLoading: false }),
  useCreateInvoice: () => ({ mutateAsync: vi.fn(), mutate: vi.fn(), isPending: false }),
  findDuplicates: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/lib/queries/history', () => ({
  useAllSuppliers: () => ({ data: SUPPLIERS, isLoading: false }),
}));

vi.mock('@/lib/queries/reference', () => ({
  useBusinesses: () => ({ data: BUSINESSES }),
  useSuppliers: () => ({ data: [...SUPPLIERS, UNLISTED] }),
  useCreateSupplier: () => ({ mutateAsync: vi.fn(), mutate: vi.fn(), isPending: false }),
  optimisticSupplier: (id: string, name: string) => ({
    id,
    name: name.trim(),
    default_terms_days: null,
    contact_name: null,
    contact_phone: null,
    notes: null,
    active: true,
    is_placeholder: false,
  }),
}));

vi.mock('@/lib/queries/detail', () => ({
  useAddNote: () => ({ mutateAsync: vi.fn(), mutate: vi.fn(), isPending: false }),
  useRecentActivity: () => ({ data: [] }),
  useInvoice: () => ({ data: null, isLoading: false }),
  useInvoiceActivity: () => ({ data: [] }),
  useInvoiceNotes: () => ({ data: [] }),
}));

vi.mock('@/lib/queries/review', () => ({
  useAwaitingReview: () => ({ data: [], isLoading: false }),
}));

vi.mock('next/navigation', () => ({ usePathname: () => '/suppliers' }));

const OUT = process.env.PREVIEW_OUT ?? '';
const CSS = process.env.PREVIEW_CSS ?? '';

describe('preview', () => {
  it.skipIf(!OUT)('the four states', async () => {
    const { SuppliersList } = await import('@/components/screens/SuppliersList');
    const { AddInvoiceSheet } = await import('@/components/invoice/AddInvoiceSheet');

    const css = CSS ? readFileSync(CSS, 'utf8') : '';
    const wrap = (title: string, body: string) =>
      `<!doctype html><html lang="en-AU"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>${css}</style>
<style>body{background:var(--page);margin:0}</style>
</head><body>${body}</body></html>`;

    /*
     * The whole document, not `container.innerHTML`. Both the choice sheet and
     * the near-match dialog render through a portal into `document.body`, so a
     * page written from the container would be the one thing being looked at,
     * missing.
     */
    const writePage = (name: string, title: string) =>
      writeFileSync(`${OUT}/${name}.html`, wrap(title, document.body.innerHTML), 'utf8');

    /* 1 — the list, with the titled Add panel above the search box. */
    who.current = PROFILES[0]!;
    let page = render(
      <ToastProvider>
        <SuppliersList />
      </ToastProvider>,
    );
    writePage('1-suppliers', 'Suppliers — the add panel');

    /* 2 — the `+`, on a screen that is not Deli's: two options, not three. */
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    writePage('2-choice', 'The + on Suppliers');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    /* 3 — the GFD case, which is the one that was asked about. */
    fireEvent.change(screen.getByLabelText('New supplier name'), {
      target: { value: 'Bidfood Pty Ltd' },
    });
    fireEvent.click(screen.getByRole('button', { name: '+ Add' }));
    writePage('3-near-match', 'Already have this one?');
    page.unmount();

    /* 4 — an assistant on the placeholder, with the note refused. */
    who.current = ASSISTANT;
    page = render(
      <ToastProvider>
        <AddInvoiceSheet open onClose={() => {}} />
      </ToastProvider>,
    );
    fireEvent.change(screen.getByLabelText('Supplier'), { target: { value: 'Suppli' } });
    fireEvent.mouseDown(screen.getByRole('button', { name: /Supplier not listed/ }));
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '284.50' } });
    fireEvent.click(screen.getByRole('button', { name: /Save invoice/ }));
    await screen.findByText(/nothing else will know/);
    writePage('4-unlisted', 'Supplier not listed — the note is required');
    page.unmount();
  });
});
