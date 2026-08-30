import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { ToastProvider } from '@/components/ui/Toast';
import { BUSINESSES, FIXTURE_TODAY, PROFILES, SUPPLIERS, makeInvoices } from '../fixtures/invoices';
import { formatCents, sumCents } from '@/lib/money';
import { filterByScope } from '@/lib/scope';
import { bucketByUrgency, formatDueLabel } from '@/lib/derive/urgency';
import { summariseUrgency } from '@/lib/derive/select';
import { groupIntoRuns } from '@/lib/derive/runs';

/**
 * The dashboard, redesigned to the client's mockup. ARCHITECTURE §16 and §20.
 *
 * Its job is unchanged and the tests that matter are the same ones: the money
 * on this screen has to be the same money, counted once, as the screens it
 * leads to (notes §3). What changed is that the headline is now two figures
 * rather than one, so there is a new way for them to be wrong — overdue and
 * the next seven days can overlap, or between them lose an invoice. The first
 * block below is about exactly that.
 *
 * `today` is pinned to the fixture's own date. Left to the real clock these
 * assertions would drift as the fixture window aged, and a suite that starts
 * failing on a Tuesday is worse than no suite.
 */

const invoices = makeInvoices(40).map((invoice, i) => ({
  ...invoice,
  created_by: PROFILES[i % PROFILES.length]!.id,
}));

vi.mock('@/hooks/use-sydney-today', () => ({
  useSydneyToday: () => FIXTURE_TODAY,
}));

vi.mock('@/lib/queries/session', () => ({
  useCurrentProfile: () => ({ data: PROFILES[3], isLoading: false, isError: false }),
  useProfiles: () => ({ data: PROFILES }),
  useSignOut: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateNotifyPreference: () => ({ mutateAsync: vi.fn(), isPending: false }),
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

/*
 * The header bell reads recent activity, and marking paid is reachable from
 * every list, so both are stubbed here even where the test does not exercise
 * them. Without this the component tree reaches a real query and there is no
 * QueryClient in a bare render.
 */
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

vi.mock('next/navigation', () => ({ usePathname: () => '/' }));

const Dashboard = (await import('@/app/(app)/page')).default;

function open() {
  return render(
    <ToastProvider>
      <Dashboard />
    </ToastProvider>,
  );
}

const buckets = bucketByUrgency(invoices, FIXTURE_TODAY);
const expected = summariseUrgency(invoices, FIXTURE_TODAY);

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

describe('the two headline figures', () => {
  it('has something of each kind to show, or these tests prove nothing', () => {
    expect(buckets.overdue.length).toBeGreaterThan(0);
    expect(buckets.today.length + buckets.week.length).toBeGreaterThan(0);
    expect(buckets.later.length).toBeGreaterThan(0);
  });

  it('shows what is already late', () => {
    open();
    const card = screen.getByText('Overdue').closest('div')!;
    expect(within(card).getByText(formatCents(expected.overdue.total_cents))).toBeInTheDocument();
  });

  it('counts today inside the next seven days, not outside them', () => {
    // "Next 7 days" is read as a window starting now. An invoice due this
    // morning belongs in what leaves the account this week.
    expect(expected.next7.total_cents).toBe(
      sumCents([...buckets.today, ...buckets.week]),
    );
    expect(expected.next7.invoice_count).toBe(buckets.today.length + buckets.week.length);
  });

  it('never counts one invoice in both cards', () => {
    // The two figures sit side by side and will be added up by eye. Overlap
    // would make that sum wrong in a way nothing on screen could explain.
    const overdueIds = new Set(buckets.overdue.map((row) => row.id));
    const next7Ids = [...buckets.today, ...buckets.week].map((row) => row.id);
    expect(next7Ids.some((id) => overdueIds.has(id))).toBe(false);
  });

  it('leaves nothing unaccounted for between the two cards and Later', () => {
    const total =
      expected.overdue.total_cents + expected.next7.total_cents + sumCents(buckets.later);
    expect(total).toBe(sumCents(invoices));
  });

  it('says so plainly when nothing is late', async () => {
    vi.resetModules();
    vi.doMock('@/lib/queries/invoices', () => ({
      useUnpaidInvoices: () => ({ data: [], isLoading: false }),
      useCreateInvoice: () => ({ mutateAsync: vi.fn(), isPending: false }),
      findDuplicates: vi.fn(),
    }));

    const { ToastProvider: Fresh } = await import('@/components/ui/Toast');
    const Empty = (await import('@/app/(app)/page')).default;
    render(
      <Fresh>
        <Empty />
      </Fresh>,
    );

    expect(screen.getByText('Nothing late')).toBeInTheDocument();
    expect(screen.getByText(/Nothing outstanding\./)).toBeInTheDocument();
    vi.doUnmock('@/lib/queries/invoices');
  });
});

describe('coming up', () => {
  const runs = groupIntoRuns(invoices);

  /** The cards, in the order they are actually rendered. */
  function cards() {
    return within(screen.getByRole('list', { name: 'Coming up' })).getAllByRole('listitem');
  }

  it('leads with the most urgent, in due order', () => {
    open();
    expect(within(cards()[0]!).getByText(runs[0]!.supplier.name)).toBeInTheDocument();
  });

  it('caps the list and says how many there are in total', () => {
    open();
    // A summary that quietly stops is worse than one that hands over.
    const seeAll = screen.getByText(new RegExp(`See all ${invoices.length} invoices pending`));
    expect(seeAll.closest('a')).toHaveAttribute('href', '/b/all/pending');
  });

  it('labels each card with how late or how soon it is', () => {
    open();
    const run = runs[0]!;
    const expectedLabel = formatDueLabel(run.due_date, FIXTURE_TODAY);
    expect(screen.getAllByText(expectedLabel).length).toBeGreaterThan(0);
  });

  it('shows a run as a count and a single invoice by its number', () => {
    open();
    /*
     * Walked in render order, not looked up by supplier name. One supplier can
     * own two runs inside the visible six — same supplier, different due
     * dates — so a name lookup silently checks the wrong card and passes,
     * which is what the first version of this test did.
     */
    const rendered = cards();
    expect(rendered.length).toBeGreaterThan(1);

    rendered.forEach((card, i) => {
      const run = runs[i]!;
      const single = run.invoices.length === 1 ? run.invoices[0]! : null;
      const identifier = !single
        ? `${run.invoices.length} invoices`
        : single.invoice_number
          ? `#${single.invoice_number}`
          : 'No invoice number';

      expect(card.textContent).toContain(
        `${identifier} · ${run.invoices[0]!.business.code}`,
      );
    });
  });

  it('sends a single invoice to its record and a run to its business', () => {
    open();
    cards().forEach((card, i) => {
      const run = runs[i]!;
      const expectedHref =
        run.invoices.length === 1
          ? `/invoices/${run.invoices[0]!.id}`
          : `/b/${run.invoices[0]!.business.code.toLowerCase()}`;
      expect(card.querySelector('a')).toHaveAttribute('href', expectedHref);
    });
  });

  it('reorders when the sort changes', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: /Sort:/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Highest amount' }));

    // Biggest first, so the largest run in the whole set must now be on screen.
    const biggest = [...groupIntoRuns(invoices)].sort(
      (a, b) => b.total_cents - a.total_cents,
    )[0]!;
    expect(screen.getAllByText(biggest.supplier.name).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /Sort: highest amount/ })).toBeInTheDocument();
  });
});

