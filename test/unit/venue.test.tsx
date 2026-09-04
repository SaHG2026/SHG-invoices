import { beforeEach, describe, expect, it, vi } from 'vitest';
import { onlineManager } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '@/components/ui/Toast';
import { PROFILES, SUPPLIERS, VENUE_PROFILE } from '../fixtures/invoices';
import type { StaffInvoice } from '@/lib/types';

/**
 * The venue accounts — GroceryMate Parramatta and Hurstville. CATCH_UP_010.
 *
 * ---------------------------------------------------------------------------
 * What these tests are and are not for.
 *
 * They are NOT the security boundary and cannot stand in for it. Every real
 * rule here lives in the database — `is_member()`, `staff_venue()`, the
 * `staff_invoices` view, the insert policy's `with check` — and the only thing
 * that can prove those is `db/verify_rls.mjs` run as a real staff account
 * against a real project. Notes §2: "the button isn't rendered" is not access
 * control, and a test asserting that a button isn't rendered is not a security
 * test.
 *
 * What they DO cover is the half that a database cannot: that the interface
 * never states something false to a shop, and never offers what it cannot do.
 * The sharpest of those is payment status, because the failure mode is not an
 * error — it is a screen that looks completely fine and is lying.
 * ---------------------------------------------------------------------------
 */

const rows: StaffInvoice[] = [
  {
    id: 'v-1',
    business_id: 'b-gmp',
    supplier_id: 's-1',
    supplier_name: 'Bidfood',
    invoice_number: 'BF-9001',
    internal_ref: 'GMP-260903-01',
    invoice_date: '2026-09-03',
    due_date: '2026-09-17',
    amount_cents: 522000,
    created_at: '2026-09-03T09:00:00.000Z',
  },
  {
    id: 'v-2',
    business_id: 'b-gmp',
    supplier_id: 's-2',
    supplier_name: 'Anchor Dairy',
    invoice_number: null,
    internal_ref: 'GMP-260902-01',
    invoice_date: '2026-09-02',
    due_date: '2026-09-16',
    amount_cents: 118050,
    created_at: '2026-09-02T09:00:00.000Z',
  },
  {
    id: 'v-3',
    business_id: 'b-gmp',
    supplier_id: 's-1',
    supplier_name: 'Bidfood',
    invoice_number: 'BF-8800',
    internal_ref: 'GMP-260812-01',
    invoice_date: '2026-08-12',
    due_date: '2026-08-26',
    amount_cents: 300000,
    created_at: '2026-08-12T09:00:00.000Z',
  },
  {
    id: 'v-4',
    business_id: 'b-gmp',
    supplier_id: 's-2',
    supplier_name: 'Anchor Dairy',
    invoice_number: 'AD-77',
    internal_ref: 'GMP-260805-01',
    invoice_date: '2026-08-05',
    due_date: '2026-08-19',
    amount_cents: 45000,
    created_at: '2026-08-05T09:00:00.000Z',
  },
];

const mocks = vi.hoisted(() => ({
  createInvoice: vi.fn(),
  updateInvoice: vi.fn(),
  createSupplier: vi.fn(),
  findDuplicates: vi.fn(),
  venue: { data: [] as unknown[], isLoading: false, isError: false },
  profile: null as unknown,
  replace: vi.fn(),
  pathname: '/venue',
}));

vi.mock('@/lib/queries/venue', () => ({
  useVenueInvoices: () => mocks.venue,
  useCreateVenueInvoice: () => ({
    mutateAsync: mocks.createInvoice,
    mutate: mocks.createInvoice,
    isPending: false,
  }),
  useUpdateVenueInvoice: () => ({
    mutateAsync: mocks.updateInvoice,
    mutate: mocks.updateInvoice,
    isPending: false,
  }),
  findVenueDuplicates: mocks.findDuplicates,
}));

vi.mock('@/lib/queries/session', () => ({
  useCurrentProfile: () => ({ data: mocks.profile, isLoading: false, isError: false }),
  useProfiles: () => ({ data: PROFILES }),
}));

