import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '@/components/ui/Toast';
import { BUSINESSES, PROFILES, SUPPLIERS, makeInvoices } from '../fixtures/invoices';
import { formatCents, sumCents } from '@/lib/money';
import { groupIntoRuns } from '@/lib/derive/runs';

/**
 * Marking paid.
 *
 * Notes §1.6 is the whole reason this is shaped the way it is:
 *
 *   "If ticking a whole run is implemented as a loop of individual updates, a
 *   mid-loop failure leaves some invoices paid and some not, with no
 *   indication which. In a money app that's the worst possible partial state."
 *
 * So the assertion that matters most is not that a tick works — it is that
 * ticking three invoices produces exactly ONE call carrying three ids.
 */

const invoices = makeInvoices(60).map((invoice, i) => ({
  ...invoice,
  created_by: PROFILES[i % PROFILES.length]!.id,
}));

const mocks = vi.hoisted(() => ({ markPaid: vi.fn() }));

vi.mock('@/lib/queries/session', () => ({
  useCurrentProfile: () => ({ data: PROFILES[3], isLoading: false, isError: false }),
  useProfiles: () => ({ data: PROFILES }),
  useSignOut: () => ({ mutate: vi.fn(), isPending: false }),
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

vi.mock('@/lib/queries/payments', () => ({
  useMarkPaid: () => ({ mutateAsync: mocks.markPaid, isPending: false }),
  useUnmarkPaid: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useVoidInvoice: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/lib/queries/detail', () => ({
  useRecentActivity: () => ({ data: [] }),
  useInvoice: () => ({ data: null, isLoading: false }),
  useInvoiceActivity: () => ({ data: [] }),
  useInvoiceNotes: () => ({ data: [] }),
  useAddNote: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

const { WeekView } = await import('@/components/screens/WeekView');

function open(scope = 'all') {
  return render(
    <ToastProvider>
      <WeekView scope={scope} />
    </ToastProvider>,
  );
}

/** The multi-invoice runs the fixture produces. */
const runs = groupIntoRuns(invoices).filter((run) => run.invoices.length > 1);

/** The confirm button inside the sheet, not a row's tick of the same name. */
function confirmInSheet() {
  return within(screen.getByRole('dialog')).getByRole('button', { name: 'Mark paid' });
}

function expandRun(run: (typeof runs)[number]) {
  const button = screen
    .getAllByRole('button', { expanded: false })
    .find((b) => b.textContent?.includes(`${run.invoices.length} invoices`))!;
  fireEvent.click(button);
  return button;
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  mocks.markPaid.mockResolvedValue({ paid: [], missed: [] });
});

describe('a whole payment run — notes §1.6', () => {
  it('sends one call with every id, never a loop', async () => {
    const run = runs[0]!;
    mocks.markPaid.mockResolvedValue({
      paid: run.invoices.map((invoice) => ({ id: invoice.id })),
      missed: [],
    });

    open();
    expandRun(run);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`Mark all ${run.invoices.length} paid`) }));
    fireEvent.click(confirmInSheet());

    await waitFor(() => expect(mocks.markPaid).toHaveBeenCalledTimes(1));

    // One call. Three ids. Not three calls.
    const { ids } = mocks.markPaid.mock.calls[0]![0];
    expect(ids).toHaveLength(run.invoices.length);
    expect(new Set(ids)).toEqual(new Set(run.invoices.map((invoice) => invoice.id)));
  });

  it('shows the combined total before confirming', () => {
    const run = runs[0]!;
    open();
    expandRun(run);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`Mark all ${run.invoices.length} paid`) }));

    const sheet = screen.getByRole('dialog');
    expect(within(sheet).getAllByText(formatCents(sumCents(run.invoices))).length).toBeGreaterThan(0);
    expect(within(sheet).getByText(run.supplier.name, { exact: false })).toBeInTheDocument();
  });

  it('carries the payment reference through', async () => {
    const run = runs[0]!;
    open();
    expandRun(run);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`Mark all ${run.invoices.length} paid`) }));

    fireEvent.change(screen.getByLabelText('Payment reference'), {
      target: { value: 'TFR-88213' },
    });
    fireEvent.click(confirmInSheet());

    await waitFor(() => expect(mocks.markPaid).toHaveBeenCalled());
    expect(mocks.markPaid.mock.calls[0]![0].reference).toBe('TFR-88213');
  });

  it('can still pay one invoice out of a run', async () => {
    const run = runs[0]!;
    open();
    const runButton = expandRun(run);

    // Open one child. The run must stay open — an earlier version collapsed
    // it here, which made the invoice you had just tapped disappear.
    const item = runButton.closest('li')!;
    const child = within(item).getAllByRole('button', { expanded: false })[0]!;
    fireEvent.click(child);
    expect(child).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(within(item).getAllByRole('button', { name: 'Mark paid' })[0]!);
    fireEvent.click(confirmInSheet());

    await waitFor(() => expect(mocks.markPaid).toHaveBeenCalled());
    expect(mocks.markPaid.mock.calls[0]![0].ids).toHaveLength(1);
  });
});

describe('when somebody else got there first', () => {
  it('says so instead of claiming credit', async () => {
    const run = runs[0]!;
    // The RPC only flips rows still unpaid, so it returns fewer than asked.
    mocks.markPaid.mockResolvedValue({
      paid: [{ id: run.invoices[0]!.id }],
      missed: run.invoices.slice(1).map((invoice) => invoice.id),
    });

    open();
    expandRun(run);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`Mark all ${run.invoices.length} paid`) }));
    fireEvent.click(confirmInSheet());

    expect(await screen.findByText(/were already done/)).toBeInTheDocument();
  });

  it('does not claim any of it when all were already paid', async () => {
    const run = runs[0]!;
    mocks.markPaid.mockResolvedValue({
      paid: [],
      missed: run.invoices.map((invoice) => invoice.id),
    });

    open();
    expandRun(run);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`Mark all ${run.invoices.length} paid`) }));
    fireEvent.click(confirmInSheet());

    expect(await screen.findByText(/Already marked paid by someone else/)).toBeInTheDocument();
  });
});

describe('when it fails', () => {
  it('says what to do rather than "an error occurred" — spec §8', async () => {
    mocks.markPaid.mockRejectedValue(new Error('network'));
    const run = runs[0]!;

    open();
    expandRun(run);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`Mark all ${run.invoices.length} paid`) }));
    fireEvent.click(confirmInSheet());

    expect(await screen.findByText(/check your connection/)).toBeInTheDocument();
  });
});

describe('the tick is never one careless tap away — spec §6', () => {
  it('is not on the collapsed row', () => {
    open();
    // Nothing offers to take money until a row has been deliberately opened.
    expect(screen.queryByRole('button', { name: 'Mark paid' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Mark all/ })).not.toBeInTheDocument();
  });

  it('confirms with a sheet rather than paying on the first tap', () => {
    const run = runs[0]!;
    open();
    expandRun(run);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`Mark all ${run.invoices.length} paid`) }));

    // Opening the sheet must not have paid anything yet.
    expect(mocks.markPaid).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
