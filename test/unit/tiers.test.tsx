import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '@/components/ui/Toast';
import { BUSINESSES, PROFILES, SUPPLIERS, makeInvoice, makeInvoices } from '../fixtures/invoices';
import { isFullMember, isOwner, runsTheBusinesses } from '@/lib/staff';
import type { Profile } from '@/lib/types';

/**
 * The tiers. CATCH_UP_019, ARCHITECTURE §44.1.
 *
 * ===========================================================================
 * What this file is standing over, and what it is NOT.
 *
 * It is not the boundary. `is_owner()` inside `mark_invoices_paid`,
 * `unmark_invoice_paid`, `mark_sales_received`, `unmark_sales_received` and
 * `set_user_role` is, and it refuses with 42501 whatever any of these
 * components decide to render. If every assertion below were deleted, a
 * manager still could not mark a bill paid; they would simply be shown four
 * buttons that fail, which is notes §6 — do not offer what cannot be done.
 *
 * So what is asserted here is the OFFERING, in one file rather than scattered
 * through the five screens that do it. `member` becoming `manager` means every
 * allowlist has to be visited on purpose (HANDOFF §2's trap, in the direction
 * an allowlist fails), and the cheapest way to know that happened is one place
 * that names all five roles and says what each one is shown.
 * ===========================================================================
 */

const MANI = PROFILES[0]!;
const MILAN = PROFILES[1]!;
const RABINDRA = PROFILES[3]!;

const VENUE: Profile = {
  id: 'p-gmp',
  display_name: 'GroceryMate Parramatta',
  initials: 'GP',
  accent: 'person-1',
  role: 'staff',
  notify_on_new_invoice: false,
  reminder_time: null,
  title: null,
  active: true,
  business_id: 'b-gmp',
};

describe('the allowlists, as pure functions', () => {
  /*
   * Every role named, in both directions, because an allowlist's failure is
   * silent exclusion. Three of these once read `role <> 'builder'` and would
   * have admitted the venue accounts the day they existed; written the other
   * way round, they exclude whatever tier is added next. Naming all five here
   * means adding a sixth breaks a test rather than a person's access.
   */
  it('says who is one of the four', () => {
    expect(isFullMember(MANI)).toBe(true);
    expect(isFullMember(MILAN)).toBe(true);
    expect(isFullMember(RABINDRA)).toBe(true);
    expect(isFullMember(VENUE)).toBe(false);
    expect(isFullMember(null)).toBe(false);
  });

  it('says who may move money between paid and unpaid', () => {
    expect(isOwner(MANI)).toBe(true);
    // §44.2: owner powers, invisible in every list. Both halves are real.
    expect(isOwner(RABINDRA)).toBe(true);
    expect(isOwner(MILAN)).toBe(false);
    expect(isOwner(VENUE)).toBe(false);
  });

  it('answers false while the profile is still loading', () => {
    // Not a formality: `useCurrentProfile` returns undefined for a frame, and
    // the owner's controls appearing and then vanishing is the one direction
    // that must not flicker.
    expect(isOwner(null)).toBe(false);
    expect(isOwner(undefined)).toBe(false);
  });

  it('keeps the builder and the shops out of the list of people', () => {
    expect(runsTheBusinesses(MANI)).toBe(true);
    expect(runsTheBusinesses(MILAN)).toBe(true);
    expect(runsTheBusinesses(RABINDRA)).toBe(false);
    expect(runsTheBusinesses(VENUE)).toBe(false);
  });
});

/* ------------------------------------------------------------------------ *
   The screens. One knob — who is signed in — and the six mocks, because
   anything rendering AppChrome reaches the bell and the drawer badge.
 * ------------------------------------------------------------------------ */

const invoices = makeInvoices(12);
const unpaidInvoice = makeInvoice({ id: 'i-1', status: 'unpaid', invoice_number: 'INV-1' });
const paidInvoice = makeInvoice({
  id: 'i-2',
  status: 'paid',
  invoice_number: 'INV-2',
  paid_by: MANI.id,
});

const mocks = vi.hoisted(() => ({
  who: { current: null as unknown },
  invoice: { current: null as unknown },
  setRole: vi.fn(),
}));

