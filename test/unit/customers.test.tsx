import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync, writeFileSync } from 'node:fs';
import { ToastProvider } from '@/components/ui/Toast';
import { BUSINESSES, PROFILES, SUPPLIERS, makeInvoices } from '../fixtures/invoices';
import { filterCustomers, orderCustomers } from '@/lib/derive/customer-match';
import { formatCents } from '@/lib/money';
import { summarise } from '@/lib/derive/select';
import type { Customer, SalesInvoiceRow } from '@/lib/types';

/**
 * Customers. ARCHITECTURE §17.
 *
 * The client's condition on this feature was one sentence: the number must not
 * affect owed or pending. The last describe block below is that condition,
 * written as a test — and it passes for a structural reason rather than a
 * careful one. A customer record has no amount on it, so there is no figure
 * for a total to pick up. If someone later adds a balance column to make a
 * customer page look more useful, these tests are what will notice.
 */

const CUSTOMERS: Customer[] = [
  {
    id: 'c-1',
    name: 'Harris Farm Markets',
    contact_name: 'Dan',
    contact_phone: '0400 111 222',
    contact_email: 'dan@example.com',
    notes: null,
    active: true,
  },
  {
    id: 'c-2',
    name: 'Alpine Grocers',
    contact_name: null,
    contact_phone: null,
    contact_email: null,
    notes: null,
    active: true,
  },
  {
    id: 'c-3',
    name: 'Closed Cafe',
    contact_name: null,
    contact_phone: null,
    contact_email: null,
    notes: 'Shut in June.',
    active: false,
  },
];

const invoices = makeInvoices(40);

/** Two invoices Deli Delights has sent to Harris Farm, one of them late. */
const SALES: SalesInvoiceRow[] = [
  {
    id: 'sv-1',
    business_id: 'b-ddl',
    customer_id: 'c-1',
    invoice_number: 'DD-1001',
    invoice_date: '2026-08-01',
    due_date: '2026-08-15',
    amount_cents: 120_000,
    status: 'outstanding',
    received_at: null,
    received_by: null,
    payment_ref: null,
    void_reason: null,
    created_by: 'p-mani',
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    note: null,
    customer: { id: 'c-1', name: 'Harris Farm Markets' },
  },
  {
    id: 'sv-2',
    business_id: 'b-ddl',
    customer_id: 'c-1',
    invoice_number: 'DD-1002',
    invoice_date: '2026-08-20',
    due_date: '2026-09-30',
    amount_cents: 80_000,
    status: 'outstanding',
    received_at: null,
    received_by: null,
    payment_ref: null,
    void_reason: null,
    created_by: 'p-mani',
    created_at: '2026-08-20T00:00:00Z',
    updated_at: '2026-08-20T00:00:00Z',
    note: null,
    customer: { id: 'c-1', name: 'Harris Farm Markets' },
  },
];

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
}));

vi.mock('@/lib/queries/session', () => ({
  useCurrentProfile: () => ({ data: PROFILES[0], isLoading: false, isError: false }),
  useProfiles: () => ({ data: PROFILES }),
  useTeam: () => ({ data: PROFILES.filter((person) => person.role !== 'builder') }),
  useSignOut: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateNotifyPreference: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateReminderTime: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/lib/queries/customers', () => ({
  useAllCustomers: () => ({ data: CUSTOMERS, isLoading: false }),
  useCustomers: () => ({ data: CUSTOMERS.filter((c) => c.active), isLoading: false }),
  useCreateCustomer: () => ({ mutateAsync: mocks.create, mutate: mocks.create, isPending: false }),
  useUpdateCustomer: () => ({ mutateAsync: mocks.update, mutate: mocks.update, isPending: false }),
  optimisticCustomer: (id: string, name: string) => ({
    id,
    name: name.trim(),
    contact_name: null,
    contact_phone: null,
    contact_email: null,
    notes: null,
    active: true,
  }),
}));

vi.mock('@/lib/queries/reference', () => ({
  useBusinesses: () => ({ data: BUSINESSES }),
  useSuppliers: () => ({ data: SUPPLIERS }),
  useCreateSupplier: () => ({ mutateAsync: vi.fn(), mutate: vi.fn(), isPending: false }),
  // The real one, not a stub: it is the single definition of what a brand-new
  // supplier looks like, and a mock of it here would let the sheet and the
  // cache drift apart without a test noticing.
  optimisticSupplier: (id: string, name: string) => ({
    id,
    name: name.trim(),
    default_terms_days: null,
    contact_name: null,
    contact_phone: null,
    notes: null,
    active: true,
  }),

}));

