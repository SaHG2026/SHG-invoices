import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '@/components/ui/Toast';
import { BUSINESSES, PROFILES, SUPPLIERS, makeInvoices } from '../fixtures/invoices';
import type { Profile } from '@/lib/types';

/**
 * Settings.
 *
 * The switch on this screen is the first time anybody has been able to change
 * `notify_on_new_invoice`, which ARCHITECTURE §8.1 gave every person the right
 * to change and no screen ever offered.
 *
 * The test that matters most is the failure one. The database enforces this
 * with two mechanisms — an RLS policy for which row, a column grant for which
 * field — and if the grant is ever lost the update fails silently as far as
 * the eye is concerned. A checkbox that stays ticked after a failed save is a
 * lie about what the server holds, so the switch renders from the query and
 * never from local state.
 */

const profile = { ...PROFILES[0]!, notify_on_new_invoice: true } as Profile;

const mocks = vi.hoisted(() => ({
  updateNotify: vi.fn(),
  signOut: vi.fn(),
  clearAllLockState: vi.fn(),
  /* The device lock, driven from the test rather than from jsdom's crypto. */
  lock: { supported: true, set: false },
}));

vi.mock('@/lib/pin', () => ({
  pinAvailable: () => mocks.lock.supported,
  hasPin: () => mocks.lock.set,
  clearAllLockState: mocks.clearAllLockState,
}));

vi.mock('@/lib/queries/session', () => ({
  useCurrentProfile: () => ({ data: profile, isLoading: false, isError: false }),
  useProfiles: () => ({ data: PROFILES }),
  useSignOut: () => ({ mutate: mocks.signOut, isPending: false }),
  useUpdateNotifyPreference: () => ({ mutateAsync: mocks.updateNotify, isPending: false }),
}));

vi.mock('@/lib/queries/reference', () => ({
  useBusinesses: () => ({ data: BUSINESSES }),
  useSuppliers: () => ({ data: SUPPLIERS }),
  useCreateSupplier: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/lib/queries/invoices', () => ({
  useUnpaidInvoices: () => ({ data: makeInvoices(20), isLoading: false }),
  useCreateInvoice: () => ({ mutateAsync: vi.fn(), isPending: false }),
  findDuplicates: vi.fn(),
}));

vi.mock('@/lib/queries/detail', () => ({ useRecentActivity: () => ({ data: [] }) }));
vi.mock('next/navigation', () => ({ usePathname: () => '/settings' }));

const { SettingsScreen } = await import('@/components/screens/SettingsScreen');

function open() {
  return render(
    <ToastProvider>
      <SettingsScreen />
    </ToastProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.clearAllMocks();
  mocks.updateNotify.mockResolvedValue(profile);
  mocks.lock.supported = true;
  mocks.lock.set = false;
});

describe('who you are', () => {
  it('names the person and their role', () => {
    open();
    expect(screen.getByText('Mani')).toBeInTheDocument();
    expect(screen.getByText(/owner/)).toBeInTheDocument();
  });
});

describe('the notification switch', () => {
  const label = /Tell me when somebody adds or pays an invoice/;

  it('renders the stored preference', () => {
    open();
    expect(screen.getByLabelText(label)).toBeChecked();
  });

  it('saves a change against your own row', async () => {
    open();
    fireEvent.click(screen.getByLabelText(label));

    await waitFor(() => expect(mocks.updateNotify).toHaveBeenCalled());
    expect(mocks.updateNotify.mock.calls[0]![0]).toEqual({ id: profile.id, notify: false });
  });

  it('says so, and stays as it was, when the save fails', async () => {
    // If the column grant is ever lost this is what happens, and the switch
    // must not sit there looking saved.
    mocks.updateNotify.mockRejectedValue(new Error('permission denied'));
    open();
    fireEvent.click(screen.getByLabelText(label));

    expect(await screen.findByText(/It stays as it was/)).toBeInTheDocument();
    expect(screen.getByLabelText(label)).toBeChecked();
  });

  it('explains that the bell is unaffected either way', () => {
    // §8.1: push is a nudge, the in-app feed is the channel that actually
    // works. Turning the notification off must not read as turning the
    // information off.
    open();
    expect(screen.getByText(/Everything shows in the bell either way/)).toBeInTheDocument();
  });
});

describe('the device lock', () => {
  it('offers to set a PIN when there is none on this device', async () => {
    open();
    expect(await screen.findByText(/No PIN set on this device yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set a PIN' })).toBeInTheDocument();
  });

  it('says a PIN is already set, and offers to change it', async () => {
    mocks.lock.set = true;
    open();
    expect(await screen.findByText(/A 6-digit PIN unlocks this device/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change PIN' })).toBeInTheDocument();
  });

  it('clears the whole lock, not just the PIN, when changing it', async () => {
    /*
     * ARCHITECTURE §8: the PIN and the "already unlocked" flag are two halves
     * of one fact. The last time they had two owners, signing back in walked
     * straight past the lock — so this calls the one function that clears
     * both, never clearPin on its own.
     */
    mocks.lock.set = true;
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Change PIN' }));
    expect(mocks.clearAllLockState).toHaveBeenCalled();
  });

  it('says the PIN is skipped, and why, where it cannot be stored securely', async () => {
    // A plain http:// address on the shop wifi: crypto.subtle is undefined,
    // and a weaker hash that still felt like a lock would be worse than none.
    mocks.lock.supported = false;
    open();
    expect(await screen.findByText(/only be stored securely over https/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /PIN/ })).not.toBeInTheDocument();
  });
});

describe('signing out', () => {
  it('is here rather than hidden behind the header chip', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(mocks.signOut).toHaveBeenCalled();
  });

  it('says that it clears the PIN too', () => {
    // It does, and somebody handing the phone over should know that.
    open();
    expect(screen.getByText(/clears the PIN on this device too/)).toBeInTheDocument();
  });
});

describe('renders nothing broken — notes §6', () => {
  it('has no leaked placeholders', () => {
    const { container } = open();
    const text = container.textContent ?? '';
    for (const token of ['undefined', 'NaN', '[object Object]', 'Invalid Date']) {
      expect(text, `"${token}" leaked into settings`).not.toContain(token);
    }
  });
});
