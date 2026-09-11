import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { onlineManager } from '@tanstack/react-query';
import { ToastProvider } from '@/components/ui/Toast';
import { BUSINESSES, SUPPLIERS } from '../fixtures/invoices';
import type { Profile, Supplier } from '@/lib/types';

/**
 * An assistant filing against "Supplier not listed". CATCH_UP_026.
 *
 * ===========================================================================
 * The hole this closes, stated plainly so the tests below read as a fix.
 *
 * CATCH_UP_022 gave the assistant tier the venue's placeholder row, because
 * neither may create a supplier. In the venue's design that is only half a
 * mechanism — the other half is Review, where a manager reads the note, makes
 * the real supplier and points the invoice at it. `stamp_approval` sends a
 * venue's entry there by leaving `approved_at` null.
 *
 * It did not do that for an assistant. Their placeholder invoice was approved
 * on the way in, so it never reached the one screen that can fix it, and sat
 * in the ledger and in the owed total under a placeholder with nobody asked
 * to do anything about it. ARCHITECTURE §36.7 names that outcome exactly:
 * "a member who files against it loses an invoice in plain sight."
 *
 * Two consequences, and both are asserted here rather than assumed:
 *
 *   the note becomes REQUIRED  — it is the only record of who sent it
 *   the row is NOT rendered as owed — because the trigger will hold it back
 *
 * The narrowness is also asserted. An assistant naming a real supplier is
 * unchanged: no required note, no review, straight into the ledger. That is
 * CATCH_UP_022 §5's decision and this file must not quietly reverse it.
 * ===========================================================================
 */

const ASSISTANT: Profile = {
  id: 'p-assistant',
  display_name: 'Milan',
  initials: 'MI',
  accent: 'person-2',
  role: 'assistant',
  notify_on_new_invoice: false,
  reminder_time: null,
  title: null,
  active: true,
  business_id: null,
};

/** The one seeded placeholder row. Flagged by column, never matched by name. */
const UNLISTED: Supplier = {
  id: 's-unlisted',
  name: 'Supplier not listed',
  default_terms_days: null,
  contact_name: null,
  contact_phone: null,
  notes: null,
  active: true,
  is_placeholder: true,
};

const WITH_PLACEHOLDER = [...SUPPLIERS, UNLISTED];

const mocks = vi.hoisted(() => ({
  addNoteMutate: vi.fn(),
  createInvoiceMutate: vi.fn(),
  createSupplierMutate: vi.fn(),
  findDuplicates: vi.fn(),
}));

vi.mock('@/lib/queries/session', () => ({
  useCurrentProfile: () => ({ data: ASSISTANT, isLoading: false, isError: false }),
  useProfiles: () => ({ data: [ASSISTANT] }),
  useSignOut: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/lib/queries/detail', () => ({
  useAddNote: () => ({
    mutateAsync: mocks.addNoteMutate,
    mutate: mocks.addNoteMutate,
    isPending: false,
  }),
  useRecentActivity: () => ({ data: [] }),
  useInvoice: () => ({ data: null, isLoading: false }),
  useInvoiceActivity: () => ({ data: [] }),
  useInvoiceNotes: () => ({ data: [] }),
}));

vi.mock('@/lib/queries/reference', () => ({
  useBusinesses: () => ({ data: BUSINESSES }),
  useSuppliers: () => ({ data: WITH_PLACEHOLDER }),
  useCreateSupplier: () => ({
    mutateAsync: mocks.createSupplierMutate,
    mutate: mocks.createSupplierMutate,
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
  useCreateInvoice: () => ({
    mutateAsync: mocks.createInvoiceMutate,
    mutate: mocks.createInvoiceMutate,
    isPending: false,
  }),
  findDuplicates: mocks.findDuplicates,
  useUnpaidInvoices: () => ({ data: [], isLoading: false }),
}));

const { AddInvoiceSheet } = await import('@/components/invoice/AddInvoiceSheet');

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  onlineManager.setOnline(true);
  mocks.createInvoiceMutate.mockResolvedValue({ internal_ref: 'GMH-260911-01' });
  mocks.findDuplicates.mockResolvedValue([]);
});

function open() {
  return render(
    <ToastProvider>
      <AddInvoiceSheet open onClose={() => {}} />
    </ToastProvider>,
  );
}

function pickSupplier(name: string) {
  fireEvent.change(screen.getByLabelText('Supplier'), { target: { value: name.slice(0, 6) } });
  fireEvent.mouseDown(screen.getByRole('button', { name: new RegExp(name) }));
}