vi.mock('@/lib/queries/reference', () => ({
  useSuppliers: () => ({ data: SUPPLIERS }),
  useCreateSupplier: () => ({ mutateAsync: mocks.createSupplier, isPending: false }),
  optimisticSupplier: (id: string, name: string) => ({
    id,
    name,
    default_terms_days: null,
    contact_name: null,
    contact_phone: null,
    notes: null,
    active: true,
  }),
}));

vi.mock('@/lib/offline/pending', () => ({
  useQueuedWriteCount: () => 0,
  useIsOnline: () => true,
}));

vi.mock('next/navigation', () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => ({ replace: mocks.replace }),
}));

const { VenueInvoices } = await import('@/components/screens/VenueInvoices');
const { VenueGate } = await import('@/components/auth/VenueGate');
const { byMonth, stillCorrectable } = await import('@/lib/derive/venue');
const { VENUE_EDIT_WINDOW_MS } = await import('@/lib/constants');

/** The supplier field is a type-ahead — spec §7.3, three letters and pick. */
function pickSupplier(name: string) {
  fireEvent.change(screen.getByLabelText('Supplier'), { target: { value: name.slice(0, 3) } });
  fireEvent.mouseDown(screen.getByRole('button', { name: new RegExp(name) }));
}

function open() {
  return render(
    <ToastProvider>
      <VenueInvoices />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  /*
   * `submitWrite` asks `onlineManager` before it asks the mutation, and the
   * offline branch returns 'queued' without ever calling it. jsdom's default
   * is not reliably online, so a test that forgot this would fail claiming the
   * write was never attempted — which is true, and for a reason that has
   * nothing to do with the code under test.
   */
  onlineManager.setOnline(true);
  mocks.venue = { data: rows, isLoading: false, isError: false };
  mocks.profile = VENUE_PROFILE;
  mocks.pathname = '/venue';
});

/* -------------------------------------------------------------------------- */

describe('what a shop is never told', () => {
  /**
   * The one that matters most.
   *
   * The database is what actually withholds these — the view has no such
   * columns — but a screen that invented a status from something else would be
   * just as wrong and far harder to notice, because nothing would fail.
   */
  it('says nothing anywhere about paid, unpaid or overdue', () => {
    open();
    const page = document.body.textContent ?? '';
    expect(page).not.toMatch(/\bpaid\b/i);
    expect(page).not.toMatch(/\bunpaid\b/i);
    expect(page).not.toMatch(/\boverdue\b/i);
    expect(page).not.toMatch(/\boutstanding\b/i);
    expect(page).not.toMatch(/\bowe[sd]?\b/i);
  });

  /**
   * "What does this venue owe" IS the payment status, arithmetic instead of a
   * column. Any figure that separated settled from unsettled would hand over
   * exactly the withheld fact, in a form that is harder to spot than a badge.
   *
   * So the only totals on this screen are of what was ENTERED, and the way to
   * prove that is that they equal the whole month regardless of anything else.
   */
  it('totals what was entered, which is every row in the month', () => {
    open();
    // September: 5220.00 + 1180.50. August: 3000.00 + 450.00. Nothing excluded.
    expect(screen.getByText('$6,400.50')).toBeInTheDocument();
    expect(screen.getByText('$3,450.00')).toBeInTheDocument();
  });

  it('offers no way into an invoice, because detail is notes and payments', () => {
    open();
    expect(screen.queryAllByRole('link', { name: /Bidfood/ })).toHaveLength(0);
  });

  /**
   * The bell reads `activity_log`, which still says `is_member()` — so for a
   * venue it would be empty forever. Notes §6: do not offer what you cannot do.
   */
  it('has no activity bell and no menu', () => {
    open();
    expect(screen.queryByRole('button', { name: /Menu/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Notifications|Activity/i })).not.toBeInTheDocument();
  });
});

