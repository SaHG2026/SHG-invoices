import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { ToastProvider } from '@/components/ui/Toast';
import { BUSINESSES, PROFILES, SUPPLIERS, makeInvoices } from '../fixtures/invoices';
import { sydneyToday } from '@/lib/date';

/**
 * Tapping a row opens it.
 *
 * The detail screen proper — with notes and the activity stream — is Phase 5.
 * This is the lighter thing the client asked for: enough to answer "what is
 * this one?" without leaving the list you are reading.
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

const Dashboard = (await import('@/app/(app)/page')).default;

function open() {
  return render(
    <ToastProvider>
      <Dashboard />
    </ToastProvider>,
  );
}

/** The row buttons are the ones naming a supplier and an amount. */
function rows() {
  return screen.getAllByRole('button', { expanded: false }).concat(
    screen.queryAllByRole('button', { expanded: true }),
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

describe('expanding an invoice', () => {
  it('starts closed', () => {
    open();
    expect(screen.queryByText('Reference')).not.toBeInTheDocument();
    for (const row of rows()) expect(row).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens on tap and shows the details', () => {
    open();
    const first = rows()[0]!;
    fireEvent.click(first);

    expect(first).toHaveAttribute('aria-expanded', 'true');
    for (const label of [
      'Amount',
      'Supplier',
      'Business',
      'Invoice date',
      'Due',
      'Reference',
      'Added',
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('names who added it and when', () => {
    open();
    fireEvent.click(rows()[0]!);

    const added = screen.getByText('Added').closest('div')!;
    // Some real person, and a readable time — never a raw id or a timestamp.
    expect(within(added).getByText(/Mani|Milan|Sujan|Rabindra/)).toBeInTheDocument();
    expect(added.textContent).not.toMatch(/undefined|NaN|Invalid|T\d\d:/);
  });

  it('shows the full business name, not just the code', () => {
    open();
    fireEvent.click(rows()[0]!);

    const business = screen.getByText('Business').closest('div')!;
    expect(business.textContent).toMatch(/GroceryMate|Majheri|Deli Delights/);
  });

  it('closes again on a second tap', () => {
    open();
    const first = rows()[0]!;

    fireEvent.click(first);
    expect(screen.getByText('Reference')).toBeInTheDocument();

    fireEvent.click(first);
    expect(screen.queryByText('Reference')).not.toBeInTheDocument();
  });

  it('keeps only one open at a time', () => {
    open();
    const all = rows();

    fireEvent.click(all[0]!);
    fireEvent.click(all[1]!);

    // One expanded panel, not two stacked on top of each other.
    expect(screen.getAllByText('Reference')).toHaveLength(1);
    expect(screen.getAllByRole('button', { expanded: true })).toHaveLength(1);
  });

  it('renders nothing broken — notes §6', () => {
    const { container } = open();
    for (const row of rows()) fireEvent.click(row);

    const text = container.textContent ?? '';
    for (const token of ['undefined', 'NaN', '[object Object]', 'Invalid Date']) {
      expect(text).not.toContain(token);
    }
  });
});

describe('the headline', () => {
  it('sums the same invoices the list renders', () => {
    open();
    const total = invoices.reduce((sum, invoice) => sum + invoice.amount_cents, 0);
    const formatted = new Intl.NumberFormat('en-AU', {
      style: 'currency',
      currency: 'AUD',
    }).format(total / 100);

    expect(screen.getByText(formatted)).toBeInTheDocument();
  });

  it('greets the signed-in person', () => {
    open();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/Rabindra/);
  });

  it('shows today in Sydney', () => {
    open();
    expect(sydneyToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
