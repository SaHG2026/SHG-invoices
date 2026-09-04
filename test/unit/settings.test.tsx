import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '@/components/ui/Toast';
import { BUSINESSES, PROFILES, SUPPLIERS, VENUE_PROFILE, makeInvoices } from '../fixtures/invoices';
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
  /* Who is signed in. Switched per test, so the venue branch can be reached. */
  who: null as unknown,
  updateNotify: vi.fn(),
  signOut: vi.fn(),
  clearAllLockState: vi.fn(),
  /* The device lock, driven from the test rather than from jsdom's crypto. */
  lock: { supported: true, set: false },
  /* What this device can do about push, likewise. */
  push: { support: 'off' as string },
  /* How many writes are still waiting, and whether there is signal. */
  queue: { queued: 0, online: true },
  resumePaused: vi.fn(),
  enablePush: vi.fn(),
  disablePush: vi.fn(),
}));

vi.mock('@/lib/pin', () => ({
  pinAvailable: () => mocks.lock.supported,
  hasPin: () => mocks.lock.set,
  clearAllLockState: mocks.clearAllLockState,
}));

vi.mock('@/lib/queries/session', () => ({
  useCurrentProfile: () => ({ data: mocks.who, isLoading: false, isError: false }),
  useProfiles: () => ({ data: PROFILES }),
  useTeam: () => ({ data: PROFILES.filter((person) => person.role !== 'builder') }),
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

vi.mock('@/lib/offline/pending', () => ({
  useQueuedWriteCount: () => mocks.queue.queued,
  useIsOnline: () => mocks.queue.online,
}));

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return { ...actual, useQueryClient: () => ({ resumePausedMutations: mocks.resumePaused }) };
});

vi.mock('@/lib/queries/push', () => ({
  usePushSupport: () => ({ data: mocks.push.support, isLoading: false }),
  useEnablePush: () => ({ mutateAsync: mocks.enablePush, isPending: false }),
  useDisablePush: () => ({ mutateAsync: mocks.disablePush, isPending: false }),
}));
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
  mocks.who = profile;
  mocks.push.support = 'off';
  mocks.queue.queued = 0;
  mocks.queue.online = true;
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
  const label = /Notify me when a new invoice is added/;

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

  it('promises only what it delivers', () => {
    /*
     * The label used to say "adds or pays". Being told about a payment is
     * Mani's alone now (ARCHITECTURE §26), so a switch claiming to cover it
     * would be a promise the app does not keep for anybody else.
     */
    open();
    expect(screen.getByLabelText(label)).toBeInTheDocument();
    expect(screen.queryByText(/pays an invoice/)).not.toBeInTheDocument();
  });
});