describe('what a shop is told', () => {
  it('lists its invoices newest month first, with supplier, date and amount', () => {
    open();
    expect(screen.getByText('September 2026')).toBeInTheDocument();
    expect(screen.getByText('August 2026')).toBeInTheDocument();
    expect(screen.getAllByText('Bidfood').length).toBeGreaterThan(0);
    expect(screen.getByText('$5,220.00')).toBeInTheDocument();

    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(['September 2026', 'August 2026']);
  });

  it('names the shop rather than a person', () => {
    open();
    expect(screen.getByText(/Logged for Parramatta/)).toBeInTheDocument();
  });

  it('says so plainly when nothing has been logged', () => {
    mocks.venue = { data: [], isLoading: false, isError: false };
    open();
    expect(screen.getByText(/Nothing logged yet/)).toBeInTheDocument();
  });

  /**
   * Spec §8: say what went wrong and what to do. A shop that cannot load its
   * list needs to know its unsent work is safe more than it needs a code.
   */
  it('names the problem and reassures about unsent work when the load fails', () => {
    mocks.venue = { data: [], isLoading: false, isError: true };
    open();
    expect(screen.getByText(/Couldn’t load your invoices/)).toBeInTheDocument();
    expect(screen.getByText(/is safe/)).toBeInTheDocument();
  });

  /**
   * The reference is stamped by a database trigger, so a row that has just
   * been entered and not yet sent genuinely has none. Showing an invented one
   * would be a lie that changes under whoever read it.
   */
  it('leaves out the reference on a row that has not been stamped yet', () => {
    mocks.venue = {
      data: [{ ...rows[0]!, internal_ref: '' }],
      isLoading: false,
      isError: false,
    };
    open();
    expect(screen.getByText(/BF-9001/)).toBeInTheDocument();
    expect(screen.queryByText(/GMP-260903-01/)).not.toBeInTheDocument();
  });
});

/* -------------------------------------------------------------------------- */

describe('the gate', () => {
  function gate(children: React.ReactNode) {
    return render(<VenueGate>{children}</VenueGate>);
  }

  it('sends a venue away from a screen built for the four', async () => {
    mocks.pathname = '/b/mjr';
    gate(<p>dashboard</p>);
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/venue'));
    expect(screen.queryByText('dashboard')).not.toBeInTheDocument();
  });

  it('leaves a venue alone on its own screen and in settings', () => {
    for (const path of ['/venue', '/settings']) {
      mocks.pathname = path;
      const { unmount } = gate(<p>{path}</p>);
      expect(screen.getByText(path)).toBeInTheDocument();
      expect(mocks.replace).not.toHaveBeenCalled();
      unmount();
    }
  });

  it('does not touch one of the four', () => {
    mocks.profile = PROFILES[0];
    mocks.pathname = '/b/mjr';
    gate(<p>dashboard</p>);
    expect(screen.getByText('dashboard')).toBeInTheDocument();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  /**
   * An allowlist, not a blocklist — the same shape CATCH_UP_010 §6 put into
   * `push_targets`. A route added in a later phase must be unreachable by
   * default rather than reachable until somebody remembers it.
   */
  it('keeps a venue out of a route that did not exist when it was written', async () => {
    mocks.pathname = '/reports/quarterly';
    gate(<p>a later phase</p>);
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/venue'));
  });
});

/* -------------------------------------------------------------------------- */

describe('grouping', () => {
  it('puts an invoice in the month on the docket, not the month it was typed', () => {
    const late = {
      ...rows[2]!,
      id: 'v-late',
      invoice_date: '2026-08-30',
      created_at: '2026-09-02T09:00:00.000Z',
    };
    const months = byMonth([late]);
    expect(months).toHaveLength(1);
    expect(months[0]!.key).toBe('2026-08');
  });

  /**
   * A shop logs a delivery run in one sitting — several invoices, one date.
   * Without the created_at tiebreak their order is whatever the array happened
   * to hold, which differs between a refetch and an optimistic insert. A list
   * that reshuffles under somebody checking it against a pile of paper is the
   * §23 class of bug: the data is right and the screen is unusable.
   */
  it('is stable when several invoices share a date', () => {
    const sameDay = [
      { ...rows[0]!, id: 'a', created_at: '2026-09-03T09:00:00.000Z' },
      { ...rows[0]!, id: 'b', created_at: '2026-09-03T11:00:00.000Z' },
      { ...rows[0]!, id: 'c', created_at: '2026-09-03T10:00:00.000Z' },
    ];
    const forwards = byMonth(sameDay)[0]!.invoices.map((r) => r.id);
    const backwards = byMonth([...sameDay].reverse())[0]!.invoices.map((r) => r.id);
    expect(forwards).toEqual(['b', 'c', 'a']);
    expect(backwards).toEqual(forwards);
  });

  it('does not mutate what it was given', () => {
    const input = [...rows];
    const snapshot = input.map((r) => r.id);
    byMonth(input);
    expect(input.map((r) => r.id)).toEqual(snapshot);
  });
});

/* -------------------------------------------------------------------------- */

describe('adding an invoice', () => {
  async function openSheet() {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Add invoice' }));
    await screen.findByText('New invoice');
  }

  /**
   * The database refuses any other venue anyway — `with check (business_id =
   * staff_venue())`. Offering the choice would be the interface promising
   * something the insert would then reject.
   */
  it('offers no business to choose, because a shop has one', async () => {
    await openSheet();
    for (const code of ['GMH', 'MJR', 'DDL']) {
      expect(screen.queryByRole('button', { name: code })).not.toBeInTheDocument();
    }
  });

  it('writes the invoice against the venue on the profile, not a picker', async () => {
    mocks.createInvoice.mockResolvedValue(undefined);
    mocks.findDuplicates.mockResolvedValue([]);
    await openSheet();

    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '412.90' } });
    pickSupplier('Bidfood');
    fireEvent.click(screen.getByRole('button', { name: 'Save invoice' }));

    await waitFor(() => expect(mocks.createInvoice).toHaveBeenCalled());
    const input = mocks.createInvoice.mock.calls[0]![0] as {
      payload: { business_id: string; amount_cents: number };
      supplierName: string;
    };
    expect(input.payload.business_id).toBe('b-gmp');
    expect(input.payload.amount_cents).toBe(41290);
    // Carried in the variables, not a closure — a resumed write has no
    // component alive to look a supplier name up (HANDOFF §2 rule 4).
    expect(input.supplierName).toBeTruthy();
  });

  /**
   * Spec §6, and it matters more here than anywhere else in the app: one login
   * is shared across shifts, so the person entering cannot see what the last
   * one did and has no activity feed to check.
   */
  it('warns about a duplicate through the staff lookup, never the members’ one', async () => {
    mocks.findDuplicates.mockResolvedValue([
      {
        id: 'dupe',
        invoice_number: 'BF-9001',
        invoice_date: '2026-09-03',
        amount_cents: 522000,
        supplier_name: 'Bidfood',
      },
    ]);
    await openSheet();

    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '5220' } });
    fireEvent.change(screen.getByLabelText('Invoice number'), { target: { value: 'BF-9001' } });
    pickSupplier('Bidfood');
    fireEvent.click(screen.getByRole('button', { name: 'Save invoice' }));

    expect(await screen.findByText(/already logged/)).toBeInTheDocument();
    expect(mocks.findDuplicates).toHaveBeenCalled();
    // Nothing written until the person says so — a warning, never a block.
    expect(mocks.createInvoice).not.toHaveBeenCalled();
  });
});


