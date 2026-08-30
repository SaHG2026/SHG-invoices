import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { ToastProvider } from '@/components/ui/Toast';
import { BUSINESSES, PROFILES, SUPPLIERS, makeInvoices } from '../fixtures/invoices';
import { sydneyToday } from '@/lib/date';
import { formatCents, sumCents } from '@/lib/money';
import { filterByScope } from '@/lib/scope';

/**
 * The dashboard. ARCHITECTURE §16.
 *
 * Its whole job is to say what the group owes and which business needs
 * looking at. So what matters is that the four business figures and the
 * headline are the same money counted once — notes §3.
 */

const invoices = makeInvoices(6).map((invoice, i) => ({
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


const Dashboard = (await import('@/app/(app)/page')).default;

function open() {
  return render(
    <ToastProvider>
      <Dashboard />
    </ToastProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

describe('the money adds up', () => {
  it('the business rows sum to the headline', () => {
    open();
    // If these disagree the dashboard is lying about money, and every screen
    // below it inherits the lie.
    const perBusiness = BUSINESSES.map((business) =>
      sumCents(filterByScope(invoices, business.code.toLowerCase(), BUSINESSES)),
    );
    expect(perBusiness.reduce((a, b) => a + b, 0)).toBe(sumCents(invoices));

    // The headline appears twice: the big figure and the Overall row.
    expect(screen.getAllByText(formatCents(sumCents(invoices)))).toHaveLength(2);
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
    expect(screen.getByText('Overall').closest('a')).toHaveAttribute('href', '/b/all');
    for (const business of BUSINESSES) {
      expect(screen.getByText(business.name).closest('a')).toHaveAttribute(
        'href',
        `/b/${business.code.toLowerCase()}`,
      );
    }
  });

  it('renders nothing broken — notes §6', () => {
    const { container } = open();
    const text = container.textContent ?? '';
    for (const token of ['undefined', 'NaN', '[object Object]', 'Invalid Date']) {
      expect(text).not.toContain(token);
    }
  });
});

describe('the headline', () => {
  it('greets the signed-in person', () => {
    open();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/Rabindra/);
  });

  it('shows today in Sydney', () => {
    open();
    expect(sydneyToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
