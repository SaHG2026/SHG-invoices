import { describe, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { writeFileSync, readFileSync } from 'node:fs';
import { ToastProvider } from '@/components/ui/Toast';
import {
  BUSINESSES,
  FIXTURE_TODAY,
  PROFILES,
  SUPPLIERS,
  makeAwaitingReview,
  makeInvoices,
} from './fixtures/invoices';

/**
 * Not a test — a way to look at the supplier page.
 *
 * The same device as `preview-dashboard` and `preview-venue`, for the same
 * reason: the app is behind a sign-in, so this renders the real component
 * against the real fixture and writes the markup out with the built
 * stylesheet. What gets looked at is the component's own output.
 *
 * This screen earned one on the day it was written: it cannot be seen at all
 * until a shop has entered an invoice and nobody has approved it, which is a
 * state that only exists in production and only for a few minutes at a time.
 *
 * Skipped by default:
 *   PREVIEW_OUT=… PREVIEW_CSS=… npx vitest run test/preview-supplier.test.tsx
 */

const invoices = makeInvoices(40).map((invoice, i) => ({
  ...invoice,
  created_by: PROFILES[i % PROFILES.length]!.id,
}));

const supplier = SUPPLIERS[0]!;

/** The row a shop picks when the supplier is not on the list. */
const PLACEHOLDER = {
  id: 's-unlisted',
  name: 'Supplier not listed',
  default_terms_days: null,
  contact_name: null,
  contact_phone: null,
  notes: null,
  active: true,
  is_placeholder: true,
};

/** Two shops' morning: one ordinary entry, one from somebody new. */
const waiting = makeAwaitingReview(3).map((invoice, i) => ({
  ...invoice,
  business_id: BUSINESSES[i % 2]!.id,
  business: BUSINESSES[i % 2]!,
  supplier:
    i === 1
      ? { id: PLACEHOLDER.id, name: PLACEHOLDER.name, is_placeholder: true }
      : { id: supplier.id, name: supplier.name, is_placeholder: false },
}));

const NOTES: Record<string, string[]> = {
  [waiting[1]!.id]: ['From Riverina Meats — new supplier, first delivery today'],
  [waiting[0]!.id]: ['Two crates short, credit expected'],
};

vi.mock('@/hooks/use-sydney-today', () => ({ useSydneyToday: () => FIXTURE_TODAY }));

vi.mock('@/lib/queries/session', () => ({
  useCurrentProfile: () => ({ data: PROFILES[0], isLoading: false, isError: false }),
  useProfiles: () => ({ data: PROFILES }),
  useTeam: () => ({ data: PROFILES.filter((person) => person.role !== 'builder') }),
  useSignOut: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateNotifyPreference: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateReminderTime: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/lib/queries/invoices', () => ({
  useUnpaidInvoices: () => ({ data: invoices, isLoading: false }),
  useCreateInvoice: () => ({ mutateAsync: vi.fn(), isPending: false }),
  findDuplicates: vi.fn(),
}));

vi.mock('@/lib/queries/reference', () => ({
  useBusinesses: () => ({ data: BUSINESSES }),
  useSuppliers: () => ({ data: [...SUPPLIERS, PLACEHOLDER] }),
  useCreateSupplier: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/lib/queries/detail', () => ({
  useRecentActivity: () => ({ data: [] }),
  useInvoice: () => ({ data: null, isLoading: false }),
  useInvoiceActivity: () => ({ data: [] }),
  useInvoiceNotes: () => ({ data: [] }),
  useAddNote: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

/*
 * The sixth mock. HANDOFF §5's "mock all five" is now six: the drawer's Review
 * badge and the dashboard's Review card both read `useAwaitingReview`, and
 * AppChrome puts the drawer within reach of every screen — so a file that
 * mocks only what it thinks it needs passes alone and fails in the suite.
 */
vi.mock('@/lib/queries/review', () => ({
  useAwaitingReview: () => ({ data: waiting, isLoading: false }),
  useReviewNotes: () => ({ data: NOTES }),
  useApproveInvoices: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useReassignSupplier: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/lib/queries/payments', () => ({
  useMarkPaid: () => ({
    mutateAsync: vi.fn().mockResolvedValue({ paid: [], missed: [] }),
    isPending: false,
  }),
  useUnmarkPaid: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useVoidInvoice: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('next/navigation', () => ({ usePathname: () => '/review' }));

const OUT = process.env.PREVIEW_OUT ?? '';
const CSS = process.env.PREVIEW_CSS ?? '';

describe('preview', () => {
  it.skipIf(!OUT)('snapshot', async () => {
    const { ReviewList } = await import('@/components/screens/ReviewList');

    const page = render(
      <ToastProvider>
        <ReviewList />
      </ToastProvider>,
    );
    const html = page.container.innerHTML;

    const css = CSS ? readFileSync(CSS, 'utf8') : '';
    const wrap = (body: string) =>
      `<!doctype html><html lang="en-AU"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Review preview</title>
<style>${css}</style>
<style>body{background:var(--page);margin:0}</style>
</head><body>${body}</body></html>`;

    writeFileSync(OUT, wrap(html), 'utf8');
    page.unmount();
  });
});
