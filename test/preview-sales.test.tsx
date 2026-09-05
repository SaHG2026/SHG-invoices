import { describe, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { writeFileSync, readFileSync } from 'node:fs';
import { ToastProvider } from '@/components/ui/Toast';
import { BUSINESSES, FIXTURE_TODAY, PROFILES } from './fixtures/invoices';
import type { Customer, Product, SalesInvoiceLine, SalesInvoiceRow } from '@/lib/types';

/**
 * Deli composes an invoice, and prints it.
 *
 * ---------------------------------------------------------------------------
 * What these are actually guarding
 *
 * A number that goes on a piece of paper handed to a customer. Everywhere else
 * in this app a wrong figure is a wrong screen somebody can refresh; here it is
 * a document in somebody else's hands that disagrees with your copy.
 *
 * So: the running total is the sum of the lines rendered beside it, the payload
 * sent is exactly what was typed, the price is COPIED off the product rather
 * than linked to it, and the document prints itself rather than being rebuilt
 * into a second hidden copy that could drift.
 * ---------------------------------------------------------------------------
 */

const deli = BUSINESSES.find((entry: { code: string }) => entry.code === 'DDL')!;

const CUSTOMERS: Customer[] = [
  {
    id: 'c-1',
    name: 'Harris Farm Markets',
    contact_name: 'Jo',
    contact_phone: '02 9000 0000',
    contact_email: 'jo@example.com',
    notes: null,
    active: true,
  },
];

const PRODUCTS: Product[] = [
  { id: 'p-1', business_id: deli.id, name: 'Momo (pork)', unit: 'box', unit_price_cents: 2_500, active: true },
  { id: 'p-2', business_id: deli.id, name: 'Achar', unit: 'jar', unit_price_cents: 899, active: true },
];

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  push: vi.fn(),
  detail: { current: null as unknown },
}));

vi.mock('@/lib/queries/session', () => ({
  useCurrentProfile: () => ({ data: PROFILES[0], isLoading: false, isError: false }),
  useProfiles: () => ({ data: PROFILES }),
  useTeam: () => ({ data: PROFILES }),
  useSignOut: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateNotifyPreference: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateReminderTime: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/lib/queries/reference', () => ({
  useBusinesses: () => ({ data: BUSINESSES }),
  useSuppliers: () => ({ data: [] }),
  useCreateSupplier: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/lib/queries/customers', () => ({
  useCustomers: () => ({ data: CUSTOMERS }),
  useAllCustomers: () => ({ data: CUSTOMERS, isLoading: false, isError: false }),
  useCreateCustomer: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateCustomer: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/lib/queries/products', () => ({
  useProducts: () => ({ data: PRODUCTS, isLoading: false }),
  useAllProducts: () => ({ data: PRODUCTS, isLoading: false }),
  useCreateProduct: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateProduct: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/lib/queries/sales', () => ({
  useCreateSalesInvoice: () => ({ mutateAsync: mocks.create, mutate: mocks.create, isPending: false }),
  useSalesInvoice: () => ({ data: mocks.detail.current, isLoading: false, isError: false }),
  useOutstandingSales: () => ({ data: [] }),
  useCustomerSales: () => ({ data: [] }),
  useMarkReceived: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUnmarkReceived: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/lib/queries/detail', () => ({
  useRecentActivity: () => ({ data: [] }),
  useInvoice: () => ({ data: null, isLoading: false }),
  useInvoiceActivity: () => ({ data: [] }),
  useInvoiceNotes: () => ({ data: [] }),
  useAddNote: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/lib/queries/review', () => ({
  useAwaitingReview: () => ({ data: [], isLoading: false }),
  useReviewNotes: () => ({ data: {} }),
  useApproveInvoices: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useReassignSupplier: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/lib/queries/invoices', () => ({
  useUnpaidInvoices: () => ({ data: [], isLoading: false }),
  useCreateInvoice: () => ({ mutateAsync: vi.fn(), isPending: false }),
  findDuplicates: vi.fn(),
}));

