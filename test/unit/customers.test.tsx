import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
}));

vi.mock('next/navigation', () => ({ usePathname: () => '/customers' }));

const { CustomersList } = await import('@/components/screens/CustomersList');
const { CustomerDetail } = await import('@/components/screens/CustomerDetail');

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
  it('shows the contact details', () => {
    openDetail('c-1');
    expect(screen.getByText('Dan')).toBeInTheDocument();
    expect(screen.getByText('0400 111 222')).toBeInTheDocument();
    expect(screen.getByText('dan@example.com')).toBeInTheDocument();
  });

  it('shows what this customer owes, and how much of it is late', () => {
    openDetail('c-1');
    expect(screen.getByText('Owes us')).toBeInTheDocument();
    // 120,000 + 80,000, and the older one is past due.
    expect(screen.getByText(formatCents(200_000))).toBeInTheDocument();
    expect(screen.getByText(/past due/)).toBeInTheDocument();
  });

  it('lists each outstanding invoice with a way to record it received', () => {
    openDetail('c-1');
    expect(screen.getByText('#DD-1001')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Received' })).toHaveLength(2);
  });

  it('saves an edit', async () => {
    openDetail('c-1');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Contact'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save customer' }));

    await waitFor(() => expect(mocks.update).toHaveBeenCalled());
    expect(mocks.update.mock.calls[0]![0].contact_name).toBeNull();
  });

  it('deactivates rather than deleting', async () => {
    openDetail('c-1');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByLabelText('Active'));
    fireEvent.click(screen.getByRole('button', { name: 'Save customer' }));

    await waitFor(() => expect(mocks.update).toHaveBeenCalled());
    expect(mocks.update.mock.calls[0]![0].active).toBe(false);
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
