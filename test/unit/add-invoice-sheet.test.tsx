import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '@/components/ui/Toast';
import { BUSINESSES, SUPPLIERS } from '../fixtures/invoices';
import { addDays, formatDayWithYear, sydneyToday } from '@/lib/date';
import type { Profile } from '@/lib/types';

/**
 * The fifteen-second screen, driven the way a thumb drives it.
 *
 * Spec §10 says this phase gets the most polish, and notes §7 says he tests on
 * a real phone — so these do not replace that. What they do is make the parts
 * that are invisible on a phone provable: that the payload sent to the
 * database is exactly right, that the supplier's terms actually move the due
 * date, and that a duplicate warns without ever blocking.
 */

const profile: Profile = {
  id: '2da43dcf-8b0f-4229-bf5c-e5af68210045',
  display_name: 'Rabindra',
  initials: 'RA',
  accent: '#12384B',
  role: 'owner',
  notify_on_new_invoice: true,
  active: true,
};

const mocks = vi.hoisted(() => ({
  createInvoiceMutate: vi.fn(),
  createSupplierMutate: vi.fn(),
  findDuplicates: vi.fn(),
}));

vi.mock('@/lib/queries/session', () => ({
  useCurrentProfile: () => ({ data: profile, isLoading: false, isError: false }),
  useSignOut: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/lib/queries/reference', () => ({
  useBusinesses: () => ({ data: BUSINESSES }),
  useSuppliers: () => ({ data: SUPPLIERS }),
  useCreateSupplier: () => ({ mutateAsync: mocks.createSupplierMutate, isPending: false }),
}));

vi.mock('@/lib/queries/invoices', () => ({
  useCreateInvoice: () => ({ mutateAsync: mocks.createInvoiceMutate, isPending: false }),
  findDuplicates: mocks.findDuplicates,
  useUnpaidInvoices: () => ({ data: [], isLoading: false }),
}));

const { AddInvoiceSheet } = await import('@/components/invoice/AddInvoiceSheet');

/**
 * Dates are derived from the real Sydney today rather than a frozen clock.
 *
 * An earlier version called vi.setSystemTime without vi.useFakeTimers, which
 * does nothing — so it was quietly asserting against whatever day the suite
 * happened to run on, and would have started failing on its own. Deriving is
 * both honest and timezone-proof.
 */
const TODAY = sydneyToday();
const due = (days: number) => addDays(TODAY, days);
const dueLabel = (days: number) => formatDayWithYear(addDays(TODAY, days));

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  mocks.createInvoiceMutate.mockResolvedValue({ internal_ref: 'GMH-260828-03' });
  mocks.findDuplicates.mockResolvedValue([]);
});

function open() {
  return render(
    <ToastProvider>
      <AddInvoiceSheet open onClose={() => {}} />
    </ToastProvider>,
  );
}

function typeSupplier(text: string) {
  fireEvent.change(screen.getByLabelText('Supplier'), { target: { value: text } });
}

function pickSupplier(name: string) {
  typeSupplier(name.slice(0, 3));
  fireEvent.mouseDown(screen.getByRole('button', { name: new RegExp(name) }));
}

function enterAmount(amount: string) {
  fireEvent.change(screen.getByLabelText('Amount'), { target: { value: amount } });
}

const save = () => fireEvent.click(screen.getByRole('button', { name: /Save invoice/ }));

describe('the common case: four taps and a number', () => {
  it('sends exactly the right payload', async () => {
    open();

    fireEvent.click(screen.getByRole('button', { name: 'GMH' }));
    pickSupplier('Bidfood');
    enterAmount('5,220.00');
    save();

    await waitFor(() => expect(mocks.createInvoiceMutate).toHaveBeenCalledTimes(1));

    const { payload, supplier, business } = mocks.createInvoiceMutate.mock.calls[0]![0];

    expect(payload.amount_cents).toBe(522_000);
    expect(payload.business_id).toBe(BUSINESSES.find((b) => b.code === 'GMH')!.id);
    expect(payload.supplier_id).toBe(SUPPLIERS.find((s) => s.name === 'Bidfood')!.id);
    expect(payload.created_by).toBe(profile.id);
    expect(payload.invoice_date).toBe(TODAY);
    // Bidfood is 14-day terms.
    expect(payload.due_date).toBe(due(14));
    expect(payload.invoice_number).toBeNull();

    // Notes §1.5: the id is generated before sending, so a replayed offline
    // write conflicts on the primary key instead of duplicating.
    expect(payload.id).toMatch(/^[0-9a-f-]{36}$/);

    // The reference is the database's job, never the client's.
    expect(payload).not.toHaveProperty('internal_ref');

    expect(supplier.name).toBe('Bidfood');
    expect(business.code).toBe('GMH');
  });

  it('confirms with the reference the database actually assigned', async () => {
    open();
    pickSupplier('Bidfood');
    enterAmount('100');
    save();

    expect(await screen.findByText('Saved · GMH-260828-03')).toBeInTheDocument();
  });

  it('is honest when the write is queued rather than saved', async () => {
    // networkMode 'offlineFirst' pauses the write; calling that "saved" is a
    // lie the person will act on (notes §1.5).
    mocks.createInvoiceMutate.mockRejectedValue(new Error('offline'));
    open();
    pickSupplier('Bidfood');
    enterAmount('100');
    save();

    expect(await screen.findByText(/will send when you’re back online/)).toBeInTheDocument();
  });
});

