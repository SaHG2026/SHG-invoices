import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '@/components/ui/Toast';
import {
  BUSINESSES,
  FIXTURE_TODAY,
  PROFILES,
  SUPPLIERS,
  makeAwaitingReview,
  makeInvoices,
} from '../fixtures/invoices';
import {
  awaitingReview,
  onlyOwed,
  summarise,
  summariseUrgency,
  summariseByBusiness,
} from '@/lib/derive/select';
import { formatCents, sumCents } from '@/lib/money';
import type { Supplier } from '@/lib/types';

/**
 * Invoices a shop entered, waiting for one of the four.
 *
 * The client's instruction: "whenever gmh or gmp adds an invoice, then it has
 * to be approved by one of the managements before it shows in the pending or
 * overdue".
 *
 * ---------------------------------------------------------------------------
 * What these tests are actually guarding
 *
 * The feature's failure mode is not a broken screen. It is an invoice a shop
 * entered, nobody reviewed, and which therefore appears in no total anywhere —
 * money the group owes that the app has quietly stopped mentioning. Every
 * exclusion below is deliberate and every one of them is a place that
 * invisibility could become permanent.
 *
 * So the first block asserts the exclusion holds, and the rest assert the
 * screen that makes it visible cannot be got past by accident.
 * ---------------------------------------------------------------------------
 */

const approved = makeInvoices(30);
const waiting = makeAwaitingReview(4);

/** The placeholder a shop picks when the supplier is not on the list. */
const placeholder: Supplier = {
  id: 's-unlisted',
  name: 'Supplier not listed',
  default_terms_days: null,
  contact_name: null,
  contact_phone: null,
  notes: null,
  active: true,
  is_placeholder: true,
};

const mocks = vi.hoisted(() => ({
  approve: vi.fn(),
  reassign: vi.fn(),
  voidInvoice: vi.fn(),
  createSupplier: vi.fn(),
  rows: { current: [] as unknown[] },
  notes: { current: {} as Record<string, string[]> },
}));

vi.mock('@/lib/queries/session', () => ({
  useCurrentProfile: () => ({ data: PROFILES[0], isLoading: false, isError: false }),
  useProfiles: () => ({ data: PROFILES }),
  useTeam: () => ({ data: PROFILES }),
  useSignOut: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/lib/queries/reference', () => ({
  useBusinesses: () => ({ data: BUSINESSES }),
  useSuppliers: () => ({ data: [...SUPPLIERS, placeholder] }),
  useCreateSupplier: () => ({
    mutateAsync: mocks.createSupplier,
    mutate: mocks.createSupplier,
    isPending: false,
  }),
  optimisticSupplier: (id: string, name: string) => ({
    id,
    name: name.trim(),
    default_terms_days: null,
    contact_name: null,
    contact_phone: null,
    notes: null,
    active: true,
    is_placeholder: false,
  }),
}));

vi.mock('@/lib/queries/invoices', () => ({
  useUnpaidInvoices: () => ({ data: approved, isLoading: false }),
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
  useMarkPaid: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUnmarkPaid: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useVoidInvoice: () => ({ mutateAsync: mocks.voidInvoice, isPending: false }),
}));

vi.mock('@/lib/queries/review', () => ({
  useAwaitingReview: () => ({ data: mocks.rows.current, isLoading: false }),
  useReviewNotes: () => ({ data: mocks.notes.current }),
  useApproveInvoices: () => ({ mutateAsync: mocks.approve, isPending: false }),
  useReassignSupplier: () => ({ mutateAsync: mocks.reassign, isPending: false }),
}));

vi.mock('next/navigation', () => ({ usePathname: () => '/review' }));

const { ReviewList } = await import('@/components/screens/ReviewList');

function open() {
  return render(
    <ToastProvider>
      <ReviewList />
    </ToastProvider>,
  );
}

/** One waiting invoice, on the placeholder supplier. */
function unlisted(overrides: Record<string, unknown> = {}) {
  return {
    ...waiting[0]!,
    id: 'r-unlisted',
    supplier_id: placeholder.id,
    supplier: { id: placeholder.id, name: placeholder.name, is_placeholder: true },
    ...overrides,
  };
}

