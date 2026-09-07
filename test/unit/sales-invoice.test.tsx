import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '@/components/ui/Toast';
import { BUSINESSES, FIXTURE_TODAY, PROFILES } from '../fixtures/invoices';
import { formatCents } from '@/lib/money';
import { addDays } from '@/lib/date';
import { DEFAULT_TERMS_DAYS } from '@/lib/constants';
import { lineTotalCents, parseQuantityToMilli } from '@/lib/quantity';
import type { Business, Customer, Product, SalesInvoiceLine, SalesInvoiceRow } from '@/lib/types';

/**
 * Deli composes an invoice, and prints it.
 *
 * ---------------------------------------------------------------------------
 * What these are actually guarding
 *
 * A number that goes on a piece of paper handed to a customer. Everywhere else
 * in this app a wrong figure is a wrong screen somebody can refresh; here it is
 * a document in somebody else's hands that disagrees with your copy.
 *
 * So: the running total is the sum of the lines rendered beside it, the payload
 * sent is exactly what was typed, the price is COPIED off the product rather
 * than linked to it, and the document prints itself rather than being rebuilt
 * into a second hidden copy that could drift.
 * ---------------------------------------------------------------------------
 */

const deli = BUSINESSES.find((b) => b.code === 'DDL')!;

const CUSTOMERS: Customer[] = [
  {
    id: 'c-1',
    name: 'Harris Farm Markets',
    contact_name: 'Jo',
    contact_phone: '02 9000 0000',
    contact_email: 'jo@example.com',
    notes: null,
    active: true,
  },
];

const PRODUCTS: Product[] = [
  { id: 'p-1', business_id: deli.id, name: 'Momo (pork)', unit: 'box', unit_price_cents: 2_500, active: true },
  { id: 'p-2', business_id: deli.id, name: 'Achar', unit: 'jar', unit_price_cents: 899, active: true },
];

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  createCustomer: vi.fn(),
  /*
   * The businesses as a knob, because what is printed on an invoice now lives
   * on the business row and the interesting cases are the empty ones. Deli has
   * an address and no bank details in real life; three of the four have
   * neither. A fixed array can only ever render the filled-in case.
   */
  businesses: { current: [] as Business[] },
  /*
   * The customer list as a knob, because adding one has to change it.
   *
   * A fixed array would let the screen create a customer and then show a
   * picker that has never heard of them -- which is not what the real screen
   * does: `optimisticCustomer` puts the row in the cache the picker reads
   * before the write has left the phone. Pointing this at a mutable array is
   * how a test can stand over that.
   */
  customers: { current: [] as Customer[] },
  push: vi.fn(),
  detail: { current: null as unknown },
  /* Named, because "the price list was NOT touched" is an assertion. */
  updateProduct: vi.fn(),
  createProduct: vi.fn(),
  /*
   * Today, as a knob.
   *
   * `useSydneyToday` genuinely returns NULL on the first render -- the server
   * cannot know the phone's date, so it arrives one frame later. Mocking it to
   * a fixed date, as this file used to, makes the first render every real
   * phone performs the one state no test can reach. That is exactly where the
   * screen was throwing.
   */
  today: { current: null as string | null },
}));

vi.mock('@/lib/queries/session', () => ({
  useCurrentProfile: () => ({ data: PROFILES[0], isLoading: false, isError: false }),
  useProfiles: () => ({ data: PROFILES }),
  useTeam: () => ({ data: PROFILES }),
  useSignOut: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateNotifyPreference: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateReminderTime: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/lib/queries/reference', () => ({
  useBusinesses: () => ({ data: mocks.businesses.current }),
  useSuppliers: () => ({ data: [] }),
  useCreateSupplier: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/lib/queries/customers', () => ({
  useCustomers: () => ({ data: mocks.customers.current }),
  useAllCustomers: () => ({ data: mocks.customers.current, isLoading: false, isError: false }),
  useCreateCustomer: () => ({
    mutate: mocks.createCustomer,
    mutateAsync: mocks.createCustomer,
    isPending: false,
  }),
  optimisticCustomer: (id: string, name: string) => ({
    id,
    name,
    contact_name: null,
    contact_phone: null,
    contact_email: null,
    notes: null,
    active: true,
  }),
  useUpdateCustomer: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/lib/queries/products', () => ({
  useProducts: () => ({ data: PRODUCTS, isLoading: false }),
  useAllProducts: () => ({ data: PRODUCTS, isLoading: false }),
  useCreateProduct: () => ({
    mutate: mocks.createProduct,
    mutateAsync: mocks.createProduct,
    isPending: false,
  }),
  useUpdateProduct: () => ({
    mutate: mocks.updateProduct,
    mutateAsync: mocks.updateProduct,
    isPending: false,
  }),
}));

