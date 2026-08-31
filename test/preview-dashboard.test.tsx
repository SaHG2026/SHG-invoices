import { describe, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { writeFileSync, readFileSync } from 'node:fs';
import { ToastProvider } from '@/components/ui/Toast';
import { BUSINESSES, FIXTURE_TODAY, PROFILES, SUPPLIERS, makeInvoices } from './fixtures/invoices';

/**
 * Not a test — a way to look at the dashboard.
 *
 * The app is behind a sign-in, so the real screen cannot be opened without a
 * session. This renders the actual component against the actual fixture and
 * writes the markup out with the built stylesheet, so what gets looked at is
 * the component's own output rather than a drawing of it.
 *
 * Skipped by default. Run it deliberately:
 *   npx vitest run test/preview-dashboard.test.tsx -t snapshot
 */

const invoices = makeInvoices(40).map((invoice, i) => ({
  ...invoice,
  created_by: PROFILES[i % PROFILES.length]!.id,
}));

vi.mock('@/hooks/use-sydney-today', () => ({ useSydneyToday: () => FIXTURE_TODAY }));

vi.mock('@/lib/queries/session', () => ({
  useCurrentProfile: () => ({ data: PROFILES[0], isLoading: false, isError: false }),
  useProfiles: () => ({ data: PROFILES }),
  useTeam: () => ({ data: PROFILES.filter((person) => person.role !== 'builder') }),
  useSignOut: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateNotifyPreference: () => ({ mutateAsync: vi.fn(), isPending: false }),
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

vi.mock('@/lib/queries/detail', () => ({
  useRecentActivity: () => ({ data: [] }),
  useInvoice: () => ({ data: null, isLoading: false }),
  useInvoiceActivity: () => ({ data: [] }),
  useInvoiceNotes: () => ({ data: [] }),
  useAddNote: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/lib/queries/payments', () => ({
  useMarkPaid: () => ({
    mutateAsync: vi.fn().mockResolvedValue({ paid: [], missed: [] }),
    isPending: false,
  }),
  useUnmarkPaid: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useVoidInvoice: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

const pathname = { current: '/' };
vi.mock('next/navigation', () => ({ usePathname: () => pathname.current }));

const OUT = process.env.PREVIEW_OUT ?? '';
const CSS = process.env.PREVIEW_CSS ?? '';

describe('preview', () => {
  it.skipIf(!OUT)('snapshot', async () => {
    const Dashboard = (await import('@/app/(app)/page')).default;
    const { NavDrawer } = await import('@/components/app/NavDrawer');
    const { AddInvoiceSheet } = await import('@/components/invoice/AddInvoiceSheet');

    const closed = render(
      <ToastProvider>
        <Dashboard />
      </ToastProvider>,
    );
    const dashboardHtml = closed.container.innerHTML;
    closed.unmount();

    const open = render(
      <ToastProvider>
        <Dashboard />
        <NavDrawer onClose={() => {}} />
      </ToastProvider>,
    );
    const drawerHtml = open.container.innerHTML;

    // The add-invoice sheet, which is the screen that has to survive a
    // keyboard. Rendered inside the dashboard so it sits over a real page.
    const sheet = render(
      <ToastProvider>
        <Dashboard />
        <AddInvoiceSheet open onClose={() => {}} />
      </ToastProvider>,
    );
    const sheetHtml = sheet.container.innerHTML;

    const css = CSS ? readFileSync(CSS, 'utf8') : '';

    /*
     * One page per state, not two frames side by side.
     *
     * The drawer and the New invoice bar are position:fixed, so inside a
     * shrunk preview frame they anchor to the viewport and cover the other
     * frame. Separate pages let each state be looked at as it actually sits
     * on a phone.
     */
    const page = (body: string) =>
      `<!doctype html><html lang="en-AU"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dashboard preview</title>
<style>${css}</style>
<style>body{background:var(--page);margin:0}</style>
</head><body>${body}</body></html>`;

    writeFileSync(OUT, page(dashboardHtml), 'utf8');
    writeFileSync(OUT.replace(/\.html$/, '-menu.html'), page(drawerHtml), 'utf8');
    writeFileSync(OUT.replace(/\.html$/, '-sheet.html'), page(sheetHtml), 'utf8');

    open.unmount();
    sheet.unmount();
  });
});