vi.mock('@/lib/queries/invoices', () => ({
  useUnpaidInvoices: () => ({ data: invoices, isLoading: false }),
  useCreateInvoice: () => ({ mutateAsync: vi.fn(), isPending: false }),
  findDuplicates: vi.fn(),
}));

vi.mock('@/lib/queries/detail', () => ({
  useRecentActivity: () => ({ data: [] }),
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

/*
 * The customer screens now read receivables, so this mock is load-bearing:
 * without it the tree reaches a real query and there is no QueryClient in a
 * bare render. HANDOFF §5 — a file that mocks only what it thinks it needs.
 */
vi.mock('@/lib/queries/sales', () => ({
  useOutstandingSales: () => ({ data: SALES, isLoading: false }),
  useCustomerSales: (id: string) => ({
    data: SALES.filter((row) => row.customer_id === id),
    isLoading: false,
  }),
  useCreateSalesInvoice: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useMarkReceived: () => ({
    mutateAsync: vi.fn().mockResolvedValue({ received: [], missed: [] }),
    isPending: false,
  }),
  useUnmarkReceived: () => ({ mutateAsync: vi.fn(), isPending: false }),
  /* The expandable row fetches its own lines, and only once opened. */
  useSalesInvoice: (id: string) => ({
    data: id === '' ? undefined : { invoice: SALES.find((row) => row.id === id), lines: [] },
    isLoading: false,
  }),
}));

vi.mock('next/navigation', () => ({ usePathname: () => '/customers' }));

const { CustomersList } = await import('@/components/screens/CustomersList');
const { CustomerDetail } = await import('@/components/screens/CustomerDetail');
/*
 * Imported HERE, beside the other screen, not inside the preview block.
 *
 * The last test in this file calls `vi.resetModules()`, so anything imported
 * after it comes from a fresh registry with its own Toast context object --
 * and a component holding a different context than the provider wrapping it
 * throws "useToast must be used inside <ToastProvider>". Same trap the
 * `doUnmock` test documents, arrived at from the other side.
 */
const { ReceivablesList } = await import('@/components/screens/ReceivablesList');

function openList() {
  return render(
    <ToastProvider>
      <CustomersList />
    </ToastProvider>,
  );
}

function openDetail(id: string) {
  return render(
    <ToastProvider>
      <CustomerDetail id={id} />
    </ToastProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  mocks.create.mockResolvedValue({ ...CUSTOMERS[0], id: 'c-new', name: 'New Grocer' });
  mocks.update.mockImplementation(async (changes) => ({ ...CUSTOMERS[0], ...changes }));
});

describe('matching and ordering', () => {
  it('finds a customer by name, contact or phone', () => {
    expect(filterCustomers(CUSTOMERS, 'harris').map((c) => c.id)).toEqual(['c-1']);
    expect(filterCustomers(CUSTOMERS, 'dan').map((c) => c.id)).toEqual(['c-1']);
    expect(filterCustomers(CUSTOMERS, '0400').map((c) => c.id)).toEqual(['c-1']);
  });

  it('matches on every word, in any order', () => {
    expect(filterCustomers(CUSTOMERS, 'markets harris').map((c) => c.id)).toEqual(['c-1']);
    expect(filterCustomers(CUSTOMERS, 'harris alpine')).toEqual([]);
  });

  it('still finds a deactivated customer', () => {
    // Unlike the supplier type-ahead, which feeds a picker. This feeds an
    // admin list, where one deactivated by mistake has to stay findable.
    expect(filterCustomers(CUSTOMERS, 'closed').map((c) => c.id)).toEqual(['c-3']);
  });

  it('puts deactivated last — they are history, not choices', () => {
    expect(orderCustomers(CUSTOMERS).map((c) => c.id)).toEqual(['c-2', 'c-1', 'c-3']);
  });

  it('never sorts the query cache array in place', () => {
    const before = CUSTOMERS.map((c) => c.id);
    orderCustomers(CUSTOMERS);
    filterCustomers(CUSTOMERS, '');
    expect(CUSTOMERS.map((c) => c.id)).toEqual(before);
  });
});

describe('the customer list', () => {
  it('shows deactivated customers rather than hiding them', () => {
    openList();
    expect(screen.getByText('Closed Cafe')).toBeInTheDocument();
    expect(screen.getByText(/deactivated/)).toBeInTheDocument();
  });

  it('says whose customers these are without explaining itself', () => {
    // The preamble is gone at the client's request. What has to survive is the
    // screen still being identifiable at a glance.
    openList();
    expect(screen.getByRole('heading', { level: 1, name: 'Customers' })).toBeInTheDocument();
    expect(screen.getByText('Owed to us')).toBeInTheDocument();
  });

  it('adds a customer, and gives the name back if it fails', async () => {
    openList();
    const box = screen.getByLabelText('New customer name');

    fireEvent.change(box, { target: { value: 'New Grocer' } });
    fireEvent.click(screen.getByRole('button', { name: '+ Add' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalled());
    expect(box).toHaveValue('');

    mocks.create.mockRejectedValue(new Error('There is already a customer called X.'));
    fireEvent.change(box, { target: { value: 'Duplicate Co' } });
    fireEvent.click(screen.getByRole('button', { name: '+ Add' }));

    // Losing what somebody typed is never acceptable.
    await waitFor(() => expect(box).toHaveValue('Duplicate Co'));
    expect(await screen.findByText(/already a customer/)).toBeInTheDocument();
  });

  it('searches', () => {
    openList();
    fireEvent.change(screen.getByLabelText('Search customers'), { target: { value: 'alpine' } });
    expect(screen.getByText('Alpine Grocers')).toBeInTheDocument();
    expect(screen.queryByText('Harris Farm Markets')).not.toBeInTheDocument();
  });

  it('links each customer to its own page', () => {
    openList();
    expect(screen.getByText('Harris Farm Markets').closest('a')).toHaveAttribute(
      'href',
      '/customers/c-1',
    );
  });
});

describe('the customer page', () => {
  it('folds the contact details away, and says what is behind them', () => {
    /*
     * Asked for: *"hide the contact, phone and email within the details"*.
     * Three rows reading "—" was the top third of the page saying nothing and
     * pushing the money below the fold.
     *
     * The summary line is the other half of it. A collapsed panel with a
     * generic label is a panel nobody opens, because there is no way to tell
     * whether it holds anything.
     */
    openDetail('c-1');
    expect(screen.getByText(/0400 111 222/)).toBeInTheDocument();
    expect(screen.queryByText('dan@example.com')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Details/ }));
    expect(screen.getByText('Dan')).toBeInTheDocument();
    expect(screen.getByText('dan@example.com')).toBeInTheDocument();
  });

  it('says so plainly when there are no contact details at all', () => {
    openDetail('c-2');
    expect(screen.getByText('No contact details yet')).toBeInTheDocument();
  });

  it('shows what has been received, under the details', () => {
    // *"underneath the details, add in the history of this particular
    // customer to see past payments received"*.
    openDetail('c-1');
    expect(screen.getByRole('button', { name: /History/ })).toBeInTheDocument();
  });

  it('shows what this customer owes, and how much of it is late', () => {
    openDetail('c-1');
    expect(screen.getByText('Owes us')).toBeInTheDocument();
    // 120,000 + 80,000, and the older one is past due.
    expect(screen.getByText(formatCents(200_000))).toBeInTheDocument();
    expect(screen.getByText(/past due/)).toBeInTheDocument();
  });

  it('opens an invoice into its bill, where recording it received lives', () => {
    /*
     * *"intuitively we tend to tap any invoices ... I would want it to expand
     * into its bill and show the details."* And the row's own Received button
     * is gone: *"not sure why there is received in there. Remove that."* It
     * was a one-tap way to write off money on whichever row you happened to be
     * looking at, sitting exactly where a chevron belongs.
     */
    openDetail('c-1');
    expect(screen.getByText('#DD-1001')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Received' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /#DD-1001/ }));
    expect(screen.getByRole('button', { name: 'Mark received' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open/ })).toBeInTheDocument();
  });

  it('keeps every other invoice shut when one is opened', () => {
    // Two open bills at once is two tables of line items on a 375px phone,
    // and no way to tell which total belongs to which.
    openDetail('c-1');
    fireEvent.click(screen.getByRole('button', { name: /#DD-1001/ }));
    expect(screen.getAllByRole('button', { name: 'Mark received' })).toHaveLength(1);
  });

  it('saves an edit', async () => {
    openDetail('c-1');
    fireEvent.click(screen.getByRole('button', { name: 'Edit details' }));
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '0400 999 888' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save customer' }));

    await waitFor(() => expect(mocks.update).toHaveBeenCalled());
    expect(mocks.update.mock.calls[0]![0]).toMatchObject({
      id: 'c-1',
      contact_phone: '0400 999 888',
    });
  });

  it('turns a blank field into null rather than an empty string', async () => {
    openDetail('c-1');
    fireEvent.click(screen.getByRole('button', { name: 'Edit details' }));
    fireEvent.change(screen.getByLabelText('Contact name'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save customer' }));

    await waitFor(() => expect(mocks.update).toHaveBeenCalled());
    expect(mocks.update.mock.calls[0]![0].contact_name).toBeNull();
  });

  it('deactivates rather than deleting', async () => {
    openDetail('c-1');
    fireEvent.click(screen.getByRole('button', { name: 'Remove customer' }));
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove customer' }),
    );

    await waitFor(() => expect(mocks.update).toHaveBeenCalled());
    expect(mocks.update.mock.calls[0]![0].active).toBe(false);
  });

  it('asks before removing, and writes nothing if you go back', () => {
    openDetail('c-1');
    fireEvent.click(screen.getByRole('button', { name: 'Remove customer' }));
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Go back' }),
    );
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('explains rather than showing an empty screen for an unknown customer', () => {
    openDetail('nope');
    expect(screen.getByText('No such customer')).toBeInTheDocument();
  });

  it('renders nothing broken — notes §6', () => {
    for (const id of ['c-1', 'c-2', 'c-3']) {
      const { container, unmount } = openDetail(id);
      const text = container.textContent ?? '';
      for (const token of ['undefined', 'NaN', '[object Object]', 'Invalid Date']) {
        expect(text, `"${token}" leaked into customer ${id}`).not.toContain(token);
      }
      unmount();
    }
  });
});

describe('the client’s condition: customers never move owed or pending', () => {
  /*
   * This used to assert that no dollar sign appeared anywhere on a customer
   * screen, which was the right test while a customer carried no money at all.
   * They now carry receivables, so the proxy is gone and the actual invariant
   * has to be asserted directly: money in and money out never meet.
   */
  it('keeps the two ledgers in separate arrays, with no row in both', () => {
    const payableIds = new Set(invoices.map((row) => row.id));
    for (const sale of SALES) {
      expect(payableIds.has(sale.id)).toBe(false);
    }
    // And the shapes differ, so one cannot be passed where the other is meant:
    // a sales invoice has no supplier and a supplier invoice has no customer.
    for (const sale of SALES) expect('supplier_id' in sale).toBe(false);
    for (const invoice of invoices) expect('customer_id' in invoice).toBe(false);
  });

  it('leaves every payable figure untouched by what customers owe', () => {
    // The dashboard's number, computed the only way it is ever computed.
    const before = summarise(invoices);
    expect(before.total_cents).toBe(
      invoices.reduce((sum, row) => sum + row.amount_cents, 0),
    );

    // There is no call that could add a receivable to it: summarise takes the
    // payables array, and SALES is not in it and cannot be put in it.
    expect(summarise(invoices)).toEqual(before);
  });

  it('labels the customer money as owed TO us, never as owing', () => {
    // The word is what stops somebody reading $200,000 on this screen as two
    // hundred thousand dollars the group has to find.
    openDetail('c-1');
    expect(screen.getByText('Owes us')).toBeInTheDocument();
    expect(screen.queryByText('Owing')).not.toBeInTheDocument();
    expect(screen.queryByText('Overdue')).not.toBeInTheDocument();
  });

  it('leaves a customer record with no field a total could pick up', () => {
    for (const customer of CUSTOMERS) {
      for (const value of Object.values(customer)) {
        expect(typeof value).not.toBe('number');
      }
      expect(Object.keys(customer)).not.toContain('amount_cents');
      expect(Object.keys(customer)).not.toContain('balance_cents');
    }
  });

  it('leaves the owed total exactly what the invoices alone say', () => {
    // The number on the dashboard, computed from the unpaid array and nothing
    // else. Customers existing does not change it, because they are not in it.
    const owed = summarise(invoices);
    expect(formatCents(owed.total_cents)).toBe(
      formatCents(invoices.reduce((sum, row) => sum + row.amount_cents, 0)),
    );
    expect(owed.invoice_count).toBe(invoices.length);
  });

  it('shows the same unpaid counts in the menu whether or not customers exist', async () => {
    const { NavDrawer } = await import('@/components/app/NavDrawer');
    const { unmount } = render(<NavDrawer onClose={() => {}} />);

    for (const business of BUSINESSES) {
      const expected = invoices.filter((row) => row.business_id === business.id).length;
      if (expected === 0) continue;
      const row = screen.getByText(business.name).closest('a')!;
      expect(within(row).getByText(String(expected)), business.name).toBeInTheDocument();
    }
    unmount();
  });
});

describe('before the migration has been run', () => {
  it('says the table is missing rather than "no customers yet"', async () => {
    vi.resetModules();
    vi.doMock('@/lib/queries/customers', () => ({
      useAllCustomers: () => ({ data: undefined, isLoading: false, isError: true }),
      useCustomers: () => ({ data: [], isLoading: false }),
      useCreateCustomer: () => ({ mutateAsync: vi.fn(), isPending: false }),
      useUpdateCustomer: () => ({ mutateAsync: vi.fn(), isPending: false }),
    }));

    // resetModules gives a fresh module registry, so the Toast context the
    // screen reads is a different object from the one imported at the top of
    // this file. Both have to come from the same reset registry.
    const { ToastProvider: FreshToast } = await import('@/components/ui/Toast');
    const { CustomersList: Broken } = await import('@/components/screens/CustomersList');
    render(
      <FreshToast>
        <Broken />
      </FreshToast>,
    );

    // An empty list and a missing table look identical from the component's
    // side, and only one of them is "no customers yet".
    expect(screen.getByText(/CATCH_UP_004\.sql/)).toBeInTheDocument();
    expect(screen.queryByText(/No customers yet/)).not.toBeInTheDocument();
    vi.doUnmock('@/lib/queries/customers');
  });
});

/* -------------------------------------------------------------------------- *
 * A way to look at the customer page and the receivables list.
 *
 * ARCHITECTURE §21.6. Both screens were rebuilt on a photograph of the old
 * ones with things circled on it, and both are dense: two collapsible panels,
 * a figure, a list of rows that open. That is exactly the shape where a
 * passing assertion and a usable screen come apart — §38.8 and §39.6 were both
 * found this way and neither was visible to a test.
 *
 * Skipped unless PREVIEW_OUT is set.
 * -------------------------------------------------------------------------- */
describe('preview', () => {
  const OUT = process.env.PREVIEW_OUT ?? '';
  const CSS = process.env.PREVIEW_CSS ?? '';

  it.skipIf(!OUT)('snapshot', async () => {
    const customer = render(
      <ToastProvider>
        <CustomerDetail id="c-1" />
      </ToastProvider>,
    );
    const shut = customer.container.innerHTML;

    // Both panels open, and an invoice opened into its bill — the state that
    // has three expandable things stacked on a 375px screen.
    fireEvent.click(screen.getByRole('button', { name: /Details/ }));
    fireEvent.click(screen.getByRole('button', { name: /History/ }));
    fireEvent.click(screen.getByRole('button', { name: /#DD-1001/ }));
    const open = customer.container.innerHTML;
    customer.unmount();

    const list = render(
      <ToastProvider>
        <ReceivablesList />
      </ToastProvider>,
    );
    const receivables = list.container.innerHTML;
    list.unmount();

    const css = CSS ? readFileSync(CSS, 'utf8') : '';
    const page = (title: string, body: string) =>
      `<!doctype html><html lang="en-AU"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>${css}</style>
<style>body{background:var(--page);margin:0}</style>
</head><body>${body}</body></html>`;

    writeFileSync(OUT, page('Customer, shut', shut), 'utf8');
    writeFileSync(OUT.replace(/\.html$/, '-open.html'), page('Customer, open', open), 'utf8');
    writeFileSync(
      OUT.replace(/\.html$/, '-receivables.html'),
      page('Receivables', receivables),
      'utf8',
    );
  });
});