/** One waiting invoice, on a real supplier. */
function listed(overrides: Record<string, unknown> = {}) {
  return {
    ...waiting[1]!,
    id: 'r-listed',
    supplier_id: SUPPLIERS[0]!.id,
    supplier: { id: SUPPLIERS[0]!.id, name: SUPPLIERS[0]!.name, is_placeholder: false },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.rows.current = [];
  mocks.notes.current = {};
  mocks.approve.mockResolvedValue({ approved: [], missed: [] });
  mocks.reassign.mockResolvedValue(undefined);
  mocks.voidInvoice.mockResolvedValue(null);
});

describe('nothing awaiting review reaches a total', () => {
  /**
   * The whole point, asserted over the derive layer rather than over a screen.
   *
   * `onlyOwed` is the single place the rule lives, and every headline figure
   * in the app goes through it. If somebody later "simplifies" it back to a
   * status check, these fail — which is the only reason they are worth having.
   */
  const mixed = [...approved, ...waiting];

  it('has both kinds in the fixture, or this proves nothing', () => {
    expect(onlyOwed(mixed).length).toBeGreaterThan(0);
    expect(awaitingReview(mixed).length).toBe(waiting.length);
  });

  it('splits the array in two with nothing in both and nothing in neither', () => {
    const owed = new Set(onlyOwed(mixed).map((row) => row.id));
    const review = new Set(awaitingReview(mixed).map((row) => row.id));

    for (const id of review) expect(owed.has(id)).toBe(false);
    // Every unpaid invoice is in exactly one of them.
    expect(owed.size + review.size).toBe(mixed.filter((r) => r.status === 'unpaid').length);
  });

  it('keeps the group total to what has been approved', () => {
    expect(summarise(mixed).total_cents).toBe(sumCents(onlyOwed(mixed)));
    expect(summarise(mixed).total_cents).toBe(summarise(approved).total_cents);
  });

  it('keeps both dashboard cards to what has been approved', () => {
    const withWaiting = summariseUrgency(mixed, FIXTURE_TODAY);
    const without = summariseUrgency(approved, FIXTURE_TODAY);

    expect(withWaiting.overdue.total_cents).toBe(without.overdue.total_cents);
    expect(withWaiting.next7.total_cents).toBe(without.next7.total_cents);
  });

  it('keeps every per-business total to what has been approved', () => {
    const withWaiting = summariseByBusiness(mixed, BUSINESSES, FIXTURE_TODAY);
    const without = summariseByBusiness(approved, BUSINESSES, FIXTURE_TODAY);

    for (const entry of withWaiting) {
      const same = without.find((other) => other.business.id === entry.business.id)!;
      expect(entry.total_cents).toBe(same.total_cents);
      expect(entry.invoice_count).toBe(same.invoice_count);
      expect(entry.overdue_count).toBe(same.overdue_count);
    }
  });
});

describe('the review screen', () => {
  it('says so plainly when there is nothing waiting, rather than vanishing', () => {
    // The card that disappears when empty is the card nobody notices is
    // missing when it should be there — and what it would hide is an invoice.
    open();
    expect(screen.getByText('Nothing to review.')).toBeInTheDocument();
    expect(screen.getByText(formatCents(0))).toBeInTheDocument();
  });

  it('totals what is waiting, and it is a figure no other screen shows', () => {
    mocks.rows.current = [listed(), unlisted()];
    open();
    const total = sumCents([listed(), unlisted()] as never);
    expect(screen.getByText(formatCents(total))).toBeInTheDocument();
  });

  it('groups by venue, because that is how the work arrives', () => {
    mocks.rows.current = [
      listed({ business_id: BUSINESSES[0]!.id, business: BUSINESSES[0] }),
      unlisted({ business_id: BUSINESSES[1]!.id, business: BUSINESSES[1] }),
    ];
    open();
    expect(screen.getByRole('heading', { name: BUSINESSES[0]!.name })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: BUSINESSES[1]!.name })).toBeInTheDocument();
  });

  it('approves one invoice by its id, not by its position', async () => {
    const row = listed({ business_id: BUSINESSES[0]!.id, business: BUSINESSES[0] });
    mocks.rows.current = [row];
    open();

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(mocks.approve).toHaveBeenCalledWith([row.id]));
  });

  it('says so when somebody else got there first', async () => {
    const row = listed({ business_id: BUSINESSES[0]!.id, business: BUSINESSES[0] });
    mocks.rows.current = [row];
    mocks.approve.mockResolvedValue({ approved: [], missed: [row.id] });
    open();

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await screen.findByText(/already done by somebody else/);
  });
});

