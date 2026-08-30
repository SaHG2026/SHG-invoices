import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '@/components/ui/Toast';
import { BUSINESSES, PROFILES, SUPPLIERS, makeInvoice } from '../fixtures/invoices';
import type { ActivityEntry, InvoiceNote } from '@/lib/types';

/**
 * The invoice detail screen. Spec §7.6.
 *
 * The screen people open when they disagree about an invoice, so what matters
 * is that the record is complete and legible: one stream, no tabs, every event
 * carrying a name and a time.
 *
 * Un-ticking lives here and nowhere else — spec §6 says it must not be
 * swipeable from a list, "too easy to fat-finger" — and it must ask first.
 */

const invoice = makeInvoice({ id: 'i-1', status: 'unpaid', invoice_number: 'INV-1234' });

const activity: ActivityEntry[] = [
  {
    id: 1,
    entity_type: 'invoice',
    entity_id: 'i-1',
    action: 'created',
    actor_id: 'p-milan',
    detail: { amount_cents: 542_000 },
    created_at: '2026-08-28T23:14:00.000Z',
  },
  {
    id: 2,
    entity_type: 'invoice',
    entity_id: 'i-1',
    action: 'edited',
    actor_id: 'p-sujan',
    detail: { amount_cents: { from: 542_000, to: 522_000 } },
    created_at: '2026-08-29T06:02:00.000Z',
  },
];

const notes: InvoiceNote[] = [
  {
    id: 'n-1',
    invoice_id: 'i-1',
    author_id: 'p-milan',
    body: 'Short delivery — 2 cartons missing, credit note expected',
    created_at: '2026-08-28T23:15:00.000Z',
  },
];

const mocks = vi.hoisted(() => ({
  invoice: { current: null as unknown },
  unmark: vi.fn(),
  voidIt: vi.fn(),
  addNote: vi.fn(),
}));

vi.mock('@/lib/queries/session', () => ({
  useCurrentProfile: () => ({ data: PROFILES[3], isLoading: false, isError: false }),
  useProfiles: () => ({ data: PROFILES }),
  useSignOut: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/lib/queries/detail', () => ({
  useInvoice: () => ({ data: mocks.invoice.current, isLoading: false }),
  useInvoiceActivity: () => ({ data: activity }),
  useInvoiceNotes: () => ({ data: notes }),
  useAddNote: () => ({ mutateAsync: mocks.addNote, isPending: false }),
  useRecentActivity: () => ({ data: [] }),
}));

vi.mock('@/lib/queries/payments', () => ({
  useMarkPaid: () => ({ mutateAsync: vi.fn().mockResolvedValue({ paid: [], missed: [] }), isPending: false }),
  useUnmarkPaid: () => ({ mutateAsync: mocks.unmark, isPending: false }),
  useVoidInvoice: () => ({ mutateAsync: mocks.voidIt, isPending: false }),
}));

vi.mock('@/lib/queries/invoices', () => ({
  useUnpaidInvoices: () => ({ data: [], isLoading: false }),
  useCreateInvoice: () => ({ mutateAsync: vi.fn(), isPending: false }),
  findDuplicates: vi.fn(),
}));