vi.mock('@/lib/queries/sales', () => ({
  useCreateSalesInvoice: () => ({ mutateAsync: mocks.create, mutate: mocks.create, isPending: false }),
  useSalesInvoice: () => ({ data: mocks.detail.current, isLoading: false, isError: false }),
  useOutstandingSales: () => ({ data: [] }),
  useCustomerSales: () => ({ data: [] }),
  useMarkReceived: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUnmarkReceived: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/lib/queries/detail', () => ({
  useRecentActivity: () => ({ data: [] }),
  useInvoice: () => ({ data: null, isLoading: false }),
  useInvoiceActivity: () => ({ data: [] }),
  useInvoiceNotes: () => ({ data: [] }),
  useAddNote: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/lib/queries/review', () => ({
  useAwaitingReview: () => ({ data: [], isLoading: false }),
  useReviewNotes: () => ({ data: {} }),
  useApproveInvoices: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useReassignSupplier: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/lib/queries/invoices', () => ({
  useUnpaidInvoices: () => ({ data: [], isLoading: false }),
  useCreateInvoice: () => ({ mutateAsync: vi.fn(), isPending: false }),
  findDuplicates: vi.fn(),
}));

vi.mock('@/lib/queries/payments', () => ({
  useMarkPaid: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUnmarkPaid: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useVoidInvoice: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/use-sydney-today', () => ({ useSydneyToday: () => mocks.today.current }));

vi.mock('next/navigation', () => ({
  usePathname: () => '/sales/new',
  useRouter: () => ({ push: mocks.push, replace: vi.fn() }),
}));

const { ComposeSalesInvoice } = await import('@/components/screens/ComposeSalesInvoice');
const { SalesInvoiceDocument } = await import('@/components/screens/SalesInvoiceDocument');

function compose() {
  return render(
    <ToastProvider>
      <ComposeSalesInvoice />
    </ToastProvider>,
  );
}

function document_(id = 'si-1') {
  return render(
    <ToastProvider>
      <SalesInvoiceDocument id={id} />
    </ToastProvider>,
  );
}

/** The sticky footer figure. */
function runningTotal(): string {
  const footer = window.document.querySelector('.fixed.inset-x-0.bottom-0')!;
  return within(footer as HTMLElement).getByText(/^\$/).textContent!;
}

function fillLine(index: number, description: string, quantity: string, price: string) {
  fireEvent.change(screen.getByLabelText(`Description for line ${index}`), {
    target: { value: description },
  });
  fireEvent.change(screen.getByLabelText(`Quantity for line ${index}`), {
    target: { value: quantity },
  });
  fireEvent.change(screen.getByLabelText(`Price for line ${index}`), { target: { value: price } });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.create.mockResolvedValue({ id: 'si-1', invoice_number: 'DDL-0001' });
  mocks.detail.current = null;
  mocks.today.current = FIXTURE_TODAY;
  mocks.customers.current = [...CUSTOMERS];
  mocks.businesses.current = BUSINESSES;
  /* What the real mutation does: the row is in the list before the write
     lands, so the picker can point at it. */
  mocks.createCustomer.mockImplementation(async ({ id, name }: { id: string; name: string }) => {
    mocks.customers.current = [
      ...mocks.customers.current,
      {
        id,
        name,
        contact_name: null,
        contact_phone: null,
        contact_email: null,
        notes: null,
        active: true,
      },
    ];
  });
});

describe('the first render, before the date arrives', () => {
  /*
   * ==========================================================================
   * The bug that shipped, and the only test that could have caught it.
   *
   * `useSydneyToday` returns null on the first render by design. The screen
   * folded that into `|| ''` and handed the empty string to `addDays`, which
   * asserts 'YYYY-MM-DD' and throws -- so the compose screen died before
   * painting a pixel and the client saw "This screen didn't load", every time,
   * by every route in.
   *
   * It passed every assertion in this file because this file mocked the date
   * as always-present. A fixture that cannot produce the real first render is
   * a fixture that guarantees this class of bug.
   * ==========================================================================
   */
  it('renders rather than throwing', () => {
    mocks.today.current = null;
    expect(() => compose()).not.toThrow();
    expect(screen.getByRole('heading', { name: 'New invoice' })).toBeInTheDocument();
  });

  it('shows the product list and its steppers while the date is still unknown', () => {
    // The crash was in the due-date presets, above the list. Everything below
    // it was never reached.
    mocks.today.current = null;
    compose();
    expect(screen.getByRole('button', { name: 'One more Momo (pork)' })).toBeInTheDocument();
    expect(screen.getByLabelText('Customer')).toBeInTheDocument();
  });

  it('leaves the date empty rather than inventing one', () => {
    mocks.today.current = null;
    compose();
    expect((screen.getByLabelText('Invoice date') as HTMLInputElement).value).toBe('');
  });

  it('fills it in once it arrives', () => {
    compose();
    expect((screen.getByLabelText('Invoice date') as HTMLInputElement).value).toBe(FIXTURE_TODAY);
  });
});

describe('adding a customer without leaving the invoice', () => {
  /*
   * ==========================================================================
   * Reported, and mine: *"no way to add a customer while composing"*.
   *
   * The old flat sheet has an inline field. This screen never got one, so a
   * new customer standing at the counter meant abandoning a half-built
   * invoice, going to Customers, and starting the lines again. Which is not a
   * missing feature so much as a dead end put in the middle of the one flow
   * this screen exists for.
   * ==========================================================================
   */
  it('offers it even when there are customers already', () => {
    // Not only on an empty list, which is the flat sheet's rule and the wrong
    // one here: the case reported had a customer list and needed one more.
    compose();
    expect(screen.getByRole('button', { name: '+ Add a new customer' })).toBeInTheDocument();
  });

  it('creates one and points the picker at it', async () => {
    compose();
    fireEvent.click(screen.getByRole('button', { name: '+ Add a new customer' }));
    fireEvent.change(screen.getByLabelText('New customer name'), {
      target: { value: 'Bourke St Bakery' },
    });
    fireEvent.click(screen.getByRole('button', { name: '+ Add' }));

    await waitFor(() => expect(mocks.createCustomer).toHaveBeenCalled());
    const created = mocks.createCustomer.mock.calls[0]![0];
    expect(created.name).toBe('Bourke St Bakery');

    // The whole point: you carry on from here, already pointed at them.
    await waitFor(() =>
      expect((screen.getByLabelText('Customer') as HTMLSelectElement).value).toBe(created.id),
    );
  });

  it('saves the invoice against the customer it just made', async () => {
    compose();
    fireEvent.click(screen.getByRole('button', { name: '+ Add a new customer' }));
    fireEvent.change(screen.getByLabelText('New customer name'), {
      target: { value: 'Bourke St Bakery' },
    });
    fireEvent.click(screen.getByRole('button', { name: '+ Add' }));
    await waitFor(() => expect(mocks.createCustomer).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: 'One more Momo (pork)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save & print' }));

    await waitFor(() => expect(mocks.create).toHaveBeenCalled());
    expect(mocks.create.mock.calls[0]![0].customer_id).toBe(
      mocks.createCustomer.mock.calls[0]![0].id,
    );
  });

  it('generates the id on the client, so a replayed write is the same customer', async () => {
    // Notes §1.5. Offline, this write is resumed from a cold start by key; an
    // id decided by the database would make the second attempt a second row.
    compose();
    fireEvent.click(screen.getByRole('button', { name: '+ Add a new customer' }));
    fireEvent.change(screen.getByLabelText('New customer name'), {
      target: { value: 'Bourke St Bakery' },
    });
    fireEvent.click(screen.getByRole('button', { name: '+ Add' }));

    await waitFor(() => expect(mocks.createCustomer).toHaveBeenCalled());
    expect(mocks.createCustomer.mock.calls[0]![0].id).toEqual(expect.any(String));
  });

  it('will not send a blank name', () => {
    compose();
    fireEvent.click(screen.getByRole('button', { name: '+ Add a new customer' }));
    fireEvent.change(screen.getByLabelText('New customer name'), { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: '+ Add' })).toBeDisabled();
  });
});