describe('an invoice on “Supplier not listed”', () => {
  /*
   * The other half of taking supplier creation away from the shops. Approving
   * one of these as it stands would file real money against a placeholder,
   * permanently, and nobody would ever go looking for it there.
   */
  it('cannot be approved as it stands', () => {
    mocks.rows.current = [unlisted({ business_id: BUSINESSES[0]!.id, business: BUSINESSES[0] })];
    open();

    const approveButton = screen.getByRole('button', { name: 'Needs a supplier' });
    expect(approveButton).toBeDisabled();
    expect(mocks.approve).not.toHaveBeenCalled();
  });

  it('is left out of Approve all, and the count says how many are left', () => {
    mocks.rows.current = [
      listed({ business_id: BUSINESSES[0]!.id, business: BUSINESSES[0] }),
      unlisted({ business_id: BUSINESSES[0]!.id, business: BUSINESSES[0] }),
    ];
    open();
    // Two waiting, one approvable.
    expect(screen.getByRole('button', { name: 'Approve 1' })).toBeInTheDocument();
  });

  it('shows the shop’s note in full, unprompted', () => {
    const row = unlisted({ business_id: BUSINESSES[0]!.id, business: BUSINESSES[0] });
    mocks.rows.current = [row];
    mocks.notes.current = { [row.id]: ['From Riverina Meats — new supplier, first delivery'] };
    open();

    // Not behind a tap: it is the only channel the shop has.
    expect(
      screen.getByText('From Riverina Meats — new supplier, first delivery'),
    ).toBeInTheDocument();
  });

  it('says plainly when there is no note to go on', () => {
    mocks.rows.current = [unlisted({ business_id: BUSINESSES[0]!.id, business: BUSINESSES[0] })];
    open();
    expect(screen.getByText(/no note saying who it is from/)).toBeInTheDocument();
  });

  it('moves onto a real supplier from the card', async () => {
    const row = unlisted({ business_id: BUSINESSES[0]!.id, business: BUSINESSES[0] });
    mocks.rows.current = [row];
    open();

    fireEvent.click(screen.getByRole('button', { name: 'Choose the real supplier' }));

    const field = screen.getByLabelText('Supplier');
    fireEvent.change(field, { target: { value: SUPPLIERS[0]!.name.slice(0, 4) } });
    fireEvent.mouseDown(await screen.findByText(SUPPLIERS[0]!.name));

    await waitFor(() =>
      expect(mocks.reassign).toHaveBeenCalledWith({
        id: row.id,
        supplierId: SUPPLIERS[0]!.id,
        supplierName: SUPPLIERS[0]!.name,
      }),
    );
  });

  /*
   * Making the supplier the note names, from the card.
   *
   * =========================================================================
   * This is the case the whole placeholder design exists for, and it did not
   * work. `allowCreate={false}` sat directly under a comment saying "creating
   * from here is on purpose and is the point of the note".
   *
   * Reported from a real review: Parramatta filed $300 on the placeholder with
   * the note "Sokko Pastry"; the manager typed "Sokko" and got *No supplier
   * matches that.* Approve stays disabled on a placeholder, so the invoice
   * could be neither accepted nor corrected without leaving the screen — and
   * `lib/queries/review.ts` says exactly why that is fatal: "a correction that
   * requires going somewhere else is a correction that does not get made."
   * =========================================================================
   */
  it('creates the supplier the note names, and moves the invoice onto it', async () => {
    const row = unlisted({ business_id: BUSINESSES[0]!.id, business: BUSINESSES[0] });
    mocks.rows.current = [row];
    mocks.notes.current = { [row.id]: ['Sokko Pastry'] };
    open();

    fireEvent.click(screen.getByRole('button', { name: 'Choose the real supplier' }));
    fireEvent.change(screen.getByLabelText('Supplier'), { target: { value: 'Sokko Pastry' } });

    fireEvent.mouseDown(
      await screen.findByRole('button', { name: /Add “Sokko Pastry” as a new supplier/ }),
    );

    await waitFor(() => expect(mocks.createSupplier).toHaveBeenCalled());
    expect(mocks.createSupplier.mock.calls[0]![0]).toMatchObject({ name: 'Sokko Pastry' });
  });

  it('points the invoice at the supplier it just made, not at nothing', async () => {
    const row = unlisted({ business_id: BUSINESSES[0]!.id, business: BUSINESSES[0] });
    mocks.rows.current = [row];
    open();

    fireEvent.click(screen.getByRole('button', { name: 'Choose the real supplier' }));
    fireEvent.change(screen.getByLabelText('Supplier'), { target: { value: 'Sokko Pastry' } });
    fireEvent.mouseDown(
      await screen.findByRole('button', { name: /Add “Sokko Pastry” as a new supplier/ }),
    );

    await waitFor(() => expect(mocks.reassign).toHaveBeenCalled());

    // The id it reassigns to must be the id it created — the foreign key has
    // nothing else to point at, and an invented one fails at the database.
    const created = mocks.createSupplier.mock.calls[0]![0] as { id: string };
    expect(mocks.reassign.mock.calls[0]![0]).toMatchObject({
      id: row.id,
      supplierId: created.id,
      supplierName: 'Sokko Pastry',
    });
  });

  it('makes the supplier BEFORE pointing anything at it', async () => {
    const order: string[] = [];
    mocks.createSupplier.mockImplementation(async () => {
      order.push('supplier');
    });
    mocks.reassign.mockImplementation(async () => {
      order.push('reassign');
    });

    mocks.rows.current = [unlisted({ business_id: BUSINESSES[0]!.id, business: BUSINESSES[0] })];
    open();

    fireEvent.click(screen.getByRole('button', { name: 'Choose the real supplier' }));
    fireEvent.change(screen.getByLabelText('Supplier'), { target: { value: 'Sokko Pastry' } });
    fireEvent.mouseDown(
      await screen.findByRole('button', { name: /Add “Sokko Pastry” as a new supplier/ }),
    );

    // `invoices.supplier_id` is a foreign key. Offline the two queue in the
    // order they were made, so this order is the one that reaches the database.
    await waitFor(() => expect(order).toEqual(['supplier', 'reassign']));
  });

  it('does not offer to create a supplier that already exists', async () => {
    mocks.rows.current = [unlisted({ business_id: BUSINESSES[0]!.id, business: BUSINESSES[0] })];
    open();

    fireEvent.click(screen.getByRole('button', { name: 'Choose the real supplier' }));
    fireEvent.change(screen.getByLabelText('Supplier'), {
      target: { value: SUPPLIERS[0]!.name },
    });

    expect(
      screen.queryByRole('button', { name: /as a new supplier/ }),
    ).not.toBeInTheDocument();
  });

  it('never offers the placeholder as something to move onto', async () => {
    mocks.rows.current = [unlisted({ business_id: BUSINESSES[0]!.id, business: BUSINESSES[0] })];
    open();

    fireEvent.click(screen.getByRole('button', { name: 'Choose the real supplier' }));
    fireEvent.change(screen.getByLabelText('Supplier'), { target: { value: 'not listed' } });

    // It is in the supplier list this field was handed, and must not be in the
    // menu: moving a placeholder onto itself is not a correction.
    const menu = screen.queryAllByRole('button', { name: placeholder.name });
    expect(menu).toHaveLength(0);
  });
});