vi.mock('@/lib/queries/payments', () => ({
  useMarkPaid: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUnmarkPaid: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useVoidInvoice: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/use-sydney-today', () => ({ useSydneyToday: () => FIXTURE_TODAY }));

vi.mock('next/navigation', () => ({
  usePathname: () => '/sales/new',
  useRouter: () => ({ push: mocks.push, replace: vi.fn() }),
}));

const { ComposeSalesInvoice } = await import('@/components/screens/ComposeSalesInvoice');
const { SalesInvoiceDocument } = await import('@/components/screens/SalesInvoiceDocument');

function compose() {
  return render(
    <ToastProvider>
      <ComposeSalesInvoice />
    </ToastProvider>,
  );
}

function document_(id = 'si-1') {
  return render(
    <ToastProvider>
      <SalesInvoiceDocument id={id} />
    </ToastProvider>,
  );
}


const LINES: SalesInvoiceLine[] = [
  { id: 'l-1', sales_invoice_id: 'si-1', position: 0, product_id: 'p-1', description: 'Momo (pork)', unit: 'box', quantity_milli: 3_000, unit_price_cents: 2_500, line_total_cents: 7_500 },
  { id: 'l-2', sales_invoice_id: 'si-1', position: 1, product_id: 'p-2', description: 'Achar (hot)', unit: 'jar', quantity_milli: 1_500, unit_price_cents: 899, line_total_cents: 1_349 },
  { id: 'l-3', sales_invoice_id: 'si-1', position: 2, product_id: null, description: 'Delivery to Flemington', unit: null, quantity_milli: 1_000, unit_price_cents: 4_000, line_total_cents: 4_000 },
];

const INVOICE: SalesInvoiceRow = {
  id: 'si-1', business_id: deli.id, customer_id: 'c-1',
  invoice_number: 'DDL-0001', invoice_date: '2026-09-05', due_date: '2026-09-19',
  amount_cents: 12_849, status: 'outstanding', received_at: null, received_by: null,
  payment_ref: null, void_reason: null, note: 'Delivered to the back dock.',
  created_by: PROFILES[0]!.id, created_at: '2026-09-05T00:00:00Z', updated_at: '2026-09-05T00:00:00Z',
  customer: { id: 'c-1', name: 'Harris Farm Markets' },
};

mocks.detail.current = { invoice: INVOICE, lines: LINES };

const OUT = process.env.PREVIEW_OUT ?? '';
const CSS = process.env.PREVIEW_CSS ?? '';

/**
 * Not a test — a way to look at the printed document.
 *
 * The one screen in this app that becomes a piece of paper, and it cannot be
 * seen without a customer, products and an issued invoice. The same device as
 * the other previews (ARCHITECTURE §21.6).
 */
describe('preview', () => {
  it.skipIf(!OUT)('snapshot', async () => {
    const { SalesInvoiceDocument } = await import('@/components/screens/SalesInvoiceDocument');
    const { ComposeSalesInvoice } = await import('@/components/screens/ComposeSalesInvoice');

    const doc = render(
      <ToastProvider>
        <SalesInvoiceDocument id="si-1" />
      </ToastProvider>,
    );
    const docHtml = doc.container.innerHTML;
    doc.unmount();

    const composer = render(
      <ToastProvider>
        <ComposeSalesInvoice />
      </ToastProvider>,
    );
    const composeHtml = composer.container.innerHTML;
    composer.unmount();

    const css = CSS ? readFileSync(CSS, 'utf8') : '';
    const page = (title: string, body: string) =>
      `<!doctype html><html lang="en-AU"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>${css}</style>
<style>body{background:var(--page);margin:0}</style>
</head><body>${body}</body></html>`;

    writeFileSync(OUT, page('Invoice document preview', docHtml), 'utf8');
    writeFileSync(OUT.replace(/\.html$/, '-compose.html'), page('Compose preview', composeHtml), 'utf8');
  });
});