describe('the due date switch', () => {
  /*
   * ==========================================================================
   * Off by default, and the default is the feature.
   *
   * *"we don't want to issue due dates yet."* Deli invoices before it has
   * agreed terms with anybody, so a due date filled in for it would print a
   * deadline nobody set AND drive every overdue figure off a date that means
   * nothing. Recorded as an absence, not hidden (CATCH_UP_017).
   * ==========================================================================
   */
  it('starts off, with no due date field at all', () => {
    compose();
    expect(screen.getByRole('switch', { name: /due date/i })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(screen.queryByLabelText('Due date')).not.toBeInTheDocument();
  });

  it('sends null for the due date while it is off', async () => {
    compose();
    fireEvent.change(screen.getByLabelText('Customer'), { target: { value: 'c-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'One more Momo (pork)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save & print' }));

    await waitFor(() => expect(mocks.create).toHaveBeenCalled());
    expect(mocks.create.mock.calls[0]![0].due_date).toBeNull();
    // The invoice date is still sent. Only the deadline is unstated.
    expect(mocks.create.mock.calls[0]![0].invoice_date).toBe(FIXTURE_TODAY);
  });

  it('turning it on defaults to the usual terms, and sends that', async () => {
    compose();
    fireEvent.change(screen.getByLabelText('Customer'), { target: { value: 'c-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'One more Momo (pork)' }));
    fireEvent.click(screen.getByRole('switch', { name: /due date/i }));

    const expected = addDays(FIXTURE_TODAY, DEFAULT_TERMS_DAYS);
    expect((screen.getByLabelText('Due date') as HTMLInputElement).value).toBe(expected);

    fireEvent.click(screen.getByRole('button', { name: 'Save & print' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalled());
    expect(mocks.create.mock.calls[0]![0].due_date).toBe(expected);
  });

  it('turning it back off drops the date rather than keeping it hidden', async () => {
    // The failure this guards against is a stored date the screen has stopped
    // showing: the document would print without it and every overdue figure
    // would still be driven by it.
    compose();
    fireEvent.change(screen.getByLabelText('Customer'), { target: { value: 'c-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'One more Momo (pork)' }));
    fireEvent.click(screen.getByRole('switch', { name: /due date/i }));
    fireEvent.change(screen.getByLabelText('Due date'), { target: { value: '2026-12-01' } });
    fireEvent.click(screen.getByRole('switch', { name: /due date/i }));

    fireEvent.click(screen.getByRole('button', { name: 'Save & print' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalled());
    expect(mocks.create.mock.calls[0]![0].due_date).toBeNull();
  });

  it('does not offer a second + on top of Save & print', () => {
    // A floating button offering to start another invoice, sitting on the
    // button that finishes this one. Reported with a photograph.
    compose();
    expect(screen.queryByRole('button', { name: 'Add invoice' })).not.toBeInTheDocument();
  });

  it('falls back to today when the date field is cleared, and still saves', async () => {
    /*
     * A date input hands back '' when it is emptied, and '' is what threw.
     * Now it is null, and null falls through to today -- an invoice always has
     * a date, so reverting to today beats both a dateless row and a dead
     * screen. Asserted because the guard in `save()` must never be the thing
     * somebody meets by clearing a field.
     */
    compose();
    fireEvent.change(screen.getByLabelText('Customer'), { target: { value: 'c-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'One more Momo (pork)' }));
    fireEvent.change(screen.getByLabelText('Invoice date'), { target: { value: '' } });

    expect((screen.getByLabelText('Invoice date') as HTMLInputElement).value).toBe(FIXTURE_TODAY);

    fireEvent.click(screen.getByRole('button', { name: 'Save & print' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalled());
    expect(mocks.create.mock.calls[0]![0].invoice_date).toBe(FIXTURE_TODAY);
  });
});

describe('the running total', () => {
  it('is the sum of the lines beside it', () => {
    compose();
    fillLine(1, 'Momo (pork)', '3', '25.00');
    expect(runningTotal()).toBe(formatCents(7_500));

    fireEvent.click(screen.getByRole('button', { name: '+ Add another line' }));
    fillLine(2, 'Achar', '2', '8.99');
    expect(runningTotal()).toBe(formatCents(7_500 + 1_798));
  });

  it('agrees with lineTotalCents on a fractional quantity', () => {
    compose();
    fillLine(1, 'Sausage', '1.5', '12.40');
    const expected = lineTotalCents(parseQuantityToMilli('1.5')!, 1_240)!;
    expect(runningTotal()).toBe(formatCents(expected));
  });

  it('ignores a half-typed line rather than counting it as nothing', () => {
    // A row somebody is still working on is not a line worth zero. Counting it
    // would make the total flicker downward as they type.
    compose();
    fillLine(1, 'Momo (pork)', '3', '25.00');
    fireEvent.click(screen.getByRole('button', { name: '+ Add another line' }));
    fireEvent.change(screen.getByLabelText('Description for line 2'), { target: { value: 'Ach' } });

    expect(runningTotal()).toBe(formatCents(7_500));
    // Split across text nodes by the plural, so read the footer itself.
    const footer = window.document.querySelector('.fixed.inset-x-0.bottom-0')!;
    expect(footer.textContent).toContain('1 line');
  });

  it('is zero, not NaN, before anything is typed', () => {
    compose();
    expect(runningTotal()).toBe(formatCents(0));
  });
});

describe('the product list', () => {
  /*
   * The body of the compose screen, and the thing that was reported broken.
   *
   * Quantity is the ONLY state a row has: a product with a quantity is on the
   * invoice, a product on zero is not. These tests are written against that
   * single fact deliberately, because the version before this one carried a
   * separate row-exists flag and a quantity that could disagree with it.
   */
  it('puts a product on the invoice with one tap, and takes it off again', () => {
    compose();
    expect(runningTotal()).toBe(formatCents(0));

    fireEvent.click(screen.getByRole('button', { name: 'One more Momo (pork)' }));
    expect(runningTotal()).toBe(formatCents(2_500));
    expect((screen.getByLabelText('Quantity of Momo (pork)') as HTMLInputElement).value).toBe('1');

    fireEvent.click(screen.getByRole('button', { name: 'One more Momo (pork)' }));
    expect(runningTotal()).toBe(formatCents(5_000));

    fireEvent.click(screen.getByRole('button', { name: 'Take Momo (pork) off this invoice' }));
    expect(runningTotal()).toBe(formatCents(0));
  });

  it('steps a fractional quantity without drifting', () => {
    // The reason lib/quantity.ts exists. Stepping the string would give
    // 2.5000000000000004 and a line that does not add up on paper.
    compose();
    fireEvent.change(screen.getByLabelText('Quantity of Momo (pork)'), {
      target: { value: '1.5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'One more Momo (pork)' }));

    expect((screen.getByLabelText('Quantity of Momo (pork)') as HTMLInputElement).value).toBe(
      '2.5',
    );
    expect(runningTotal()).toBe(formatCents(lineTotalCents(2_500, 2_500)!));
  });

  it('will not go below nothing', () => {
    // A line sitting at zero would print as a row charging nothing, so
    // stepping down through zero takes the row off rather than parking it.
    compose();
    fireEvent.click(screen.getByRole('button', { name: 'One more Achar' }));
    fireEvent.click(screen.getByRole('button', { name: 'One less Achar' }));

    expect(runningTotal()).toBe(formatCents(0));
    expect((screen.getByLabelText('Quantity of Achar') as HTMLInputElement).value).toBe('0');
    expect(
      screen.queryByRole('button', { name: 'Take Achar off this invoice' }),
    ).not.toBeInTheDocument();
  });

  it('sends the copied price, not a reference to the product', async () => {
    /*
     * The whole design of the line table. A price looked up at print time
     * means an invoice already handed over reprints at next month's price —
     * a piece of paper that stops agreeing with your copy of it.
     */
    compose();
    fireEvent.change(screen.getByLabelText('Customer'), { target: { value: 'c-1' } });
    fireEvent.change(screen.getByLabelText('Quantity of Momo (pork)'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save & print' }));

    await waitFor(() => expect(mocks.create).toHaveBeenCalled());
    const input = mocks.create.mock.calls[0]![0];
    expect(input.lines).toHaveLength(1);
    expect(input.lines[0]).toMatchObject({
      product_id: 'p-1',
      description: 'Momo (pork)',
      unit: 'box',
      quantity_milli: 2_000,
      unit_price_cents: 2_500,
    });
  });

  it('charges the price typed on the line, and leaves the price list alone', async () => {
    /*
     * The pencil opens two prices that reach different distances. This one is
     * "on this invoice" and must not touch the list — a price list quietly
     * rewritten by somebody fixing one docket is the kind of thing nobody
     * notices for a month.
     */
    compose();
    fireEvent.change(screen.getByLabelText('Customer'), { target: { value: 'c-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'One more Momo (pork)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit Momo (pork)' }));
    fireEvent.change(screen.getByLabelText('Price of Momo (pork) on this invoice'), {
      target: { value: '20.00' },
    });

    expect(runningTotal()).toBe(formatCents(2_000));
    fireEvent.click(screen.getByRole('button', { name: 'Save & print' }));

    await waitFor(() => expect(mocks.create).toHaveBeenCalled());
    expect(mocks.create.mock.calls[0]![0].lines[0].unit_price_cents).toBe(2_000);
    expect(mocks.updateProduct).not.toHaveBeenCalled();
  });

  it('carries a customer chosen before the screen opened', () => {
    // "New invoice for THIS customer" has to actually be for that customer.
    render(
      <ToastProvider>
        <ComposeSalesInvoice customerId="c-1" />
      </ToastProvider>,
    );
    expect((screen.getByLabelText('Customer') as HTMLSelectElement).value).toBe('c-1');
  });
});

describe('saving', () => {
  it('refuses without a customer, and writes nothing', async () => {
    compose();
    fillLine(1, 'Momo', '1', '25.00');
    fireEvent.click(screen.getByRole('button', { name: 'Save & print' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/who this invoice is for/);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('refuses with no complete line, and writes nothing', async () => {
    compose();
    fireEvent.change(screen.getByLabelText('Customer'), { target: { value: 'c-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save & print' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/at least one line/);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('lets the database number it', async () => {
    compose();
    fireEvent.change(screen.getByLabelText('Customer'), { target: { value: 'c-1' } });
    fillLine(1, 'Momo', '1', '25.00');
    fireEvent.click(screen.getByRole('button', { name: 'Save & print' }));

    await waitFor(() => expect(mocks.create).toHaveBeenCalled());
    // Null, so `set_sales_invoice_number` stamps DDL-0001 race-free. A number
    // invented here is a number two people composing at once could both pick.
    expect(mocks.create.mock.calls[0]![0].invoice_number).toBeNull();
  });

  it('goes to the document once it has one', async () => {
    compose();
    fireEvent.change(screen.getByLabelText('Customer'), { target: { value: 'c-1' } });
    fillLine(1, 'Momo', '1', '25.00');
    fireEvent.click(screen.getByRole('button', { name: 'Save & print' }));

    await waitFor(() => expect(mocks.push).toHaveBeenCalled());
    expect(mocks.push.mock.calls[0]![0]).toMatch(/\/sales\/.+\/print$/);
  });
});

describe('the printed document', () => {
  const LINES: SalesInvoiceLine[] = [
    {
      id: 'l-1',
      sales_invoice_id: 'si-1',
      position: 0,
      product_id: 'p-1',
      description: 'Momo (pork)',
      unit: 'box',
      quantity_milli: 3_000,
      unit_price_cents: 2_500,
      line_total_cents: 7_500,
    },
    {
      id: 'l-2',
      sales_invoice_id: 'si-1',
      position: 1,
      product_id: 'p-2',
      description: 'Achar',
      unit: 'jar',
      quantity_milli: 1_500,
      unit_price_cents: 899,
      line_total_cents: 1_349,
    },
  ];

  const INVOICE: SalesInvoiceRow = {
    id: 'si-1',
    business_id: deli.id,
    customer_id: 'c-1',
    invoice_number: 'DDL-0001',
    invoice_date: '2026-09-05',
    due_date: '2026-09-19',
    amount_cents: 8_849,
    status: 'outstanding',
    received_at: null,
    received_by: null,
    payment_ref: null,
    void_reason: null,
    note: null,
    created_by: PROFILES[0]!.id,
    created_at: '2026-09-05T00:00:00Z',
    updated_at: '2026-09-05T00:00:00Z',
    customer: { id: 'c-1', name: 'Harris Farm Markets' },
  };

  beforeEach(() => {
    mocks.detail.current = { invoice: INVOICE, lines: LINES };
  });

  it('shows every line, in the order the database stored them', () => {
    document_();
    const rows = window.document.querySelectorAll('.print-sheet tbody tr');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('Momo (pork)');
    expect(rows[1]!.textContent).toContain('Achar');
  });

  it('shows a quantity as a quantity, not padded like money', () => {
    document_();
    // "1.5 jar", never "1.500". Money always shows two places; a quantity
    // shows what it is, or it claims a precision the docket did not.
    expect(screen.getByText('1.5 jar')).toBeInTheDocument();
    expect(screen.getByText('3 box')).toBeInTheDocument();
  });

  it('totals what the lines add up to', () => {
    document_();
    const sheet = within(window.document.querySelector('.print-sheet') as HTMLElement);
    expect(sheet.getByText(formatCents(7_500 + 1_349))).toBeInTheDocument();
    expect(INVOICE.amount_cents).toBe(7_500 + 1_349);
  });

  it('carries the number, both dates and who it is for', () => {
    document_();
    const sheet = within(window.document.querySelector('.print-sheet') as HTMLElement);
    expect(sheet.getByText('DDL-0001')).toBeInTheDocument();
    expect(sheet.getByText('Harris Farm Markets')).toBeInTheDocument();
    expect(sheet.getByText(/5 Sep 2026/)).toBeInTheDocument();
    expect(sheet.getByText(/19 Sep 2026/)).toBeInTheDocument();
  });

  it('is one document, not a screen copy and a print copy', () => {
    // Two copies of one invoice in a file drift, and the one that drifts is
    // the one nobody looks at on screen. There is exactly one .print-sheet.
    document_();
    expect(window.document.querySelectorAll('.print-sheet')).toHaveLength(1);
  });

  it('marks the chrome as chrome so the stylesheet can take it away', () => {
    document_();
    const printButton = screen.getByRole('button', { name: 'Print' });
    expect(printButton.closest('.no-print')).not.toBeNull();
  });

  it('marks the app header too', () => {
    /*
     * Found in a browser and not by any assertion, because the rule only
     * exists on paper: the print stylesheet first targeted
     * `header[data-app-header]`, which matches nothing here, so the hamburger
     * and the icons printed across the top of every invoice.
     *
     * The class is on the element now rather than a selector guessing at it,
     * and this is what stops that quietly coming back.
     */
    document_();
    const header = window.document.querySelector('header');
    expect(header).not.toBeNull();
    expect(header!.className).toContain('no-print');
  });

  it('says so rather than printing an empty table for an invoice with no lines', () => {
    mocks.detail.current = { invoice: INVOICE, lines: [] };
    document_();
    expect(screen.getByText('Recorded without a breakdown')).toBeInTheDocument();
    expect(
      within(window.document.querySelector('.print-sheet') as HTMLElement).getAllByText(
        formatCents(INVOICE.amount_cents),
      ).length,
    ).toBeGreaterThan(0);
  });

  /* ---------------------------------------------------------------- *
     What J2 put on the paper. CATCH_UP_020, ARCHITECTURE §47.
   * ---------------------------------------------------------------- */

  it('prints who sent it, exactly as it was typed', () => {
    document_();
    const sheet = within(window.document.querySelector('.print-sheet') as HTMLElement);
    // One node holding all three lines, not three nodes: the column is free
    // text and `white-space: pre-line` is what renders it. Split into
    // paragraphs here, this test would pass while the document printed the
    // address as one run-on line.
    expect(sheet.getByText(/12 Marsden St/)).toHaveTextContent(
      /12 Marsden St.*9000 1234.*orders@delidelights/s,
    );
  });

  it('prints how to pay', () => {
    document_();
    const sheet = within(window.document.querySelector('.print-sheet') as HTMLElement);
    expect(sheet.getByText('Payment')).toBeInTheDocument();
    expect(sheet.getByText(/BSB 062-000/)).toBeInTheDocument();
  });

  it('leaves no empty heading behind when a business has set neither', () => {
    /*
     * CATCH_UP_017's rule, applied to two more blocks: a heading with nothing
     * under it reads as something that failed to load. Every business except
     * Deli is in exactly this state today, and will be until somebody types
     * something, so it is the state the feature ships in.
     */
    mocks.detail.current = {
      invoice: { ...INVOICE, business_id: 'b-gmh' },
      lines: LINES,
    };
    document_();
    const sheet = within(window.document.querySelector('.print-sheet') as HTMLElement);
    expect(sheet.queryByText('Payment')).not.toBeInTheDocument();
    expect(sheet.queryByText(/12 Marsden St/)).not.toBeInTheDocument();
    // The document still renders. An absent block is not an absent invoice.
    expect(sheet.getByText('DDL-0001')).toBeInTheDocument();
  });

  it('prints the contact block with no bank details under it', () => {
    /*
     * ==================================================================
     * The state the app is actually in, and the one nothing rendered.
     *
     * The client has Deli's address and does not have their bank details:
     * *"I won't add the banking details, cause I don't have it."* So the live
     * document has one block set and the other null -- and the two tests
     * either side of this one cover both-set and neither-set, which is the
     * §39.8 failure exactly: a fixture that cannot produce a real state
     * guarantees bugs in it. The compose screen threw on every open for a
     * whole round for this reason.
     *
     * Nothing clever is asserted. The point is that this arrangement renders
     * at all, and that the Payment heading does not survive its own contents
     * being absent.
     * ==================================================================
     */
    mocks.businesses.current = BUSINESSES.map((entry) =>
      entry.code === 'DDL' ? { ...entry, bank_details: null } : entry,
    );
    document_();
    const sheet = within(window.document.querySelector('.print-sheet') as HTMLElement);

    expect(sheet.getByText(/12 Marsden St/)).toBeInTheDocument();
    expect(sheet.queryByText('Payment')).not.toBeInTheDocument();
    // The pen still has somewhere to go: the signature block is not behind
    // the payment block, and somebody still signs for the delivery.
    expect(sheet.getAllByText('Signature').length).toBeGreaterThan(0);
  });

  it('leaves somewhere to put a pen', () => {
    document_();
    const sheet = within(window.document.querySelector('.print-sheet') as HTMLElement);
    for (const label of ['Received by', 'Signature', 'Date']) {
      expect(sheet.getAllByText(label).length).toBeGreaterThan(0);
    }
  });

  it('marks the ruled blocks so the print stylesheet can keep their lines', () => {
    /*
     * The structural half of a fact only paper can show. A browser drops
     * borders it decides are decoration, and on the signature block the line
     * IS the feature -- dropped, there is nothing there at all. jsdom does no
     * layout and cannot see that, so what is asserted is the hook the
     * stylesheet needs, and the browser check is the other half (HANDOFF §5).
     */
    document_();
    const sheet = window.document.querySelector('.print-sheet') as HTMLElement;
    expect(sheet.querySelectorAll('.print-rule').length).toBe(2);
  });

  it('reads the details live, so a reprint is never out of date', () => {
    /*
     * §47.1, and the one decision in J2 worth knowing about. ARCHITECTURE
     * §44.3 planned to freeze these onto each invoice the way a line price is
     * frozen. A price is a term that was agreed; a bank account is a routing
     * instruction, and a frozen one would hand somebody an unpaid invoice
     * naming an account that has closed.
     *
     * The structural proof is that nothing on the invoice carries them: if a
     * snapshot is ever added, this test is what will say so.
     */
    expect(Object.keys(INVOICE)).not.toContain('issuer');
    expect(Object.keys(INVOICE)).not.toContain('bank_details');
  });

  it('renders nothing broken — notes §6', () => {
    const { container } = document_();
    const text = container.textContent ?? '';
    for (const token of ['undefined', 'NaN', '[object Object]', 'Invalid Date']) {
      expect(text).not.toContain(token);
    }
  });
});