vi.mock('@/lib/queries/session', () => ({
  useCurrentProfile: () => ({ data: mocks.who.current, isLoading: false, isError: false }),
  useProfiles: () => ({ data: PROFILES }),
  useTeam: () => ({ data: PROFILES.filter((person) => person.role !== 'builder') }),
  useSignOut: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateNotifyPreference: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateReminderTime: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSetUserRole: () => ({ mutateAsync: mocks.setRole, isPending: false }),
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

vi.mock('@/lib/queries/detail', () => ({
  useRecentActivity: () => ({ data: [] }),
  useInvoice: () => ({ data: mocks.invoice.current, isLoading: false }),
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

vi.mock('@/lib/queries/payments', () => ({
  useMarkPaid: () => ({
    mutateAsync: vi.fn().mockResolvedValue({ paid: [], missed: [] }),
    isPending: false,
  }),
  useUnmarkPaid: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useVoidInvoice: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/lib/queries/push', () => ({
  usePushSupport: () => ({ data: 'unsupported', isLoading: false }),
  useEnablePush: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDisablePush: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

/* Settings reaches for the client itself, to flush paused writes before it
   offers to sign out. There is none in a bare render. */
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return { ...actual, useQueryClient: () => ({ resumePausedMutations: vi.fn() }) };
});

vi.mock('next/navigation', () => ({ usePathname: () => '/settings' }));

const { WeekView } = await import('@/components/screens/WeekView');
const { InvoiceDetail } = await import('@/components/screens/InvoiceDetail');
const { SettingsScreen } = await import('@/components/screens/SettingsScreen');

function week() {
  return render(
    <ToastProvider>
      <WeekView scope="all" />
    </ToastProvider>,
  );
}

function detail() {
  return render(
    <ToastProvider>
      <InvoiceDetail id="i-1" />
    </ToastProvider>,
  );
}

function settings() {
  return render(
    <ToastProvider>
      <SettingsScreen />
    </ToastProvider>,
  );
}

/** Every tick on the week, however deep in a payment run it sits. */
function ticks(): HTMLElement[] {
  return screen.queryAllByRole('button', { name: /^Mark .+ paid$/ });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.clearAllMocks();
  mocks.who.current = MANI;
  mocks.invoice.current = unpaidInvoice;
  mocks.setRole.mockImplementation(async ({ id, role }: { id: string; role: string }) => ({
    ...PROFILES.find((person) => person.id === id)!,
    role,
  }));
});

describe('the week, as an owner and as a manager', () => {
  it('offers the tick to the owner', () => {
    week();
    expect(ticks().length).toBeGreaterThan(0);
  });

  it('offers it to nobody else', () => {
    // Absent, not disabled. A greyed tick on every row of the list somebody
    // opens most often is a screen apologising forty times.
    mocks.who.current = MILAN;
    week();
    expect(ticks()).toHaveLength(0);
  });

  it('still shows a manager what is owed, and to whom', () => {
    // The point of the tier is that a manager sees everything and settles
    // nothing. A screen that hid the money as well would be a different app.
    mocks.who.current = MILAN;
    week();
    expect(screen.getAllByRole('button', { name: /\$/ }).length).toBeGreaterThan(0);
  });
});

describe('one invoice, opened', () => {
  it('offers Mark paid to the owner', () => {
    detail();
    expect(screen.getByRole('button', { name: 'Mark paid' })).toBeInTheDocument();
  });

  it('does not offer it to a manager', () => {
    mocks.who.current = MILAN;
    detail();
    expect(screen.queryByRole('button', { name: 'Mark paid' })).not.toBeInTheDocument();
  });

  it('still offers Void to a manager', () => {
    /*
     * The one line of this phase worth reading twice.
     *
     * Voiding takes a bill out of every total, with a reason, and leaves it in
     * history struck through — it is correcting a mistake, which is a
     * manager's job. Marking paid asserts that money left the account, which
     * is the owner's. They look similar and they are not the same act.
     */
    mocks.who.current = MILAN;
    detail();
    expect(screen.getByRole('button', { name: 'Void' })).toBeInTheDocument();
  });

  it('does not offer a manager the way back from paid', () => {
    mocks.who.current = MILAN;
    mocks.invoice.current = paidInvoice;
    detail();
    expect(
      screen.queryByRole('button', { name: 'Put back to unpaid' }),
    ).not.toBeInTheDocument();
  });

  it('offers the owner the way back from paid', () => {
    mocks.invoice.current = paidInvoice;
    detail();
    expect(screen.getByRole('button', { name: 'Put back to unpaid' })).toBeInTheDocument();
  });
});

describe('who can do what', () => {
  function roleList() {
    return screen.getByText('Who can do what').closest('section')!;
  }

  it('is not shown to a manager at all', () => {
    // Every button on it would come back 42501: `set_user_role` refuses a
    // non-owner before it looks at anything else.
    mocks.who.current = MILAN;
    settings();
    expect(screen.queryByText('Who can do what')).not.toBeInTheDocument();
  });

  it('lists the people who run the businesses, and nobody else', () => {
    settings();
    const list = within(roleList());
    expect(list.getByText(/Milan/)).toBeInTheDocument();
    // §44.2: hidden from lists, honest about actions. `useTeam()` is the
    // allowlist, so the list and the function that refuses a builder row
    // agree by construction rather than by both remembering an exception.
    expect(list.queryByText(/Rabindra/)).not.toBeInTheDocument();
  });

  it('promotes somebody, after asking', () => {
    settings();
    fireEvent.click(within(roleList()).getAllByRole('button', { name: 'Make owner' })[0]!);

    const dialog = within(screen.getByRole('alertdialog'));
    expect(dialog.getByText(/mark bills paid/)).toBeInTheDocument();
    fireEvent.click(dialog.getByRole('button', { name: 'Make owner' }));

    return waitFor(() => {
      expect(mocks.setRole).toHaveBeenCalledWith({ id: MILAN.id, role: 'owner' });
    });
  });

  it('writes nothing if you go back', () => {
    settings();
    fireEvent.click(within(roleList()).getAllByRole('button', { name: 'Make owner' })[0]!);
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Go back' }));
    expect(mocks.setRole).not.toHaveBeenCalled();
  });

  it('will not offer to demote the only owner', () => {
    /*
     * Stated before the tap, unlike the other four refusals in
     * `set_user_role`. Those are conditions on rows that are not on this list
     * — a builder, a shop — so there is no button to leave out. This one is a
     * condition on a row that IS here, and "Make manager" on the only owner is
     * a button whose entire job is to fail.
     */
    settings();
    const list = within(roleList());
    expect(list.queryByRole('button', { name: 'Make manager' })).not.toBeInTheDocument();
    expect(list.getByText('The only owner')).toBeInTheDocument();
  });
});