vi.mock('@/lib/queries/reference', () => ({
  useBusinesses: () => ({ data: BUSINESSES }),
  useSuppliers: () => ({ data: SUPPLIERS }),
  useCreateSupplier: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

const { InvoiceDetail } = await import('@/components/screens/InvoiceDetail');

function open() {
  return render(
    <ToastProvider>
      <InvoiceDetail id="i-1" />
    </ToastProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  mocks.invoice.current = invoice;
  mocks.unmark.mockResolvedValue(invoice);
  mocks.voidIt.mockResolvedValue(invoice);
  mocks.addNote.mockResolvedValue(notes[0]);
});

describe('the stream — spec §7.6', () => {
  it('mixes notes and activity in one list, not tabs', () => {
    open();
    // Tabs would let somebody read the notes and miss that the amount changed
    // underneath them.
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();

    expect(screen.getByText(/Short delivery/)).toBeInTheDocument();
    expect(screen.getByText(/added this invoice/)).toBeInTheDocument();
    expect(screen.getByText(/changed the amount/)).toBeInTheDocument();
  });

  it('shows the amount change in money, both sides', () => {
    open();
    const line = screen.getByText(/changed the amount/).closest('div')!;
    expect(within(line).getByText(/\$5,420\.00/)).toBeInTheDocument();
    expect(within(line).getByText(/\$5,220\.00/)).toBeInTheDocument();
  });

  it('names who did each thing', () => {
    open();
    expect(screen.getAllByText('Milan').length).toBeGreaterThan(0);
    expect(screen.getByText('Sujan')).toBeInTheDocument();
  });

  it('reads oldest first, so it tells the story in order', () => {
    const { container } = open();
    const text = container.textContent ?? '';
    expect(text.indexOf('added this invoice')).toBeLessThan(text.indexOf('changed the amount'));
  });
});

describe('adding a note', () => {
  it('sends it and clears the box', async () => {
    open();
    const box = screen.getByLabelText('Add a note');
    fireEvent.change(box, { target: { value: 'Credit note received' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(mocks.addNote).toHaveBeenCalled());
    expect(mocks.addNote.mock.calls[0]![0].body).toBe('Credit note received');
    expect(box).toHaveValue('');
  });

  it('gives the text back if it could not be saved', async () => {
    mocks.addNote.mockRejectedValue(new Error('offline'));
    open();

    fireEvent.change(screen.getByLabelText('Add a note'), { target: { value: 'Important' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    // Losing what somebody typed is never acceptable.
    await waitFor(() => expect(screen.getByLabelText('Add a note')).toHaveValue('Important'));
    expect(await screen.findByText(/check your connection/)).toBeInTheDocument();
  });

  it('will not send an empty note', () => {
    open();
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
  });
});

describe('un-ticking — spec §6', () => {
  beforeEach(() => {
    mocks.invoice.current = {
      ...invoice,
      status: 'paid',
      paid_by: 'p-mani',
      paid_at: '2026-09-11T22:30:00.000Z',
      payment_ref: 'TFR-88213',
    };
  });

  it('shows who paid it and when', () => {
    open();
    expect(screen.getByText(/Paid by Mani/)).toBeInTheDocument();
    expect(screen.getByText(/TFR-88213/)).toBeInTheDocument();
  });

  it('asks before undoing, and names the consequence', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Put back to unpaid' }));

    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('recorded in the history with your name on it');
    // Opening the confirm must not have changed anything yet.
    expect(mocks.unmark).not.toHaveBeenCalled();
  });

  it('undoes it once confirmed', async () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Put back to unpaid' }));
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Put back to unpaid' }),
    );

    await waitFor(() => expect(mocks.unmark).toHaveBeenCalledWith('i-1'));
    expect(await screen.findByText('Put back to unpaid.')).toBeInTheDocument();
  });

  it('offers no way to mark paid twice', () => {
    open();
    expect(screen.queryByRole('button', { name: 'Mark paid' })).not.toBeInTheDocument();
  });
});

describe('voiding — notes §8, never delete', () => {
  it('refuses without a reason', async () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Void' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Void it' }));

    expect(await screen.findByText(/A reason is needed/)).toBeInTheDocument();
    expect(mocks.voidIt).not.toHaveBeenCalled();
  });

  it('voids with the reason attached', async () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Void' }));
    fireEvent.change(screen.getByLabelText('Reason for voiding'), {
      target: { value: 'Duplicate of GMH-260828-02' },
    });
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Void it' }));

    await waitFor(() =>
      expect(mocks.voidIt).toHaveBeenCalledWith({
        id: 'i-1',
        reason: 'Duplicate of GMH-260828-02',
      }),
    );
  });

  it('says it stays in the history rather than disappearing', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Void' }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Nothing is ever deleted');
  });

  it('shows the reason afterwards, and offers no further actions', () => {
    mocks.invoice.current = { ...invoice, status: 'void', void_reason: 'Entered twice' };
    open();

    expect(screen.getByText(/Voided — Entered twice/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark paid' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Void' })).not.toBeInTheDocument();
  });
});

describe('a missing invoice', () => {
  it('explains rather than showing an empty screen', () => {
    mocks.invoice.current = null;
    open();
    expect(screen.getByText('No such invoice')).toBeInTheDocument();
    expect(screen.getByText(/still in the history/)).toBeInTheDocument();
  });
});

describe('nothing broken — notes §6', () => {
  it('renders no undefined, NaN or [object Object]', () => {
    const { container } = open();
    const text = container.textContent ?? '';
    for (const token of ['undefined', 'NaN', '[object Object]', 'Invalid Date']) {
      expect(text).not.toContain(token);
    }
  });
});
