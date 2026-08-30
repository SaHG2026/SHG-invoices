import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '@/components/ui/Toast';
import { BUSINESSES, PROFILES, SUPPLIERS, makeInvoices } from '../fixtures/invoices';
import { formatCents } from '@/lib/money';
import { DEFAULT_TERMS_DAYS } from '@/lib/constants';
import type { Supplier } from '@/lib/types';

/**
 * The suppliers screens. Spec §7.8.
 *
 * Two things here are load-bearing rather than cosmetic:
 *
 *   Deactivated suppliers stay visible, greyed. Hiding them would make one
 *   deactivated by mistake unreachable and unrecoverable — the same failure as
 *   deleting, arrived at politely (notes §8).
 *
 *   Payment terms finally have somewhere to live. Suppliers created from the
 *   add-invoice sheet have none, and until now nothing in the app could set
 *   them (ARCHITECTURE §18).
 */

const deactivated: Supplier = {
  id: 's-gone',
  name: 'Closed Down Foods',
  default_terms_days: 14,
  contact_name: null,
  contact_phone: null,
  notes: null,
  active: false,
};

const allSuppliers: Supplier[] = [...SUPPLIERS, deactivated];
const invoices = makeInvoices(30);

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  supplierInvoices: { current: [] as unknown[] },
}));

vi.mock('@/lib/queries/session', () => ({
  useCurrentProfile: () => ({ data: PROFILES[3], isLoading: false, isError: false }),
  useProfiles: () => ({ data: PROFILES }),
  useSignOut: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/lib/queries/reference', () => ({
  useBusinesses: () => ({ data: BUSINESSES }),
  useSuppliers: () => ({ data: SUPPLIERS }),
  useCreateSupplier: () => ({ mutateAsync: mocks.create, isPending: false }),
}));

vi.mock('@/lib/queries/history', () => ({
  useAllSuppliers: () => ({ data: allSuppliers, isLoading: false }),
  useSupplierInvoices: () => ({ data: mocks.supplierInvoices.current, isLoading: false }),
  useUpdateSupplier: () => ({ mutateAsync: mocks.update, isPending: false }),
  useHistory: () => ({ data: [], isLoading: false }),
}));