/* -------------------------------------------------------------------------- */

describe('the five-minute correction window', () => {
  const at = (ms: number) => new Date(ms).toISOString();

  /**
   * The rule is a CLOCK, not "while it is unpaid", and that is the whole point.
   *
   * "Editable until it is paid" would tell a shop the payment status from
   * whether the edit was refused — the rule deciding what you may do would be
   * the fact you are not allowed to know. Five minutes after entry is five
   * minutes after entry, and it says nothing about money.
   */
  it('is measured from when it was entered and nothing else', () => {
    const now = 1_800_000_000_000;
    const fresh = { ...rows[0]!, created_at: at(now - 60_000) };
    const stale = { ...rows[0]!, created_at: at(now - VENUE_EDIT_WINDOW_MS - 1) };
    expect(stillCorrectable(fresh, now)).toBe(true);
    expect(stillCorrectable(stale, now)).toBe(false);
  });

  /**
   * A row claiming to be from the future is a wrong phone clock, or an
   * optimistic row written a moment before this render. Generous is the right
   * direction to fail: the cost is one refused save with a sentence.
   */
  it('treats a row from the future as brand new rather than expired', () => {
    const now = 1_800_000_000_000;
    const ahead = { ...rows[0]!, created_at: at(now + 30_000) };
    expect(stillCorrectable(ahead, now)).toBe(true);
  });

  it('offers Edit on a fresh row and not on an old one', async () => {
    mocks.venue = {
      data: [
        { ...rows[0]!, id: 'fresh', created_at: new Date(Date.now() - 30_000).toISOString() },
        { ...rows[1]!, id: 'old', created_at: '2026-09-02T09:00:00.000Z' },
      ],
      isLoading: false,
      isError: false,
    };
    open();
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /^Correct / })).toHaveLength(1),
    );
  });

  it('sends only the changed invoice, by id, without touching created_at', async () => {
    mocks.updateInvoice.mockResolvedValue(undefined);
    mocks.findDuplicates.mockResolvedValue([]);
    mocks.venue = {
      data: [{ ...rows[0]!, id: 'fresh', created_at: new Date(Date.now() - 30_000).toISOString() }],
      isLoading: false,
      isError: false,
    };
    open();

    fireEvent.click(await screen.findByRole('button', { name: /^Correct / }));
    await screen.findByText('Correct invoice');

    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '99.95' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));

    await waitFor(() => expect(mocks.updateInvoice).toHaveBeenCalled());
    const input = mocks.updateInvoice.mock.calls[0]![0] as {
      id: string;
      payload: Record<string, unknown>;
    };
    expect(input.id).toBe('fresh');
    expect(input.payload.amount_cents).toBe(9995);
    // created_at is what the window is measured from, and the database pins it
    // on update anyway (`pin_invoice_facts`). Sending it would be a lie either
    // way — and `created_by` must stay the venue, so neither is in the payload.
    expect(input.payload).not.toHaveProperty('created_at');
    expect(input.payload).not.toHaveProperty('created_by');
    expect(input.payload).not.toHaveProperty('id');
    // And nothing was added.
    expect(mocks.createInvoice).not.toHaveBeenCalled();
  });

  it('opens pre-filled with what is already on the invoice', async () => {
    mocks.venue = {
      data: [{ ...rows[0]!, id: 'fresh', created_at: new Date(Date.now() - 30_000).toISOString() }],
      isLoading: false,
      isError: false,
    };
    open();
    fireEvent.click(await screen.findByRole('button', { name: /^Correct / }));
    await screen.findByText('Correct invoice');

    expect(screen.getByLabelText('Amount')).toHaveValue('5220.00');
    expect(screen.getByLabelText('Invoice number')).toHaveValue('BF-9001');
  });

  /**
   * The invoice being corrected is itself a match for its own number, so
   * without excluding it every correction would warn that it duplicates
   * itself — and a warning that always fires is one nobody reads.
   */
  it('does not warn that an invoice duplicates itself', async () => {
    mocks.updateInvoice.mockResolvedValue(undefined);
    mocks.findDuplicates.mockResolvedValue([
      {
        id: 'fresh',
        invoice_number: 'BF-9001',
        invoice_date: '2026-09-03',
        amount_cents: 522000,
        supplier_name: 'Bidfood',
      },
    ]);
    mocks.venue = {
      data: [{ ...rows[0]!, id: 'fresh', created_at: new Date(Date.now() - 30_000).toISOString() }],
      isLoading: false,
      isError: false,
    };
    open();
    fireEvent.click(await screen.findByRole('button', { name: /^Correct / }));
    await screen.findByText('Correct invoice');
    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));

    await waitFor(() => expect(mocks.updateInvoice).toHaveBeenCalled());
    expect(screen.queryByText(/already logged/)).not.toBeInTheDocument();
  });

  /**
   * A queued correction can still be refused: the window is measured by the
   * database against `created_at`, so an edit made in a dead spot and sent
   * twenty minutes later will not apply. Saying "saved" would be the one thing
   * this app never does.
   */
  it('does not promise a queued correction will apply', async () => {
    const { onlineManager: om } = await import('@tanstack/react-query');
    om.setOnline(false);
    mocks.venue = {
      data: [{ ...rows[0]!, id: 'fresh', created_at: new Date(Date.now() - 30_000).toISOString() }],
      isLoading: false,
      isError: false,
    };
    open();
    fireEvent.click(await screen.findByRole('button', { name: /^Correct / }));
    await screen.findByText('Correct invoice');
    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));

    expect(await screen.findByText(/will send when you’re back online/)).toBeInTheDocument();
    om.setOnline(true);
  });
});
