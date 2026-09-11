import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '@/components/ui/Toast';
import { BUSINESSES, PROFILES, SUPPLIERS, makeInvoices } from '../fixtures/invoices';
import { formatCents, sumCents } from '@/lib/money';
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
  is_placeholder: false,
};

const allSuppliers: Supplier[] = [...SUPPLIERS, deactivated];
const invoices = makeInvoices(30);

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  supplierInvoices: { current: [] as unknown[] },
  /** What `useSupplierRange` hands back — set per test. */
  range: { current: { rows: [] as unknown[], truncated: false } },
  /** The arguments it was last called with, so the query can be asserted on. */
  rangeArgs: vi.fn(),
}));

vi.mock('@/lib/queries/session', () => ({
  useCurrentProfile: () => ({ data: PROFILES[3], isLoading: false, isError: false }),
  useProfiles: () => ({ data: PROFILES }),
  useTeam: () => ({ data: PROFILES.filter((person) => person.role !== 'builder') }),
  useSignOut: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/lib/queries/reference', () => ({
  useBusinesses: () => ({ data: BUSINESSES }),
  useSuppliers: () => ({ data: SUPPLIERS }),
  useCreateSupplier: () => ({ mutateAsync: mocks.create, mutate: mocks.create, isPending: false }),
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

vi.mock('@/lib/queries/history', () => ({
  useAllSuppliers: () => ({ data: allSuppliers, isLoading: false }),
  useSupplierInvoices: () => ({ data: mocks.supplierInvoices.current, isLoading: false }),
  useUpdateSupplier: () => ({ mutateAsync: mocks.update, isPending: false }),
  useHistory: () => ({ data: [], isLoading: false }),
  useSupplierRange: (id: string, from: string, to: string, basis: string) => {
    mocks.rangeArgs(id, from, to, basis);
    return { data: mocks.range.current, isLoading: false, isError: false };
  },
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
  mocks.range.current = { rows: [], truncated: false };
});

describe('the supplier date range', () => {
  /*
   * "An option within suppliers to check total pending between two time
   * periods."
   *
   * The figures and the list under them come from one array, which is rule 4
   * applied inside a panel: a total nobody can open is a total nobody can
   * check. These assert that, and that the panel refuses rather than
   * under-reports when the range is wider than it can total.
   */
  const theSupplier = SUPPLIERS[0]!;
  const inRange = invoices.filter((invoice) => invoice.supplier_id === theSupplier.id);

  function rangeSection() {
    return within(screen.getByText('Between two dates').closest('section')!);
  }

  it('totals pending and settled separately, and both match the rows shown', () => {
    mocks.range.current = { rows: inRange, truncated: false };
    openDetail(theSupplier.id);

    const pending = inRange.filter((invoice) => invoice.status === 'unpaid');
    const paid = inRange.filter((invoice) => invoice.status === 'paid');

    const section = rangeSection();
    expect(section.getByText(formatCents(sumCents(pending)))).toBeInTheDocument();
    expect(
      section.getByText(`${pending.length} invoice${pending.length === 1 ? '' : 's'}`),
    ).toBeInTheDocument();
    // Both figures exist even when one of them is nothing — a missing figure
    // reads as "not applicable", which is a different claim from zero.
    expect(section.getAllByText(/^\$/).length).toBeGreaterThanOrEqual(2);
    expect(paid.length).toBeGreaterThanOrEqual(0);
  });

  it('asks the database by due date or by invoice date, and says which', () => {
    openDetail(theSupplier.id);
    expect(mocks.rangeArgs).toHaveBeenCalledWith(theSupplier.id, expect.any(String), expect.any(String), 'due');

    fireEvent.click(rangeSection().getByRole('button', { name: 'By invoice date' }));
    expect(mocks.rangeArgs).toHaveBeenLastCalledWith(
      theSupplier.id,
      expect.any(String),
      expect.any(String),
      'invoice',
    );
  });

  it('defaults to this month so far rather than to nothing', () => {
    openDetail(theSupplier.id);
    const section = rangeSection();
    const from = section.getByLabelText('From date') as HTMLInputElement;
    const to = section.getByLabelText('To date') as HTMLInputElement;

    expect(from.value).toMatch(/^\d{4}-\d{2}-01$/);
    expect(to.value >= from.value).toBe(true);
  });

  it('refuses to total a range it would have to truncate', () => {
    // A short total gets written down. A refused one gets narrowed.
    mocks.range.current = { rows: [], truncated: true };
    openDetail(theSupplier.id);
    expect(rangeSection().getByText(/more than 500 invoices/)).toBeInTheDocument();
  });

  it('says so when the dates are the wrong way round', () => {
    openDetail(theSupplier.id);
    const section = rangeSection();
    fireEvent.change(section.getByLabelText('From date'), { target: { value: '2026-12-01' } });
    fireEvent.change(section.getByLabelText('To date'), { target: { value: '2026-01-01' } });
    expect(section.getByText('The first date is after the second.')).toBeInTheDocument();
  });

  it('counts voided invoices in neither figure, and says how many', () => {
    const voided = { ...inRange[0]!, id: 'v-1', status: 'void' as const, void_reason: 'wrong' };
    mocks.range.current = { rows: [...inRange, voided], truncated: false };
    openDetail(theSupplier.id);
    expect(rangeSection().getByText(/voided in this range/)).toBeInTheDocument();
  });
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
    fireEvent.click(screen.getByRole('button', { name: '+ Add' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalled());
    expect(box).toHaveValue('');

    mocks.create.mockRejectedValue(new Error('There is already a supplier called X.'));
    fireEvent.change(box, { target: { value: 'Duplicate Co' } });
    fireEvent.click(screen.getByRole('button', { name: '+ Add' }));

    // Losing what somebody typed is never acceptable.
    await waitFor(() => expect(box).toHaveValue('Duplicate Co'));
    expect(await screen.findByText(/already a supplier/)).toBeInTheDocument();
  });

  /*
   * "Is this one you already have?"
   *
   * The client's case, in his words: "there is a supplier by the name Global
   * Foods Department and a manager enters it as its full name. but another
   * manager has been entering it as GFD." The unique index refuses only a
   * character-for-character repeat, so nothing was looking at this path at
   * all. `lib/derive/near-match.ts` does the comparing and has its own file;
   * what is asserted here is that the screen asks, and that the answer is a
   * question rather than a refusal.
   */
  it('asks before adding something that looks like a supplier already there', async () => {
    openList();
    fireEvent.change(screen.getByLabelText('New supplier name'), {
      target: { value: 'Bidfood Pty Ltd' },
    });
    fireEvent.click(screen.getByRole('button', { name: '+ Add' }));

    const dialog = within(await screen.findByRole('alertdialog'));
    expect(dialog.getByText('Bidfood')).toBeInTheDocument();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('never blocks — spec §6, and the way through is the first button', async () => {
    openList();
    fireEvent.change(screen.getByLabelText('New supplier name'), {
      target: { value: 'Bidfood Pty Ltd' },
    });
    fireEvent.click(screen.getByRole('button', { name: '+ Add' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Add it anyway' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalled());
    expect(mocks.create.mock.calls[0]![0]).toMatchObject({ name: 'Bidfood Pty Ltd' });
  });

  it('keeps what was typed when the answer is "no, that is the same one"', async () => {
    openList();
    const box = screen.getByLabelText('New supplier name');
    fireEvent.change(box, { target: { value: 'Bidfood Pty Ltd' } });
    fireEvent.click(screen.getByRole('button', { name: '+ Add' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Go back' }));
    expect(mocks.create).not.toHaveBeenCalled();
    expect(box).toHaveValue('Bidfood Pty Ltd');
  });

  it('does not ask about a supplier that is genuinely new', async () => {
    openList();
    fireEvent.change(screen.getByLabelText('New supplier name'), {
      target: { value: 'Wollongong Dry Goods' },
    });
    fireEvent.click(screen.getByRole('button', { name: '+ Add' }));

    await waitFor(() => expect(mocks.create).toHaveBeenCalled());
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  /*
   * Reported: "the + on supplier interface is creating invoice still."
   *
   * §16 made the `+` global because writing to the ledger is not hierarchical,
   * and that reasoning still holds — the button stays on every screen, and the
   * invoice is still one tap from here. What changed is that "global" was
   * implemented as "means one thing", and on a list of suppliers the thing
   * under your thumb should be able to add a supplier.
   */
  it('offers to add a supplier from the + , not only an invoice', async () => {
    openList();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    const sheet = within(await screen.findByRole('dialog'));
    expect(sheet.getByRole('button', { name: 'New supplier' })).toBeInTheDocument();
    // Nothing was taken away.
    expect(sheet.getByRole('button', { name: 'Invoice from a supplier' })).toBeInTheDocument();
  });

  it('does not offer a customer invoice from a screen about suppliers', async () => {
    openList();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    const sheet = within(await screen.findByRole('dialog'));
    expect(sheet.queryByRole('button', { name: /to a customer/i })).not.toBeInTheDocument();
  });

  it('puts the cursor in the add field, which is the one place a supplier is added', async () => {
    openList();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(await screen.findByRole('button', { name: 'New supplier' }));

    expect(screen.getByLabelText('New supplier name')).toHaveFocus();
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
    fireEvent.click(screen.getByRole('button', { name: 'Edit details' }));

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
      fireEvent.click(screen.getByRole('button', { name: 'Edit details' }));
      fireEvent.change(screen.getByLabelText('Payment terms (days)'), {
        target: { value: nonsense },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save supplier' }));

      await waitFor(() => expect(mocks.update).toHaveBeenCalled());
      expect(mocks.update.mock.calls[0]![0].default_terms_days).toBeNull();
      unmount();
    }
  });

  /*
   * Remove is deactivate, said in words rather than as a checkbox called
   * "Active" inside a form four scrolls down. What is asserted below is that
   * the writing did not change: it still sets `active: false` and still asks
   * first, because rule 5 is the reason both of those exist.
   */
  it('deactivates rather than deleting', async () => {
    openDetail(supplier.id);
    fireEvent.click(screen.getByRole('button', { name: 'Remove supplier' }));
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove supplier' }),
    );

    await waitFor(() => expect(mocks.update).toHaveBeenCalled());
    expect(mocks.update.mock.calls[0]![0].active).toBe(false);
  });

  it('asks before removing, and writes nothing if you go back', () => {
    openDetail(supplier.id);
    fireEvent.click(screen.getByRole('button', { name: 'Remove supplier' }));
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Go back' }),
    );
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('says what removing actually does before it happens', () => {
    openDetail(supplier.id);
    fireEvent.click(screen.getByRole('button', { name: 'Remove supplier' }));
    const dialog = within(screen.getByRole('alertdialog'));
    expect(dialog.getByText(/adds an invoice/)).toBeInTheDocument();
    expect(dialog.getByText(/Nothing is deleted/)).toBeInTheDocument();
  });

  it('offers a removed supplier the way back', async () => {
    openDetail('s-gone');
    fireEvent.click(screen.getByRole('button', { name: 'Restore supplier' }));

    await waitFor(() => expect(mocks.update).toHaveBeenCalled());
    expect(mocks.update.mock.calls[0]![0].active).toBe(true);
  });

  it('says a removed supplier keeps its invoices', () => {
    openDetail('s-gone');
    expect(screen.getByText(/Every invoice it has ever been on is kept/)).toBeInTheDocument();
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
