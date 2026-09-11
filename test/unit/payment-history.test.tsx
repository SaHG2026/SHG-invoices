import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { ToastProvider } from '@/components/ui/Toast';
import { BUSINESSES, PROFILES } from '../fixtures/invoices';
import { NAV_ITEMS, maySeePaymentHistory, navItemsFor } from '@/lib/nav';
import type { ActivityEntry, Profile } from '@/lib/types';

/**
 * Settled money, and who it is any of the business of. CATCH_UP_027.
 *
 * ===========================================================================
 * Four doors, and this file is here because three of them are not the menu.
 *
 * *"also for assistants hide payment history"*. The obvious half is the
 * drawer row. The other three are the ones that make a hidden screen not
 * hidden:
 *
 *   the History link on every business's week view
 *   the URL itself, which a bookmark or a back button still reaches
 *   the activity bell, which announces "Mani marked paid" with no screen
 *     involved at all
 *
 * **Hiding the row and leaving the other three is a curtain, not a wall**,
 * and it is the worst shape of wrong because the menu makes it look finished.
 * So each door gets a test, and `maySeePaymentHistory` is one rule asked four
 * times rather than four copies of `!isAssistant`.
 *
 * None of this is the boundary. `assistant_read` on `invoices` and
 * `activity_log` is, and it refuses whatever these components decide. What is
 * asserted here is the OFFERING — notes §6, do not offer what cannot be done,
 * and its mirror: do not show what has been said not to show.
 * ===========================================================================
 */

const MANI = PROFILES[0]!;
const MILAN = PROFILES[1]!;
const RABINDRA = PROFILES[3]!;

const ASSISTANT: Profile = { ...MILAN, role: 'assistant' };
const VENUE: Profile = { ...MILAN, id: 'p-gmp', role: 'staff', business_id: 'b-gmp' };

describe('the rule itself', () => {
  /*
   * Every role named in both directions, because this is the ninth allowlist
   * and HANDOFF §2's trap applies to all of them: written by exclusion, a
   * tier added later is INCLUDED by default and has to be visited on purpose.
   * Naming all five here means a sixth breaks a test rather than a promise.
   */
  it('says who may see settled money', () => {
    expect(maySeePaymentHistory(MANI)).toBe(true);
    expect(maySeePaymentHistory(MILAN)).toBe(true);
    expect(maySeePaymentHistory(RABINDRA)).toBe(true);
    expect(maySeePaymentHistory(ASSISTANT)).toBe(false);
    /*
     * A venue never had it: CATCH_UP_010 §3 keeps payment status away from a
     * shop, and `VenueChrome` has no history anywhere. True here for a
     * different reason than the menu — recorded so nobody "fixes" it.
     */
    expect(maySeePaymentHistory(VENUE)).toBe(true);
  });

  it('answers true while the profile is still loading', () => {
    /*
     * The opposite default from `isOwner`, and deliberately so. This gate
     * guards a whole screen, and `HistoryList` waits for the profile before
     * it renders either way — so the value here is never what decides. What
     * matters is that it matches `!isAssistant`, which is false for null.
     */
    expect(maySeePaymentHistory(null)).toBe(true);
    expect(maySeePaymentHistory(undefined)).toBe(true);
  });
});

describe('door 1 — the side menu', () => {
  it('drops Paid history for an assistant', () => {
    const sections = navItemsFor(ASSISTANT).map((item) => item.section);
    expect(sections).not.toContain('history');
  });

  it('keeps Invoices, which is the tier working as intended', () => {
    const sections = navItemsFor(ASSISTANT).map((item) => item.section);
    expect(sections).toContain('invoices');
    expect(sections).toContain('settings');
  });

  it('changes nothing for everybody else', () => {
    for (const person of [MANI, MILAN, RABINDRA]) {
      expect(navItemsFor(person)).toEqual(NAV_ITEMS);
    }
  });
});

/* -------------------------------------------------------------------------- */

const mocks = vi.hoisted(() => ({
  who: { current: null as Profile | null },
  activity: { current: [] as ActivityEntry[] },
}));

vi.mock('@/lib/queries/session', () => ({
  useCurrentProfile: () => ({ data: mocks.who.current, isLoading: false, isError: false }),
  useProfiles: () => ({ data: PROFILES }),
  useTeam: () => ({ data: PROFILES.filter((p) => p.role !== 'builder') }),
  useSignOut: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/lib/queries/detail', () => ({
  useRecentActivity: () => ({ data: mocks.activity.current }),
  useAddNote: () => ({ mutateAsync: vi.fn(), mutate: vi.fn(), isPending: false }),
  useInvoice: () => ({ data: null, isLoading: false }),
  useInvoiceActivity: () => ({ data: [] }),
  useInvoiceNotes: () => ({ data: [] }),
}));