describe('the device lock', () => {
  it('offers to set a PIN when there is none on this device', async () => {
    open();
    expect(await screen.findByText(/No PIN on this device/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set a PIN' })).toBeInTheDocument();
  });

  it('says a PIN is already set, and offers to change it', async () => {
    mocks.lock.set = true;
    open();
    expect(await screen.findByText(/6-digit PIN set/)).toBeInTheDocument();
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
    expect(await screen.findByText(/it needs https/)).toBeInTheDocument();
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
    expect(screen.getByText(/clears the PIN on this device/)).toBeInTheDocument();
  });
});

describe('notifications on this device', () => {
  /*
   * ARCHITECTURE §28.4: build the capability, then stop. The client's
   * instruction is that adding the app to the Home Screen and turning push on
   * is theirs to decide, so nothing in the app asks for it. This is the only
   * place it can be turned on, and somebody who never opens Settings never
   * hears about it.
   */
  it('offers the switch on a device that can take it', () => {
    mocks.push.support = 'off';
    open();
    expect(screen.getByLabelText('Notify this device')).not.toBeChecked();
  });

  it('shows it already on where it is', () => {
    mocks.push.support = 'on';
    open();
    expect(screen.getByLabelText('Notify this device')).toBeChecked();
  });

  it('says what an iPhone needs, rather than offering a switch that cannot work', () => {
    // Apple's rule, not ours: a site in a Safari tab has no Push API at all.
    // Offering the switch anyway is how somebody comes to believe they are
    // being notified when they are not.
    mocks.push.support = 'needs-home-screen';
    open();
    expect(screen.getByText(/Add to Home Screen/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Notify this device')).not.toBeInTheDocument();
  });

  it('says where a blocked permission can be undone, because the app cannot', () => {
    mocks.push.support = 'denied';
    open();
    expect(screen.getByText(/blocked for this app/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Notify this device')).not.toBeInTheDocument();
  });

  it('says nothing at all where push is not available', () => {
    // No Push API and nothing the person could do about it. Notes §6: the
    // interface does not narrate what it cannot offer.
    mocks.push.support = 'unavailable';
    open();
    expect(screen.queryByLabelText('Notify this device')).not.toBeInTheDocument();
    expect(screen.queryByText(/Home Screen/)).not.toBeInTheDocument();
  });

  it('subscribes this device when switched on', () => {
    mocks.push.support = 'off';
    open();
    fireEvent.click(screen.getByLabelText('Notify this device'));
    expect(mocks.enablePush).toHaveBeenCalled();
  });

  it('unsubscribes this device when switched off', () => {
    mocks.push.support = 'on';
    open();
    fireEvent.click(screen.getByLabelText('Notify this device'));
    expect(mocks.disablePush).toHaveBeenCalled();
  });
});

describe('signing out with work still waiting', () => {
  /*
   * The finding this was written for: signing out clears the device,
   * including the queue on disk. Doing that silently means an invoice
   * disappears after the app promised to send it when the signal came back
   * — the one sentence this app must never say falsely.
   */
  it('signs out immediately when nothing is waiting', () => {
    mocks.queue.queued = 0;
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(mocks.signOut).toHaveBeenCalled();
  });

  it('asks first when something is still waiting, and does not sign out yet', () => {
    mocks.queue.queued = 1;
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(screen.getByText(/One invoice hasn/)).toBeInTheDocument();
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it('says plainly that waiting work is lost, and offers to wait instead', () => {
    mocks.queue.queued = 2;
    mocks.queue.online = false;
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(screen.getByText(/2 things haven/)).toBeInTheDocument();
    expect(screen.getByText(/anything still waiting is lost/)).toBeInTheDocument();
    expect(screen.getByText(/no signal/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Wait' })).toBeInTheDocument();
  });

  it('tries to send what is waiting before asking, when there is signal', () => {
    // The question usually answers itself: the queue drains while somebody
    // is reading it.
    mocks.queue.queued = 1;
    mocks.queue.online = true;
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(mocks.resumePaused).toHaveBeenCalled();
  });

  it('does not try to send when there is no signal', () => {
    mocks.queue.queued = 1;
    mocks.queue.online = false;
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(mocks.resumePaused).not.toHaveBeenCalled();
  });

  it('signs out when the person says to anyway', () => {
    mocks.queue.queued = 1;
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sign out anyway' }));
    expect(mocks.signOut).toHaveBeenCalled();
  });

  it('stays signed in when they choose to wait', () => {
    mocks.queue.queued = 1;
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    fireEvent.click(screen.getByRole('button', { name: 'Wait' }));
    expect(mocks.signOut).not.toHaveBeenCalled();
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


/* -------------------------------------------------------------------------- */

describe('a venue account', () => {
  beforeEach(() => {
    mocks.who = VENUE_PROFILE;
  });

  /**
   * CATCH_UP_010 §6 turned both push audiences into allowlists of `member` and
   * `owner`. A shop switching this on would set a flag no view reads, and no
   * notification would ever arrive — notes §6, do not offer what you cannot do.
   */
  it('is not offered notifications it can never receive', () => {
    open();
    expect(screen.queryByText(/Notify me when a new invoice is added/)).not.toBeInTheDocument();
    expect(screen.queryByText('Notifications')).not.toBeInTheDocument();
  });

  it('is described as a shared shop login, not as a person with a job title', () => {
    open();
    expect(screen.getByText(/Shop login/)).toBeInTheDocument();
    expect(screen.queryByText(/Sagarmatha Holdings/)).not.toBeInTheDocument();
  });

  /**
   * `VenueGate` would bounce a venue off `/`, so a back link pointing there
   * lands somewhere it did not name. It has to go where they came from.
   */
  it('goes back to its own screen, which is the only one it has', () => {
    open();
    const back = screen.getByRole('link', { name: /Invoices/ });
    expect(back).toHaveAttribute('href', '/venue');
  });

  it('is not shown the design tokens, which are a builder’s page', () => {
    open();
    expect(screen.queryByRole('link', { name: 'Design tokens' })).not.toBeInTheDocument();
  });

  it('can still sign out, set a PIN and change its password', () => {
    open();
    expect(screen.getByRole('button', { name: /Sign out/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /PIN/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change password' })).toBeInTheDocument();
  });
});

describe('everybody', () => {
  it('can change their own password', () => {
    open();
    expect(screen.getByRole('button', { name: 'Change password' })).toBeInTheDocument();
  });
});
