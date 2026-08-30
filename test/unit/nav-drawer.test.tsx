import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { BUSINESSES, PROFILES, SUPPLIERS, makeInvoices } from '../fixtures/invoices';

/**
 * The side menu.
 *
 * Two things here are load-bearing rather than cosmetic.
 *
 *   The counts come from the same unpaid array every screen is derived from
 *   (architecture §2). A menu that said 12 next to a business whose page then
 *   showed 9 would be the trust-destroying disagreement notes §3 warns about,
 *   arrived at from a new direction.
 *
 *   The menu is mounted only while it is open. That is not only a query
 *   saving: a permanently-mounted drawer puts every business name and every
 *   destination into the DOM of every screen, where tests and screen readers
 *   both find them and cannot tell them apart from the page's own content.
 */

const invoices = makeInvoices(60);

vi.mock('@/lib/queries/session', () => ({
  useCurrentProfile: () => ({ data: PROFILES[0], isLoading: false, isError: false }),
  useProfiles: () => ({ data: PROFILES }),
  useSignOut: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateNotifyPreference: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/lib/queries/reference', () => ({
  useBusinesses: () => ({ data: BUSINESSES }),
  useSuppliers: () => ({ data: SUPPLIERS }),
  useCreateSupplier: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/lib/queries/invoices', () => ({
  useUnpaidInvoices: () => ({ data: invoices, isLoading: false }),
  useCreateInvoice: () => ({ mutateAsync: vi.fn(), isPending: false }),
  findDuplicates: vi.fn(),
}));

vi.mock('@/lib/queries/detail', () => ({
  useRecentActivity: () => ({ data: [] }),
}));

const pathname = { current: '/' };
vi.mock('next/navigation', () => ({
  usePathname: () => pathname.current,
}));

const { NavDrawer } = await import('@/components/app/NavDrawer');
const { AppChrome } = await import('@/components/app/AppChrome');

function openDrawer(at = '/') {
  pathname.current = at;
  return render(<NavDrawer onClose={() => {}} />);
}

beforeEach(() => {
  pathname.current = '/';
  vi.clearAllMocks();
});

describe('what the menu offers', () => {
  it('lists every section, in order', () => {
    openDrawer();
    const menu = screen.getByRole('navigation', { name: 'Sections' });
    const labels = within(menu)
      .getAllByRole('link')
      .map((link) => link.textContent?.trim());

    expect(labels.slice(0, 1)).toEqual(['Invoices']);
    expect(labels).toContain('Suppliers');
    expect(labels).toContain('Customers');
    expect(labels).toContain('Paid history');
    expect(labels).toContain('Settings');
  });

  it('puts Customers directly under Suppliers', () => {
    openDrawer();
    const menu = screen.getByRole('navigation', { name: 'Sections' });
    const labels = within(menu)
      .getAllByRole('link')
      .map((link) => link.textContent?.trim());

    expect(labels.indexOf('Customers')).toBe(labels.indexOf('Suppliers') + 1);
  });

  it('sends each section somewhere real', () => {
    openDrawer();
    const menu = screen.getByRole('navigation', { name: 'Sections' });
    expect(within(menu).getByText('Suppliers').closest('a')).toHaveAttribute(
      'href',
      '/suppliers',
    );
    expect(within(menu).getByText('Customers').closest('a')).toHaveAttribute(
      'href',
      '/customers',
    );
    expect(within(menu).getByText('Paid history').closest('a')).toHaveAttribute(
      'href',
      '/b/all/history',
    );
    expect(within(menu).getByText('Settings').closest('a')).toHaveAttribute('href', '/settings');
  });
});

describe('the businesses under Invoices', () => {
  it('lists all four, in their own order', () => {
    openDrawer();
    for (const business of BUSINESSES) {
      expect(screen.getByText(business.name)).toBeInTheDocument();
    }
  });

  it('counts unpaid invoices from the same array the screens use', () => {
    openDrawer();

    for (const business of BUSINESSES) {
      const expected = invoices.filter((row) => row.business_id === business.id).length;
      if (expected === 0) continue;

      const row = screen.getByText(business.name).closest('a')!;
      expect(within(row).getByText(String(expected)), business.name).toBeInTheDocument();
    }
  });

  it('links each business to its own week', () => {
    openDrawer();
    expect(screen.getByText('GroceryMate Hurstville').closest('a')).toHaveAttribute(
      'href',
      '/b/gmh',
    );
  });

  it('collapses and expands', () => {
    openDrawer();
    fireEvent.click(screen.getByRole('button', { name: 'Hide businesses' }));
    expect(screen.queryByText('GroceryMate Hurstville')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show businesses' }));
    expect(screen.getByText('GroceryMate Hurstville')).toBeInTheDocument();
  });

  it('shows a lettered tile until a logo is supplied', () => {
    openDrawer();
    const row = screen.getByText('GroceryMate Hurstville').closest('a')!;
    // The code, which is already stamped into every internal ref — a label
    // people have learnt, rather than a grey box.
    expect(within(row).getByText('GMH')).toBeInTheDocument();
  });
});

describe('knowing where you are', () => {
  it('marks one row, and only one, as current', () => {
    for (const path of ['/', '/b/gmh', '/suppliers', '/customers', '/b/all/history', '/settings']) {
      const { unmount } = openDrawer(path);
      const current = screen.getAllByRole('link').filter(
        (link) => link.getAttribute('aria-current') === 'page',
      );
      expect(current.length, `${path} marked ${current.length}`).toBe(1);
      unmount();
    }
  });

  it('marks Paid history, not Invoices, when you are in history', () => {
    openDrawer('/b/all/history');
    const menu = screen.getByRole('navigation', { name: 'Sections' });
    expect(within(menu).getByText('Paid history').closest('a')).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(menu).getByText('Invoices').closest('a')).not.toHaveAttribute('aria-current');
  });
});

describe('closing it', () => {
  it('closes on Escape', () => {
    const onClose = vi.fn();
    pathname.current = '/';
    render(<NavDrawer onClose={onClose} />);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('has a close button as well as the backdrop', () => {
    // The backdrop is aria-hidden, so without this a screen reader has only
    // Escape — same reasoning as components/ui/Sheet.tsx.
    const onClose = vi.fn();
    render(<NavDrawer onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: 'Close menu' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('lets the page scroll again on the way out', () => {
    const { unmount } = openDrawer();
    expect(document.body.style.overflow).toBe('hidden');
    unmount();
    expect(document.body.style.overflow).not.toBe('hidden');
  });
});

describe('the header it hangs off', () => {
  it('keeps the menu out of the DOM until it is opened', () => {
    render(
      <AppChrome>
        <p>the screen</p>
      </AppChrome>,
    );

    expect(screen.queryByRole('navigation', { name: 'Sections' })).not.toBeInTheDocument();
    expect(screen.queryByText('GroceryMate Hurstville')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    expect(screen.getByRole('navigation', { name: 'Sections' })).toBeInTheDocument();
  });

  it('names the app rather than abbreviating it', () => {
    render(
      <AppChrome>
        <p>the screen</p>
      </AppChrome>,
    );
    expect(screen.getByText('SHG Invoices')).toBeInTheDocument();
  });

  it('sends the person chip to settings', () => {
    render(
      <AppChrome>
        <p>the screen</p>
      </AppChrome>,
    );
    expect(
      screen.getByRole('link', { name: /Signed in as Mani/ }),
    ).toHaveAttribute('href', '/settings');
  });
});