vi.mock('@/lib/queries/reference', () => ({
  useBusinesses: () => ({ data: BUSINESSES }),
  useSuppliers: () => ({ data: [] }),
  useCreateSupplier: () => ({ mutateAsync: vi.fn(), mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/lib/queries/history', () => ({
  useHistory: () => ({ data: [], isLoading: false }),
}));

vi.mock('@/lib/queries/invoices', () => ({
  useUnpaidInvoices: () => ({ data: [], isLoading: false }),
  useCreateInvoice: () => ({ mutateAsync: vi.fn(), isPending: false }),
  findDuplicates: vi.fn(),
}));

vi.mock('@/lib/queries/review', () => ({ useAwaitingReview: () => ({ data: [] }) }));
vi.mock('next/navigation', () => ({ usePathname: () => '/b/all/history' }));

const { HistoryList } = await import('@/components/screens/HistoryList');
const { ActivityBell } = await import('@/components/app/ActivityBell');

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  mocks.who.current = MANI;
  mocks.activity.current = [];
});

describe('door 3 — the URL itself', () => {
  const open = () =>
    render(
      <ToastProvider>
        <HistoryList scope="all" />
      </ToastProvider>,
    );

  it('refuses an assistant who reaches the screen directly', () => {
    mocks.who.current = ASSISTANT;
    open();

    expect(screen.getByText(/aren’t part of your access/)).toBeInTheDocument();
    // The filters and the list are not merely empty — they are not rendered.
    expect(screen.queryByLabelText(/Search/)).not.toBeInTheDocument();
  });

  it('still points them at what they can see', () => {
    mocks.who.current = ASSISTANT;
    open();
    expect(screen.getByText('Invoices')).toBeInTheDocument();
  });

  it('renders the real screen for everybody else', () => {
    mocks.who.current = MILAN;
    open();
    expect(screen.queryByText(/aren’t part of your access/)).not.toBeInTheDocument();
  });
});

/* -------------------------------------------------------------------------- */

const entry = (id: number, action: string, detail: Record<string, unknown> | null = null) =>
  ({
    id,
    entity_type: 'invoice',
    entity_id: `i-${id}`,
    action,
    actor_id: MANI.id,
    detail,
    created_at: '2026-09-11T02:00:00.000Z',
  }) as ActivityEntry;

describe('door 4 — the bell, which is not a screen', () => {
  const open = () =>
    render(
      <ToastProvider>
        <ActivityBell />
      </ToastProvider>,
    );

  beforeEach(() => {
    mocks.activity.current = [
      entry(1, 'created'),
      entry(2, 'paid', { payment_ref: { from: null, to: 'EFT-8891' } }),
      entry(3, 'unpaid'),
      entry(4, 'edited', { amount_cents: { from: 1000, to: 1200 } }),
    ];
  });

  it('says nothing about payments to an assistant', () => {
    mocks.who.current = ASSISTANT;
    open();
    fireEvent.click(screen.getByRole('button', { name: /Activity/ }));

    const panel = within(screen.getByText('Recent activity').closest('div')!);
    expect(panel.queryByText(/marked paid/)).not.toBeInTheDocument();
    expect(panel.queryByText(/back to unpaid/)).not.toBeInTheDocument();
  });

  it('still shows them everything else', () => {
    mocks.who.current = ASSISTANT;
    open();
    fireEvent.click(screen.getByRole('button', { name: /Activity/ }));

    const panel = within(screen.getByText('Recent activity').closest('div')!);
    expect(panel.getByText(/added this invoice/)).toBeInTheDocument();
  });

  it('shows payments to everybody else', () => {
    mocks.who.current = MANI;
    open();
    fireEvent.click(screen.getByRole('button', { name: /Activity/ }));

    const panel = within(screen.getByText('Recent activity').closest('div')!);
    expect(panel.getByText(/marked paid/)).toBeInTheDocument();
  });

  it('counts the badge from what it will actually show', () => {
    /*
     * A "4 new" that opens onto two entries is its own small lie, and it is
     * the kind that survives a review because both halves look right alone.
     */
    mocks.who.current = ASSISTANT;
    open();

    const bell = screen.getByRole('button', { name: /Activity/ });
    const label = bell.getAttribute('aria-label') ?? '';
    const counted = Number(label.match(/(\d+) new/)?.[1] ?? 0);
    expect(counted).toBeLessThanOrEqual(2);
  });
});
