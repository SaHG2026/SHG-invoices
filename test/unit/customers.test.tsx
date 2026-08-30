import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '@/components/ui/Toast';
import { BUSINESSES, PROFILES, SUPPLIERS, makeInvoices } from '../fixtures/invoices';
import { filterCustomers, orderCustomers } from '@/lib/derive/customer-match';
import { formatCents } from '@/lib/money';
import { summarise } from '@/lib/derive/select';
import type { Customer } from '@/lib/types';

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

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
}));

vi.mock('@/lib/queries/session', () => ({
  useCurrentProfile: () => ({ data: PROFILES[0], isLoading: false, isError: false }),
  useProfiles: () => ({ data: PROFILES }),
  useSignOut: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateNotifyPreference: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/lib/queries/customers', () => ({
  useAllCustomers: () => ({ data: CUSTOMERS, isLoading: false }),
  useCustomers: () => ({ data: CUSTOMERS.filter((c) => c.active), isLoading: false }),
  useCreateCustomer: () => ({ mutateAsync: mocks.create, isPending: false }),
  useUpdateCustomer: () => ({ mutateAsync: mocks.update, isPending: false }),
}));

vi.mock('@/lib/queries/reference', () => ({
  useBusinesses: () => ({ data: BUSINESSES }),
  useSuppliers: () => ({ data: SUPPLIERS }),
  useCreateSupplier: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/lib/queries/invoices', () => ({
  useUnpaidInvoices: () => ({ data: invoices, isLoading: false }),
  useCreateInvoice: () => ({ mutateAsync: vi.fn(), isPending: false }),
  findDuplicates: vi.fn(),
}));

vi.mock('@/lib/queries/detail', () => ({
  useRecentActivity: () => ({ data: [] }),
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

  it('says what this ledger is, and what it is not', () => {
    openList();
    expect(screen.getByText(/Nothing here counts toward what the group owes/)).toBeInTheDocument();
  });

  it('adds a customer, and gives the name back if it fails', async () => {
    openList();
    const box = screen.getByLabelText('New customer name');

    fireEvent.change(box, { target: { value: 'New Grocer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalled());
    expect(box).toHaveValue('');

    mocks.create.mockRejectedValue(new Error('There is already a customer called X.'));
    fireEvent.change(box, { target: { value: 'Duplicate Co' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

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

  it('says sales are not built yet rather than showing an empty panel', () => {
    openDetail('c-1');
    expect(screen.getByText(/aren’t built yet/)).toBeInTheDocument();
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
  it('puts no money on the customer screens at all', () => {
    // A dollar sign anywhere here is the first symptom of the two ledgers
    // being joined up. There is nothing to show yet, so there is nothing to
    // show — not a zero, which would read as "they owe nothing" rather than
    // as "we do not track that here".
    for (const open of [() => openList(), () => openDetail('c-1')]) {
      const { container, unmount } = open();
      expect(container.textContent ?? '').not.toMatch(/\$\s?\d/);
      unmount();
    }
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
