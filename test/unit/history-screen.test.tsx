import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { ToastProvider } from '@/components/ui/Toast';
import { BUSINESSES, PROFILES, SUPPLIERS, makeInvoices } from '../fixtures/invoices';

/**
 * History. Spec §7.7.
 *
 * "Filter by payer — 'everything Sujan ticked off in July' should take two
 * taps." So the payer filter has to be visible on arrival, not behind a menu.
 * These assert the tap count, not just that filtering is possible.
 */

const paid = makeInvoices(12).map((invoice, i) => ({
  ...invoice,
  status: 'paid' as const,
  paid_by: PROFILES[i % PROFILES.length]!.id,
  paid_at: '2026-08-20T00:00:00.000Z',
}));

const mocks = vi.hoisted(() => ({ history: vi.fn() }));

vi.mock('@/lib/queries/session', () => ({
  useCurrentProfile: () => ({ data: PROFILES[3], isLoading: false, isError: false }),
  useProfiles: () => ({ data: PROFILES }),
  useTeam: () => ({ data: PROFILES.filter((person) => person.role !== 'builder') }),
  useSignOut: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/lib/queries/reference', () => ({
  useBusinesses: () => ({ data: BUSINESSES }),
  useSuppliers: () => ({ data: SUPPLIERS }),
  useCreateSupplier: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/lib/queries/history', () => ({
  useHistory: (filters: unknown) => {
    mocks.history(filters);
    return { data: paid, isLoading: false };
  },
  useAllSuppliers: () => ({ data: SUPPLIERS, isLoading: false }),
  useSupplierInvoices: () => ({ data: [], isLoading: false }),
  useUpdateSupplier: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/lib/queries/invoices', () => ({
  useUnpaidInvoices: () => ({ data: [], isLoading: false }),
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

const { HistoryList } = await import('@/components/screens/HistoryList');

function open(scope = 'all') {
  return render(
    <ToastProvider>
      <HistoryList scope={scope} />
    </ToastProvider>,
  );
}

const lastFilters = () => mocks.history.mock.calls.at(-1)![0] as Record<string, unknown>;

/**
 * The payer chips, told apart from the header's own "signed in as" button —
 * which carries the same person's name.
 */
const payerChips = () => within(screen.getByRole('group', { name: 'Filter by who paid' }));

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

describe('filtering by who paid — the two taps of spec §7.7', () => {
  it('offers everybody who pays things on arrival, no menu to open first', () => {
    open();
    // Tap one is reaching this screen. Tap two must be the person.
    for (const person of PROFILES.filter((p) => p.role !== 'builder')) {
      expect(
        payerChips().getByRole('button', { name: new RegExp(person.display_name) }),
      ).toBeInTheDocument();
    }
  });

  it('does not offer the builder as somebody who paid', () => {
    /*
     * ARCHITECTURE §28.2. Rabindra maintains the app and does not run the
     * businesses, so he is not one of the choices here. His access is
     * untouched — this is `role`, which no RLS policy reads, and deliberately
     * not `active`, which is the membership test itself.
     *
     * The lookup that names whoever paid an invoice still returns him, so a
     * row he ever touched is still attributed correctly rather than showing an
     * unnamed chip.
     */
    open();
    expect(payerChips().queryByRole('button', { name: /Rabindra/ })).not.toBeInTheDocument();
  });

  it('filters to that person in a single tap', () => {
    open();
    const sujan = PROFILES.find((person) => person.display_name === 'Sujan')!;

    fireEvent.click(payerChips().getByRole('button', { name: /Sujan/ }));
    expect(lastFilters().paidBy).toBe(sujan.id);
  });

  it('tapping the same person again clears it', () => {
    open();
    fireEvent.click(payerChips().getByRole('button', { name: /Sujan/ }));
    fireEvent.click(payerChips().getByRole('button', { name: /Sujan/ }));
    expect(lastFilters().paidBy).toBeNull();
  });

  it('starts on Anyone', () => {
    open();
    expect(screen.getByRole('button', { name: 'Anyone' })).toHaveAttribute('aria-pressed', 'true');
    expect(lastFilters().paidBy).toBeNull();
  });
});

describe('the rest of the filters', () => {
  it('passes the search straight through to the query', () => {
    open();
    fireEvent.change(screen.getByLabelText('Search history'), { target: { value: 'bidfood' } });
    expect(lastFilters().search).toBe('bidfood');
  });

  it('scopes to one business', () => {
    open('gmh');
    expect(lastFilters().businessId).toBe(BUSINESSES.find((b) => b.code === 'GMH')!.id);
  });

  it('hides voided invoices until asked — they are corrections, not history', () => {
    open();
    expect(lastFilters().includeVoid).toBe(false);

    fireEvent.click(screen.getByLabelText('Include voided'));
    expect(lastFilters().includeVoid).toBe(true);
  });
});

describe('the total is honest about what it covers', () => {
  it('is labelled as what is shown, not as everything ever paid', () => {
    open();
    // History is the one list the database paginates, so a figure at the
    // bottom cannot claim to be a complete sum. Notes §3.
    expect(screen.getByText(/\d+ shown/)).toBeInTheDocument();
  });
});

describe('nothing broken — notes §6', () => {
  it('renders paid invoices with no undefined or NaN', () => {
    const { container } = open();
    const text = container.textContent ?? '';
    for (const token of ['undefined', 'NaN', '[object Object]', 'Invalid Date']) {
      expect(text).not.toContain(token);
    }
  });
});
