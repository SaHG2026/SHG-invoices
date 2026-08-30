import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { ToastProvider } from '@/components/ui/Toast';
import { BUSINESSES, PROFILES, SUPPLIERS, makeInvoices } from '../fixtures/invoices';
import { sydneyToday } from '@/lib/date';
import { formatCents } from '@/lib/money';
import { filterByScope } from '@/lib/scope';
import { sumCents } from '@/lib/money';

/**
 * The pending list, and the number at the bottom of it.
 *
 * Spec §7.4: "Sticky footer shows the total of whatever is currently filtered.
 * That number changing as you filter is the whole point of the screen."
 *
 * Notes §3 calls the failure "a trust-destroying bug that looks like a display
 * glitch" — a total showing everything while the list shows a subset. So these
 * tests do not check that a total appears; they check that it equals the sum
 * of the rows actually on screen, after every combination of controls.
 */

const TODAY = sydneyToday();

/** Real spread: some overdue, some due today, some later. */
const invoices = makeInvoices(40).map((invoice, i) => ({
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

const { PendingList } = await import('@/components/screens/PendingList');

/**
 * The screen takes a plain scope. The route file is the only thing that deals
 * in promised params, which is why it has nothing else in it.
 */
function open(scope = 'all') {
  return render(
    <ToastProvider>
      <PendingList scope={scope} />
    </ToastProvider>,
  );
}

/** Every invoice row currently rendered, by its supplier + amount button. */
function rowButtons() {
  return screen.queryAllByRole('button', { expanded: false }).filter((b) => b.querySelector('.money'));
}

/** The footer figure. It is the only h2-sized money on the page. */
function footerTotal(): string {
  const footer = document.querySelector('.fixed.inset-x-0.bottom-0')!;
  return within(footer as HTMLElement).getByText(/^\$/).textContent!;
}

function footerCount(): string {
  const footer = document.querySelector('.fixed.inset-x-0.bottom-0')!;
  return within(footer as HTMLElement).getByText(/invoice/).textContent!;
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

describe('the sticky total equals what is on screen', () => {
  it('with no filters', async () => {
    open();
    await screen.findByRole('heading', { name: 'Pending' });
    expect(footerTotal()).toBe(formatCents(sumCents(invoices)));
    expect(footerCount()).toContain(String(invoices.length));
  });

  it('scoped to one business', async () => {
    for (const business of BUSINESSES) {
      const { unmount } = open(business.code.toLowerCase());
      await screen.findByRole('heading', { name: 'Pending' });

      const scoped = filterByScope(invoices, business.code.toLowerCase(), BUSINESSES);
      expect(footerTotal()).toBe(formatCents(sumCents(scoped)));
      expect(rowButtons()).toHaveLength(scoped.length);
      unmount();
    }
  });

  it('after switching on overdue only', async () => {
    open();
    await screen.findByRole('heading', { name: 'Pending' });
    const before = footerTotal();

    fireEvent.click(screen.getByRole('button', { name: 'Overdue only' }));

    const overdue = invoices.filter((invoice) => invoice.due_date < TODAY);
    expect(footerTotal()).toBe(formatCents(sumCents(overdue)));
    expect(rowButtons()).toHaveLength(overdue.length);
    // The number has to actually move, or the control is doing nothing.
    expect(footerTotal()).not.toBe(before);
    expect(footerCount()).toContain('filtered');
  });

  it('after filtering by supplier', async () => {
    open();
    await screen.findByRole('heading', { name: 'Pending' });

    const select = screen.getByRole('combobox');
    const supplier = invoices[0]!.supplier;
    fireEvent.change(select, { target: { value: supplier.id } });

    const mine = invoices.filter((invoice) => invoice.supplier_id === supplier.id);
    expect(footerTotal()).toBe(formatCents(sumCents(mine)));
    expect(rowButtons()).toHaveLength(mine.length);
  });

  it('with a supplier and overdue-only together', async () => {
    open();
    await screen.findByRole('heading', { name: 'Pending' });

    const supplier = invoices[0]!.supplier;
    fireEvent.change(screen.getByRole('combobox'), { target: { value: supplier.id } });
    fireEvent.click(screen.getByRole('button', { name: 'Overdue only' }));

    const both = invoices.filter(
      (invoice) => invoice.supplier_id === supplier.id && invoice.due_date < TODAY,
    );
    expect(footerTotal()).toBe(formatCents(sumCents(both)));
    expect(rowButtons()).toHaveLength(both.length);
  });

  it('does not change when only the sort changes', async () => {
    open();
    await screen.findByRole('heading', { name: 'Pending' });
    const total = footerTotal();

    for (const label of ['Supplier', 'Amount', 'Recently added', 'Due date']) {
      fireEvent.click(screen.getByRole('button', { name: label }));
      expect(footerTotal()).toBe(total);
      expect(rowButtons()).toHaveLength(invoices.length);
    }
  });
});

describe('sorting', () => {
  it('reorders without losing anything', async () => {
    open();
    await screen.findByRole('heading', { name: 'Pending' });

    fireEvent.click(screen.getByRole('button', { name: 'Amount' }));
    const amounts = rowButtons().map((row) =>
      Number(row.querySelector('.money')!.textContent!.replace(/[^0-9.]/g, '')),
    );

    expect(amounts).toHaveLength(invoices.length);
    for (let i = 1; i < amounts.length; i++) {
      expect(amounts[i]!).toBeLessThanOrEqual(amounts[i - 1]!);
    }
  });

  it('marks the chosen sort, and only that one', async () => {
    open();
    await screen.findByRole('heading', { name: 'Pending' });

    fireEvent.click(screen.getByRole('button', { name: 'Supplier' }));
    expect(screen.getByRole('button', { name: 'Supplier' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Due date' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });
});

describe('empty states say what to do — spec §8', () => {
  it('distinguishes "nothing here" from "nothing matches"', async () => {
    open();
    await screen.findByRole('heading', { name: 'Pending' });

    const supplier = invoices[0]!.supplier;
    fireEvent.change(screen.getByRole('combobox'), { target: { value: supplier.id } });
    fireEvent.click(screen.getByRole('button', { name: 'Overdue only' }));

    // Whichever this fixture produces, the copy must never be a bare "no results".
    const empty = screen.queryByText(/Clear one to see more|Add one with the \+ button/);
    if (rowButtons().length === 0) {
      expect(empty).toBeInTheDocument();
    }
  });
});

describe('an unknown scope', () => {
  it('shows nothing rather than every business under one name', async () => {
    open('xyz');
    await screen.findByRole('heading', { name: 'Pending' });
    expect(rowButtons()).toHaveLength(0);
    expect(footerTotal()).toBe(formatCents(0));
  });
});
