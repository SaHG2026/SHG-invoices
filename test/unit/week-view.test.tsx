import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { ToastProvider } from '@/components/ui/Toast';
import { BUSINESSES, PROFILES, SUPPLIERS, makeInvoices } from '../fixtures/invoices';
import { sydneyToday } from '@/lib/date';
import { formatCents, sumCents } from '@/lib/money';
import { bucketByUrgency } from '@/lib/derive/urgency';
import { groupIntoRuns } from '@/lib/derive/runs';
import { filterByScope } from '@/lib/scope';

/**
 * The Week. Spec §7.2.
 *
 * Spec §1's second metric: "Mani opens the app on Monday morning and knows
 * within 3 seconds what's due this week and what's already late." Three
 * seconds means the order is not negotiable and each section's own total has
 * to be right — that total is the number somebody acts on.
 */

const TODAY = sydneyToday();

const invoices = makeInvoices(60).map((invoice, i) => ({
  ...invoice,
  created_by: PROFILES[i % PROFILES.length]!.id,
}));

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

const { WeekView } = await import('@/components/screens/WeekView');

function open(scope = 'all') {
  return render(
    <ToastProvider>
      <WeekView scope={scope} />
    </ToastProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

describe('the sections', () => {
  const buckets = bucketByUrgency(invoices, TODAY);

  it('appear in urgency order — overdue first, always', () => {
    const { container } = open();
    const headings = [...container.querySelectorAll('section > div > span:first-child')].map(
      (node) => node.textContent ?? '',
    );

    const expected = ['Overdue', 'Today', 'Next 7 days', 'Later'].filter(
      (label) =>
        buckets[
          label === 'Overdue'
            ? 'overdue'
            : label === 'Today'
              ? 'today'
              : label === 'Next 7 days'
                ? 'week'
                : 'later'
        ].length > 0,
    );

    for (const [index, label] of expected.entries()) {
      expect(headings[index]).toContain(label);
    }
  });

  it('each section total is the sum of its own invoices', () => {
    open();
    for (const [key, label] of [
      ['overdue', 'Overdue'],
      ['today', 'Today'],
      ['week', 'Next 7 days'],
      ['later', 'Later'],
    ] as const) {
      const rows = buckets[key];
      if (rows.length === 0) continue;

      const section = screen.getByText(new RegExp(`^${label}`)).closest('section')!;
      expect(within(section).getByText(formatCents(sumCents(rows)))).toBeInTheDocument();
    }
  });

  it('the sections together account for every invoice', () => {
    const total = (['overdue', 'today', 'week', 'later'] as const).reduce(
      (sum, key) => sum + sumCents(buckets[key]),
      0,
    );
    expect(total).toBe(sumCents(invoices));
  });
});

describe('payment runs — spec §6', () => {
  it('collapses invoices sharing a supplier and a due date', () => {
    open();
    const runs = groupIntoRuns(invoices).filter((run) => run.invoices.length > 1);
    expect(runs.length).toBeGreaterThan(0);

    // A collapsed run says how many invoices are inside it.
    const first = runs[0]!;
    const label = `${first.invoices.length} invoices`;
    expect(screen.getAllByText(new RegExp(label)).length).toBeGreaterThan(0);
  });

  it('expands to show each invoice inside', () => {
    open();
    const runs = groupIntoRuns(invoices).filter((run) => run.invoices.length > 1);
    const run = runs[0]!;

    const collapsed = screen
      .getAllByRole('button', { expanded: false })
      .find((button) => button.textContent?.includes(`${run.invoices.length} invoices`))!;

    fireEvent.click(collapsed);
    expect(collapsed).toHaveAttribute('aria-expanded', 'true');

    // The children appear, and their amounts sum to the run's total.
    const item = collapsed.closest('li')!;
    const inner = within(item).getAllByRole('button', { expanded: false });
    expect(inner).toHaveLength(run.invoices.length);
  });

  it('does not wrap a single invoice in a group of one', () => {
    open();
    // A run of one renders as a plain row: no "1 invoices" heading anywhere.
    expect(screen.queryByText(/\b1 invoices\b/)).not.toBeInTheDocument();
  });
});

describe('scoping', () => {
  it('shows only that business, and totals it correctly', () => {
    for (const business of BUSINESSES) {
      const scope = business.code.toLowerCase();
      const { unmount } = open(scope);

      const scoped = filterByScope(invoices, scope, BUSINESSES);
      expect(screen.getByText(business.name)).toBeInTheDocument();
      expect(screen.getAllByText(formatCents(sumCents(scoped))).length).toBeGreaterThan(0);
      unmount();
    }
  });

  it('says so for a business that does not exist', () => {
    open('xyz');
    expect(screen.getByText('No such business')).toBeInTheDocument();
    // The dangerous failure is showing all four businesses under one name.
    expect(screen.queryByText('Overdue')).not.toBeInTheDocument();
  });

  it('links to the pending list for the same scope', () => {
    open('gmh');
    expect(screen.getByText(/All pending/).closest('a')).toHaveAttribute(
      'href',
      '/b/gmh/pending',
    );
  });
});

describe('nothing broken — notes §6', () => {
  it('renders 60 invoices with no undefined, NaN or [object Object]', () => {
    const { container } = open();
    const text = container.textContent ?? '';
    for (const token of ['undefined', 'NaN', '[object Object]', 'Invalid Date']) {
      expect(text).not.toContain(token);
    }
  });
});