describe('the businesses still add up', () => {
  it('the business rows sum to the group total', () => {
    open();
    // If these disagree the dashboard is lying about money, and every screen
    // below it inherits the lie.
    const perBusiness = BUSINESSES.map((business) =>
      sumCents(filterByScope(invoices, business.code.toLowerCase(), BUSINESSES)),
    );
    expect(perBusiness.reduce((a, b) => a + b, 0)).toBe(sumCents(invoices));
    expect(screen.getByText('Overall').closest('a')).toHaveAttribute('href', '/b/all');
  });

  it('shows every business, including any owing nothing', () => {
    open();
    for (const business of BUSINESSES) {
      expect(screen.getByText(business.name)).toBeInTheDocument();
    }
  });

  it('each business row shows its own total', () => {
    open();
    for (const business of BUSINESSES) {
      const scoped = filterByScope(invoices, business.code.toLowerCase(), BUSINESSES);
      const row = screen.getByText(business.name).closest('a')!;
      expect(within(row).getByText(formatCents(sumCents(scoped)))).toBeInTheDocument();
    }
  });

  it('links each row to its own scope', () => {
    open();
    for (const business of BUSINESSES) {
      expect(screen.getByText(business.name).closest('a')).toHaveAttribute(
        'href',
        `/b/${business.code.toLowerCase()}`,
      );
    }
  });
});

describe('the chrome', () => {
  it('greets the signed-in person, as the page heading', () => {
    open();
    // Not decoration above a heading — a screen whose first heading is
    // "Coming up" has no h1 at all.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/Rabindra/);
  });

  it('offers New invoice as a full-width button, not the floating one', () => {
    open();
    expect(screen.getByRole('button', { name: /New invoice/ })).toBeInTheDocument();
    // Two controls doing one job, one overlapping the other, is worse than
    // either.
    expect(screen.queryByRole('button', { name: 'Add invoice' })).not.toBeInTheDocument();
  });

  it('renders nothing broken — notes §6', () => {
    const { container } = open();
    const text = container.textContent ?? '';
    for (const token of ['undefined', 'NaN', '[object Object]', 'Invalid Date']) {
      expect(text).not.toContain(token);
    }
  });
});