function enterAmount(amount: string) {
  fireEvent.change(screen.getByLabelText('Amount'), { target: { value: amount } });
}

const save = () => fireEvent.click(screen.getByRole('button', { name: /Save invoice/ }));

describe('what an assistant is offered', () => {
  it('cannot create a supplier, because the database would refuse the insert', () => {
    open();
    fireEvent.change(screen.getByLabelText('Supplier'), {
      target: { value: 'Somebody Brand New' },
    });

    expect(screen.queryByRole('button', { name: /as a new supplier/ })).not.toBeInTheDocument();
  });

  it('is offered the placeholder instead, and told what to do with it', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Show all suppliers' }));

    expect(screen.getByRole('button', { name: /Supplier not listed/ })).toBeInTheDocument();
    expect(screen.getByText(/write who it is from in the note/)).toBeInTheDocument();
  });
});

describe('the note, on "Supplier not listed"', () => {
  it('blocks the save when it is empty — the one check here that is not a warning', async () => {
    open();
    pickSupplier('Supplier not listed');
    enterAmount('250');
    save();

    expect(
      await screen.findByText(/Write who this invoice is from — nothing else will know/),
    ).toBeInTheDocument();
    expect(mocks.createInvoiceMutate).not.toHaveBeenCalled();
  });

  it('asks the question in the label as well, not only when it fails', () => {
    open();
    pickSupplier('Supplier not listed');
    expect(screen.getByText('Who is it from?')).toBeInTheDocument();
  });

  it('clears the complaint as soon as something is typed', async () => {
    open();
    pickSupplier('Supplier not listed');
    enterAmount('250');
    save();
    await screen.findByText(/nothing else will know/);

    fireEvent.change(screen.getByLabelText(/Who is it from\?/), {
      target: { value: 'Global Foods Department' },
    });
    expect(screen.queryByText(/nothing else will know/)).not.toBeInTheDocument();
  });

  it('saves once it is there, and sends the note with it', async () => {
    open();
    pickSupplier('Supplier not listed');
    enterAmount('250');
    fireEvent.change(screen.getByLabelText(/Who is it from\?/), {
      target: { value: 'Global Foods Department' },
    });
    save();

    await waitFor(() => expect(mocks.createInvoiceMutate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.addNoteMutate).toHaveBeenCalledTimes(1));
    expect(mocks.addNoteMutate.mock.calls[0]![0]).toMatchObject({
      body: 'Global Foods Department',
    });
  });
});

describe('where the invoice goes', () => {
  it('tells the mutation not to render it as owed', async () => {
    open();
    pickSupplier('Supplier not listed');
    enterAmount('250');
    fireEvent.change(screen.getByLabelText(/Who is it from\?/), {
      target: { value: 'Global Foods Department' },
    });
    save();

    await waitFor(() => expect(mocks.createInvoiceMutate).toHaveBeenCalled());
    expect(mocks.createInvoiceMutate.mock.calls[0]![0]).toMatchObject({ awaitsReview: true });
  });

  it('says so, because there is no row anywhere for them to find afterwards', async () => {
    open();
    pickSupplier('Supplier not listed');
    enterAmount('250');
    fireEvent.change(screen.getByLabelText(/Who is it from\?/), {
      target: { value: 'Global Foods Department' },
    });
    save();

    expect(await screen.findByText(/Sent for review/)).toBeInTheDocument();
  });
});

/**
 * The half CATCH_UP_022 §5 decided, which this must not have reversed.
 *
 * The bottleneck argument — that queueing everything would put a manager in
 * front of every invoice — is about exactly these entries, and it still holds.
 */
describe('an assistant naming a real supplier is unchanged', () => {
  it('needs no note', async () => {
    open();
    pickSupplier('Bidfood');
    enterAmount('250');
    save();

    await waitFor(() => expect(mocks.createInvoiceMutate).toHaveBeenCalledTimes(1));
  });

  it('does not wait for review', async () => {
    open();
    pickSupplier('Bidfood');
    enterAmount('250');
    save();

    await waitFor(() => expect(mocks.createInvoiceMutate).toHaveBeenCalled());
    expect(mocks.createInvoiceMutate.mock.calls[0]![0]).toMatchObject({ awaitsReview: false });
  });

  it('keeps the ordinary note label and the ordinary toast', async () => {
    open();
    pickSupplier('Bidfood');
    expect(screen.getByText('Note')).toBeInTheDocument();

    enterAmount('250');
    save();
    expect(await screen.findByText(/GMH-260911-01/)).toBeInTheDocument();
  });
});