describe('rejecting', () => {
  it('asks first, and says whoever entered it will not be told', () => {
    mocks.rows.current = [listed({ business_id: BUSINESSES[0]!.id, business: BUSINESSES[0] })];
    open();

    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    const dialog = within(screen.getByRole('alertdialog'));
    expect(dialog.getByText(/Whoever entered it is not told/)).toBeInTheDocument();
    expect(mocks.voidInvoice).not.toHaveBeenCalled();
  });

  it('voids with a reason rather than deleting — rule 5', async () => {
    const row = listed({ business_id: BUSINESSES[0]!.id, business: BUSINESSES[0] });
    mocks.rows.current = [row];
    open();

    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Reject' }),
    );

    await waitFor(() =>
      expect(mocks.voidInvoice).toHaveBeenCalledWith({
        id: row.id,
        reason: expect.stringContaining('Rejected'),
      }),
    );
  });

  it('writes nothing if you go back', () => {
    mocks.rows.current = [listed({ business_id: BUSINESSES[0]!.id, business: BUSINESSES[0] })];
    open();

    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Go back' }),
    );
    expect(mocks.voidInvoice).not.toHaveBeenCalled();
  });
});

describe('renders nothing broken — notes §6', () => {
  it('with a mixed queue', () => {
    mocks.rows.current = [
      listed({ business_id: BUSINESSES[0]!.id, business: BUSINESSES[0] }),
      unlisted({ business_id: BUSINESSES[1]!.id, business: BUSINESSES[1] }),
    ];
    const { container } = open();
    const text = container.textContent ?? '';
    for (const token of ['undefined', 'NaN', '[object Object]', 'Invalid Date']) {
      expect(text).not.toContain(token);
    }
  });
});