describe('the supplier field', () => {
  it('finds a supplier from three letters', () => {
    open();
    typeSupplier('bid');
    expect(screen.getByRole('button', { name: /Bidfood/ })).toBeInTheDocument();
  });

  it('applies that supplier’s payment terms to the due date', () => {
    open();

    // PFD is 7-day terms, Himalayan is 30.
    pickSupplier('PFD Food Services');
    expect(screen.getByText(dueLabel(7))).toBeInTheDocument();

    typeSupplier('Him');
    fireEvent.mouseDown(screen.getByRole('button', { name: /Himalayan Wholesale/ }));
    expect(screen.getByText(dueLabel(30))).toBeInTheDocument();
  });

  it('falls back to the shared default for a supplier with no terms', () => {
    open();
    // Southern Cross Packaging has null terms.
    typeSupplier('Southern');
    fireEvent.mouseDown(screen.getByRole('button', { name: /Southern Cross Packaging/ }));
    expect(screen.getByText(dueLabel(14))).toBeInTheDocument();
  });

  it('offers to create a supplier that does not exist, and selects it', async () => {
    const created = {
      id: 'new-supplier-id',
      name: 'Newtown Provisions',
      default_terms_days: null,
      contact_name: null,
      contact_phone: null,
      notes: null,
      active: true,
    };
    mocks.createSupplierMutate.mockResolvedValue(created);

    open();
    typeSupplier('Newtown Provisions');
    fireEvent.mouseDown(screen.getByRole('button', { name: /Add “Newtown Provisions”/ }));

    await waitFor(() =>
      expect(mocks.createSupplierMutate).toHaveBeenCalledWith({
        name: 'Newtown Provisions',
        actorId: profile.id,
      }),
    );

    enterAmount('50');
    save();

    await waitFor(() => expect(mocks.createInvoiceMutate).toHaveBeenCalled());
    expect(mocks.createInvoiceMutate.mock.calls[0]![0].payload.supplier_id).toBe('new-supplier-id');
  });
});

describe('validation', () => {
  it('will not save without a supplier, and says which field', () => {
    open();
    enterAmount('100');
    save();

    expect(mocks.createInvoiceMutate).not.toHaveBeenCalled();
    expect(screen.getByText('Choose a supplier.')).toBeInTheDocument();
  });

  it('rejects an amount that is not a clean number', () => {
    open();
    pickSupplier('Bidfood');
    enterAmount('abc');
    save();

    expect(mocks.createInvoiceMutate).not.toHaveBeenCalled();
    expect(screen.getByText(/doesn’t look right/)).toBeInTheDocument();
  });

  it('uses a text input with a decimal keypad, never type=number', () => {
    // Notes §4: type="number" brings spinners, changes value on scroll, and
    // behaves inconsistently with locale separators.
    open();
    const amount = screen.getByLabelText('Amount');
    expect(amount).toHaveAttribute('type', 'text');
    expect(amount).toHaveAttribute('inputmode', 'decimal');
  });
});

describe('the duplicate warning — spec §6', () => {
  const existing = {
    id: 'existing',
    internal_ref: 'GMH-260801-07',
    amount_cents: 522_000,
    invoice_number: 'INV-1234',
  };

  function fillWithNumber() {
    pickSupplier('Bidfood');
    enterAmount('5220');
    fireEvent.click(screen.getByRole('button', { name: /Invoice number, date/ }));
    fireEvent.change(screen.getByLabelText('Invoice number'), {
      target: { value: 'INV-1234' },
    });
  }

  it('warns, naming the existing invoice, instead of saving', async () => {
    mocks.findDuplicates.mockResolvedValue([existing]);
    open();
    fillWithNumber();
    save();

    const warning = await screen.findByRole('alert');
    expect(warning).toHaveTextContent(/already logged/);
    expect(within(warning).getByText('GMH-260801-07')).toBeInTheDocument();
    expect(within(warning).getByText('$5,220.00')).toBeInTheDocument();
    expect(mocks.createInvoiceMutate).not.toHaveBeenCalled();
  });

  it('never blocks — "Save anyway" goes through', async () => {
    mocks.findDuplicates.mockResolvedValue([existing]);
    open();
    fillWithNumber();
    save();

    fireEvent.click(await screen.findByRole('button', { name: 'Save anyway' }));

    await waitFor(() => expect(mocks.createInvoiceMutate).toHaveBeenCalledTimes(1));
    expect(mocks.createInvoiceMutate.mock.calls[0]![0].payload.invoice_number).toBe('INV-1234');
  });

  it('does not check when no invoice number was entered', async () => {
    open();
    pickSupplier('Bidfood');
    enterAmount('100');
    save();

    await waitFor(() => expect(mocks.createInvoiceMutate).toHaveBeenCalled());
    expect(mocks.findDuplicates).not.toHaveBeenCalled();
  });

  it('saves anyway if the duplicate check itself fails', async () => {
    // The warning is a courtesy. Losing the invoice is not acceptable.
    mocks.findDuplicates.mockRejectedValue(new Error('network'));
    open();
    fillWithNumber();
    save();

    await waitFor(() => expect(mocks.createInvoiceMutate).toHaveBeenCalledTimes(1));
  });
});

describe('the optional fields', () => {
  it('are collapsed until asked for — spec §7.3', () => {
    open();
    expect(screen.queryByLabelText('Invoice number')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Invoice number, date/ }));
    expect(screen.getByLabelText('Invoice number')).toBeInTheDocument();
  });
});

describe('business selection', () => {
  it('remembers the last one used on this device', async () => {
    localStorage.setItem('shg.business.selected', BUSINESSES[2]!.id);
    open();

    expect(screen.getByRole('button', { name: 'MJR' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('stores the choice when an invoice is saved', async () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'DDL' }));
    pickSupplier('Bidfood');
    enterAmount('100');
    save();

    await waitFor(() =>
      expect(localStorage.getItem('shg.business.selected')).toBe(
        BUSINESSES.find((b) => b.code === 'DDL')!.id,
      ),
    );
  });
});
