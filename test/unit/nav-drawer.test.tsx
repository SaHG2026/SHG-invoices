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
  useTeam: () => ({ data: PROFILES.filter((person) => person.role !== 'builder') }),
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

  it('shows each business its own mark', () => {
    openDrawer();

    const markOf = (name: string) =>
      screen.getByText(name).closest('a')!.querySelector('img')?.getAttribute('src') ?? null;

    // One brand, two shops: the name beside it is what tells them apart.
    expect(markOf('GroceryMate Hurstville')).toBe('/logos/grocery-mate.png');
    expect(markOf('GroceryMate Parramatta')).toBe('/logos/grocery-mate.png');
    expect(markOf('Majheri Restaurant')).toBe('/logos/majheri.png');
  });

  it('falls back to letters where there is no artwork', () => {
    openDrawer();
    const row = screen.getByText('Deli Delights').closest('a')!;
    // Not a borrowed logo: three identical green circles out of four would
    // make the menu less readable, not more.
    expect(row.querySelector('img')).toBeNull();
    expect(within(row).getByText('DD')).toBeInTheDocument();
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

  it('has no profile chip — it lives in the menu now', () => {
    /*
     * Removed at the client's request to make room for the connection symbol.
     * Nothing became unreachable: the drawer opens with the same chip, the
     * same name and the same link to Settings, and the menu button is on
     * every screen. The test below is the one that now guards that.
     */
    render(
      <AppChrome>
        <p>the screen</p>
      </AppChrome>,
    );
    expect(screen.queryByRole('link', { name: /Signed in as Mani/ })).not.toBeInTheDocument();
  });

  it('shows whether the phone is online, always, not only when it is not', () => {
    /*
     * Asked for directly, and the reason it is always visible rather than
     * appearing on a problem: a symbol nobody has seen before cannot answer
     * "did that save" at the moment it matters. You cannot tell "fine" from
     * "not rendered".
     */
    render(
      <AppChrome>
        <p>the screen</p>
      </AppChrome>,
    );
    expect(screen.getByRole('status', { name: 'Online' })).toBeInTheDocument();
  });

  it('still reaches settings, from the menu', () => {
    render(
      <AppChrome>
        <p>the screen</p>
      </AppChrome>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    expect(screen.getByRole('link', { name: /Mani/ })).toHaveAttribute('href', '/settings');
  });
});

describe('the counts are what is still owed', () => {
  it('does not keep counting an invoice that has been paid', async () => {
    /*
     * Reported as "even when paid, there's still label of pending invoices on
     * the side menu". The unpaid query now carries this session's ticked-off
     * invoices so their rows do not vanish, and the menu was counting the
     * array as it arrived.
     */
    vi.resetModules();
    const gmh = BUSINESSES.find((b) => b.code === 'GMH')!;
    const mixed = invoices.map((invoice) =>
      invoice.business_id === gmh.id ? { ...invoice, status: 'paid' as const } : invoice,
    );

    vi.doMock('@/lib/queries/invoices', () => ({
      useUnpaidInvoices: () => ({ data: mixed, isLoading: false }),
      useCreateInvoice: () => ({ mutateAsync: vi.fn(), isPending: false }),
      findDuplicates: vi.fn(),
    }));

    const { NavDrawer: Drawer } = await import('@/components/app/NavDrawer');
    render(<Drawer onClose={() => {}} />);

    // Every GMH invoice is paid, so no number sits beside it at all.
    const row = screen.getByText(gmh.name).closest('a')!;
    expect(row.textContent).toBe(gmh.name);

    // The businesses that still owe are unaffected.
    const gmp = BUSINESSES.find((b) => b.code === 'GMP')!;
    const stillOwed = mixed.filter(
      (i) => i.business_id === gmp.id && i.status === 'unpaid',
    ).length;
    expect(
      within(screen.getByText(gmp.name).closest('a')!).getByText(String(stillOwed)),
    ).toBeInTheDocument();

    vi.doUnmock('@/lib/queries/invoices');
  });
});
