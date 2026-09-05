import { describe, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { writeFileSync, readFileSync } from 'node:fs';
import { ToastProvider } from '@/components/ui/Toast';
import { BUSINESSES, FIXTURE_TODAY, PROFILES, SUPPLIERS, makeInvoices } from './fixtures/invoices';

/**
 * Not a test — a way to look at the supplier page.
 *
 * The same device as `preview-dashboard` and `preview-venue`, for the same
 * reason: the app is behind a sign-in, so this renders the real component
 * against the real fixture and writes the markup out with the built
 * stylesheet. What gets looked at is the component's own output.
 *
 * This screen earned one when the date range and the two header actions
 * landed on it. It is now the densest page in the app and there was no way to
 * see it without a session and a real supplier.
 *
 * Skipped by default:
 *   PREVIEW_OUT=… PREVIEW_CSS=… npx vitest run test/preview-supplier.test.tsx
 */

const invoices = makeInvoices(40).map((invoice, i) => ({
  ...invoice,
  created_by: PROFILES[i % PROFILES.length]!.id,
}));

const supplier = SUPPLIERS[0]!;
const mine = invoices.filter((invoice) => invoice.supplier_id === supplier.id);

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
  useSuppliers: () => ({ data: SUPPLIERS }),
  useCreateSupplier: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/lib/queries/history', () => ({
  useAllSuppliers: () => ({ data: SUPPLIERS, isLoading: false }),
  useSupplierInvoices: () => ({ data: mine, isLoading: false }),
  useUpdateSupplier: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useHistory: () => ({ data: [], isLoading: false }),
  useSupplierRange: () => ({ data: { rows: mine, truncated: false }, isLoading: false, isError: false }),
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
  useAwaitingReview: () => ({ data: [], isLoading: false }),
  useReviewNotes: () => ({ data: {} }),
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

vi.mock('next/navigation', () => ({ usePathname: () => `/suppliers/${supplier.id}` }));

const OUT = process.env.PREVIEW_OUT ?? '';
const CSS = process.env.PREVIEW_CSS ?? '';

describe('preview', () => {
  it.skipIf(!OUT)('snapshot', async () => {
    const { SupplierDetail } = await import('@/components/screens/SupplierDetail');

    const page = render(
      <ToastProvider>
        <SupplierDetail id={supplier.id} />
      </ToastProvider>,
    );
    const html = page.container.innerHTML;

    const css = CSS ? readFileSync(CSS, 'utf8') : '';
    const wrap = (body: string) =>
      `<!doctype html><html lang="en-AU"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Supplier preview</title>
<style>${css}</style>
<style>body{background:var(--page);margin:0}</style>
</head><body>${body}</body></html>`;

    writeFileSync(OUT, wrap(html), 'utf8');
    page.unmount();
  });
});