vi.mock('@/lib/queries/invoices', () => ({
  useUnpaidInvoices: () => ({ data: invoices, isLoading: false }),
  useCreateInvoice: () => ({ mutateAsync: vi.fn(), isPending: false }),
  findDuplicates: vi.fn(),
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

const { SuppliersList } = await import('@/components/screens/SuppliersList');
const { SupplierDetail } = await import('@/components/screens/SupplierDetail');

function openList() {
  return render(
    <ToastProvider>
      <SuppliersList />
    </ToastProvider>,
  );
}

function openDetail(id: string) {
  return render(
    <ToastProvider>
      <SupplierDetail id={id} />
    </ToastProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  mocks.create.mockResolvedValue({ ...SUPPLIERS[0], id: 's-new', name: 'New Wholesaler' });
  mocks.update.mockImplementation(async (changes) => ({ ...SUPPLIERS[0], ...changes }));
  mocks.supplierInvoices.current = invoices.filter(
    (invoice) => invoice.supplier_id === SUPPLIERS[0]!.id,
  );
});

describe('the supplier list', () => {
  it('shows deactivated suppliers rather than hiding them', () => {
    openList();
    // Hiding one deactivated by mistake makes it unrecoverable.
    expect(screen.getByText('Closed Down Foods')).toBeInTheDocument();
    expect(screen.getByText(/deactivated/)).toBeInTheDocument();
  });

  it('puts deactivated suppliers last — they are history, not choices', () => {
    const { container } = openList();
    const names = [...container.querySelectorAll('li a span.truncate')].map(
      (node) => node.textContent,
    );
    expect(names.at(-2)).toBe('Closed Down Foods');
  });

  it('calls out suppliers with no payment terms', () => {
    openList();
    const withoutTerms = SUPPLIERS.filter((s) => s.active && s.default_terms_days === null).length;
    expect(withoutTerms).toBeGreaterThan(0);
    expect(
      screen.getByText(new RegExp(`${withoutTerms} supplier.*no payment terms`)),
    ).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`${DEFAULT_TERMS_DAYS} days`))).toBeInTheDocument();
  });

  it('shows what each supplier is owed', () => {
    openList();
    const supplier = SUPPLIERS[0]!;
    const owed = invoices
      .filter((invoice) => invoice.supplier_id === supplier.id)
      .reduce((sum, invoice) => sum + invoice.amount_cents, 0);

    if (owed > 0) {
      const row = screen.getByText(supplier.name).closest('a')!;
      expect(within(row).getByText(formatCents(owed))).toBeInTheDocument();
    }
  });

  it('adds a supplier, and gives the name back if it fails', async () => {
    openList();
    const box = screen.getByLabelText('New supplier name');

    fireEvent.change(box, { target: { value: 'New Wholesaler' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalled());
    expect(box).toHaveValue('');

    mocks.create.mockRejectedValue(new Error('There is already a supplier called X.'));
    fireEvent.change(box, { target: { value: 'Duplicate Co' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    // Losing what somebody typed is never acceptable.
    await waitFor(() => expect(box).toHaveValue('Duplicate Co'));
    expect(await screen.findByText(/already a supplier/)).toBeInTheDocument();
  });

  it('finds a supplier by a fragment of the name', () => {
    openList();
    fireEvent.change(screen.getByLabelText('Search suppliers'), { target: { value: 'bid' } });
    expect(screen.getByText('Bidfood')).toBeInTheDocument();
    expect(screen.queryByText('Anchor Dairy')).not.toBeInTheDocument();
  });

  it('links each supplier to its own page', () => {
    openList();
    expect(screen.getByText('Bidfood').closest('a')).toHaveAttribute(
      'href',
      `/suppliers/${SUPPLIERS.find((s) => s.name === 'Bidfood')!.id}`,
    );
  });
});

describe('the supplier page', () => {
  const supplier = SUPPLIERS[0]!;

  it('shows what is outstanding and the oldest due date', () => {
    openDetail(supplier.id);
    expect(screen.getByText('Outstanding')).toBeInTheDocument();
    expect(screen.getByText(/oldest due/)).toBeInTheDocument();
  });

  it('shows six months of spend with a label per month', () => {
    openDetail(supplier.id);
    expect(screen.getByText('Last 6 months')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Spend over the last 6 months/ })).toBeInTheDocument();
  });

  it('says when terms are unset, and what is used instead', () => {
    const noTerms = SUPPLIERS.find((s) => s.default_terms_days === null)!;
    openDetail(noTerms.id);
    expect(
      screen.getByText(new RegExp(`Not set — using ${DEFAULT_TERMS_DAYS} days`)),
    ).toBeInTheDocument();
  });

  it('saves payment terms — the gap ARCHITECTURE §18 left open', async () => {
    openDetail(supplier.id);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    fireEvent.change(screen.getByLabelText('Payment terms (days)'), { target: { value: '21' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save supplier' }));

    await waitFor(() => expect(mocks.update).toHaveBeenCalled());
    expect(mocks.update.mock.calls[0]![0]).toMatchObject({
      id: supplier.id,
      default_terms_days: 21,
    });
  });

  /*
   * Renders the detail screen five times over. Against vitest's 5s default
   * that passes on a quiet machine and fails on a busy one, and a suite that
   * fails at random is one nobody trusts enough to act on. Same treatment as
   * the PBKDF2 tests in unlock-gate.
   */
  it('refuses nonsense terms rather than storing them', { timeout: 20_000 }, async () => {
    // Terms drive the due date on every future invoice for this supplier.
    for (const nonsense of ['abc', '-5', '0', '9999', '1.5']) {
      mocks.update.mockClear();
      const { unmount } = openDetail(supplier.id);
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      fireEvent.change(screen.getByLabelText('Payment terms (days)'), {
        target: { value: nonsense },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save supplier' }));

      await waitFor(() => expect(mocks.update).toHaveBeenCalled());
      expect(mocks.update.mock.calls[0]![0].default_terms_days).toBeNull();
      unmount();
    }
  });

  it('deactivates rather than deleting', async () => {
    openDetail(supplier.id);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByLabelText('Active'));
    fireEvent.click(screen.getByRole('button', { name: 'Save supplier' }));

    await waitFor(() => expect(mocks.update).toHaveBeenCalled());
    expect(mocks.update.mock.calls[0]![0].active).toBe(false);
  });

  it('says a deactivated supplier keeps its invoices', () => {
    openDetail('s-gone');
    expect(screen.getByText(/every invoice kept/)).toBeInTheDocument();
  });

  it('explains rather than showing an empty screen for an unknown supplier', () => {
    openDetail('nope');
    expect(screen.getByText('No such supplier')).toBeInTheDocument();
  });

  it('renders nothing broken — notes §6', () => {
    const { container } = openDetail(supplier.id);
    const text = container.textContent ?? '';
    for (const token of ['undefined', 'NaN', '[object Object]', 'Invalid Date']) {
      expect(text).not.toContain(token);
    }
  });
});
