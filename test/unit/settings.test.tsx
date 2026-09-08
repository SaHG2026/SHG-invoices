import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '@/components/ui/Toast';
import { BUSINESSES, PROFILES, SUPPLIERS, VENUE_PROFILE, makeInvoices } from '../fixtures/invoices';
import type { Profile } from '@/lib/types';
import { WIPE_PHRASE } from '@/lib/queries/wipe';

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
  updateReminder: vi.fn(),
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
  setRole: vi.fn(),
  setDocument: vi.fn(),
  resumePaused: vi.fn(),
  enablePush: vi.fn(),
  disablePush: vi.fn(),
  /* J4's export. Mocked so the screen can be rendered without a session --
     what it reads is tested in export.test.ts, against the bytes. */
  runExport: vi.fn(),
  /* J4's wipe. Rule 5's one exception, so the mock is the only thing any
     test is allowed to reach. */
  wipe: vi.fn(),
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
  useUpdateReminderTime: () => ({ mutateAsync: mocks.updateReminder, isPending: false }),
  useSetUserRole: () => ({ mutateAsync: mocks.setRole, isPending: false }),
}));

vi.mock('@/lib/queries/reference', () => ({
  useBusinesses: () => ({ data: BUSINESSES }),
  useSuppliers: () => ({ data: SUPPLIERS }),
  useCreateSupplier: () => ({ mutateAsync: vi.fn(), isPending: false }),
  /* Settings edits what goes on an issued invoice, so anything that renders
     it reaches this. CATCH_UP_020. */
  useSetBusinessDocument: () => ({ mutateAsync: mocks.setDocument, isPending: false }),
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

/*
 * The sixth mock. HANDOFF §5's "mock all five" is now six: the drawer's Review
 * badge and the dashboard's Review card both read `useAwaitingReview`, and
 * AppChrome puts the drawer within reach of every screen — so a file that
 * mocks only what it thinks it needs passes alone and fails in the suite.
 */
vi.mock('@/lib/queries/review', () => ({
  useAwaitingReview: () => ({ data: [], isLoading: false }),
  useReviewNotes: () => ({ data: {} }),
  useApproveInvoices: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useReassignSupplier: () => ({ mutateAsync: vi.fn(), isPending: false }),
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

vi.mock('@/lib/export/run', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/export/run')>();
  /* `rangeIsUsable` stays real -- it is the thing deciding whether the button
     is offered, and a mocked predicate would test the mock. */
  return { ...actual, runExport: mocks.runExport };
});

vi.mock('@/lib/queries/wipe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/queries/wipe')>();
  /* `WIPE_PHRASE` stays real. The field compares against the same constant the
     RPC is called with, and a mocked phrase would test the mock. */
  return { ...actual, useWipeEverything: () => ({ mutateAsync: mocks.wipe, isPending: false }) };
});

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
  mocks.updateReminder.mockResolvedValue(profile);
  mocks.lock.supported = true;
  mocks.lock.set = false;
});

describe('who you are', () => {
  it('names the person and their job, not their role', () => {
    /*
     * It said "owner" for two of the four and nothing for the other two —
     * a permission leaking into a place that wanted a job title. `role`
     * could never have carried this: Milan and Sujan are both managers.
     *
     * Scoped to the identity card, because the word is legitimate elsewhere
     * on this screen now: "Who can do what" is ABOUT the roles, and says so.
     * The rule was never "never print the word", it is that the line under
     * somebody's name is their job.
     */
    open();
    const whoYouAre = within(screen.getByText('Mani').closest('section')!);
    expect(whoYouAre.getByText(/CEO/)).toBeInTheDocument();
    expect(whoYouAre.queryByText(/owner/i)).not.toBeInTheDocument();
  });

  it('says only the company when somebody has no title yet', () => {
    // Unremarkable, not junior. A missing title must not read as a demotion.
    mocks.who = { ...profile, title: null };
    open();
    expect(screen.getByText('Sagarmatha Holdings')).toBeInTheDocument();
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

describe('the daily reminder', () => {
  /*
   * "An option to send the managements an alert at a time of their choosing,
   * as a reminder to check today's invoices."
   *
   * Null is off and the field is the switch — there is no separate checkbox,
   * because a time plus an enabled flag is two values describing three states
   * when two are real, and the pair can disagree.
   */
  const field = () => screen.getByLabelText(/Remind me to check/) as HTMLInputElement;

  it('is off, and says so, when no time has been chosen', () => {
    open();
    expect(field().value).toBe('');
    expect(screen.getByText(/Off\. Set a time/)).toBeInTheDocument();
  });

  it('saves the time as a plain string, never a date', () => {
    open();
    fireEvent.change(field(), { target: { value: '08:30' } });
    expect(mocks.updateReminder).toHaveBeenCalledWith({ id: profile.id, time: '08:30' });
  });

  it('reads the chosen time back the way the rest of the app writes times', () => {
    mocks.who = { ...profile, reminder_time: '08:30' };
    open();
    expect(field().value).toBe('08:30');
    expect(screen.getByText(/Every day at 8:30am, Sydney time/)).toBeInTheDocument();
  });

  it('turns off by clearing the field, with null and not an empty string', () => {
    // The column means "off" by being null. Sending '' would be a time
    // Postgres refuses, and the switch would look set and do nothing.
    mocks.who = { ...profile, reminder_time: '08:30' };
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    expect(mocks.updateReminder).toHaveBeenCalledWith({ id: profile.id, time: null });
  });

  it('offers no Turn off when there is nothing to turn off', () => {
    open();
    expect(screen.queryByRole('button', { name: 'Turn off' })).not.toBeInTheDocument();
  });

  it('sends nothing for a value that is not a real time', () => {
    // A browser reporting '8:5' would otherwise store something nothing reads.
    open();
    fireEvent.change(field(), { target: { value: '8:5' } });
    expect(mocks.updateReminder).not.toHaveBeenCalled();
  });

  it('says it stays as it was when the write is refused', async () => {
    mocks.updateReminder.mockRejectedValue(new Error('permission denied'));
    open();
    fireEvent.change(field(), { target: { value: '08:30' } });
    await screen.findByText(/It stays as it was/);
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
    // The reminder lives in that section, so it goes with it — and the loop in
    // CATCH_UP_014 §3 is an allowlist that excludes staff anyway. Two
    // mechanisms, neither relying on the other.
    expect(screen.queryByLabelText(/Remind me to check/)).not.toBeInTheDocument();
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


/* -------------------------------------------------------------------------- *
 * The wipe. J4, ARCHITECTURE §49.5 — rule 5's one exception.
 * -------------------------------------------------------------------------- */

describe('the wipe', () => {
  const opener = /Clear all records/;

  function start() {
    open();
    fireEvent.click(screen.getByRole('button', { name: opener }));
  }

  it('is not offered to a manager', () => {
    // `wipe_everything` refuses anybody but an owner with 42501, so four steps
    // ending in a refusal is notes §6 failing at the worst possible moment.
    mocks.who = PROFILES.find((person) => person.role === 'manager')!;
    open();
    expect(screen.queryByRole('button', { name: opener })).not.toBeInTheDocument();
  });

  it('is not offered to a shop', () => {
    mocks.who = VENUE_PROFILE;
    open();
    expect(screen.queryByRole('button', { name: opener })).not.toBeInTheDocument();
  });

  it('renders outside the screen, so a transform cannot capture it', () => {
    /*
     * `<main class="screen-in">` keeps an identity transform after its
     * animation finishes, and an element with a transform is a containing
     * block for `position: fixed` children — so a dialog written inside a
     * screen is fixed to the PAGE and scrolls with it. On Settings that put it
     * hundreds of pixels below the fold.
     *
     * jsdom does no layout and can never see that. What it can see is the
     * structural fact underneath it, which is what this asserts. §45.
     */
    start();
    expect(screen.getByRole('alertdialog').closest('main')).toBeNull();
  });

  it('leads with what it cannot reach, not with what it deletes', () => {
    /*
     * RESET_TO_CLEAN_SLATE.sql spends its first screen on other phones' unsent
     * work, and that was the right thing to lead with: the queue does not know
     * the wipe happened and will send afterwards.
     */
    start();
    expect(screen.getByText(/cannot reach anybody else/)).toBeInTheDocument();
  });

  it('refuses outright while this phone still has something to send', () => {
    // The only hard stop in the four steps. That work would be destroyed with
    // no record of it anywhere.
    mocks.queue.queued = 2;
    start();
    expect(screen.getByText(/2 things on this phone haven’t sent yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });

  it('refuses offline, and says which of the two problems it is', () => {
    mocks.queue.online = false;
    start();
    expect(screen.getByText(/no signal/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });

  it('will not go on until the phrase is typed exactly', () => {
    start();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    const field = screen.getByLabelText('Confirmation phrase');
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();

    // Case matters, and so does the whole phrase. The database checks the same
    // string again (CATCH_UP_021 §1).
    fireEvent.change(field, { target: { value: 'wipe everything' } });
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();

    fireEvent.change(field, { target: { value: 'Wipe' } });
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();

    fireEvent.change(field, { target: { value: WIPE_PHRASE } });
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  function reachTheOffer() {
    start();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.change(screen.getByLabelText('Confirmation phrase'), {
      target: { value: WIPE_PHRASE },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  }

  it('offers the export before it offers the wipe', () => {
    /*
     * Third of the four, and the order is not arrangement: offered first it
     * reads as a step in a form and gets tapped past. Here it is the last
     * thing between somebody and an empty database.
     */
    reachTheOffer();
    expect(screen.getByText(/no backups/)).toBeInTheDocument();
    /*
     * "everything", with no date range on it. The range picker lived here for
     * one draft and offered a CHOICE of period directly above a button that
     * deletes every period -- a mistake the screen would have helped somebody
     * make. It also put two identical forms in the document.
     */
    /* Scoped to the sheet: Settings' own export section is still behind it,
       with fields of the same name. HANDOFF 5's collision. */
    const sheet = within(screen.getByRole('alertdialog'));
    expect(sheet.getByRole('button', { name: /Prepare a copy of everything/ })).toBeInTheDocument();
    expect(sheet.queryByLabelText('Export from')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear everything' })).not.toBeInTheDocument();
  });

  it('needs declining the copy to be its own tap', () => {
    // Naming it "Skip" would let somebody past without reading the sentence.
    reachTheOffer();
    fireEvent.click(screen.getByRole('button', { name: /I don’t need a copy/ }));
    expect(screen.getByRole('button', { name: 'Clear everything' })).toBeInTheDocument();
    expect(mocks.wipe).not.toHaveBeenCalled();
  });

  it('clears, and says what was there', async () => {
    // The counts come from the database, taken before the deletes. They are
    // the only receipt anybody gets — afterwards there is nothing to count.
    mocks.wipe.mockResolvedValue({
      invoices: 412,
      sales_invoices: 37,
      suppliers: 19,
      customers: 8,
      products: 1,
    });
    reachTheOffer();
    fireEvent.click(screen.getByRole('button', { name: /I don’t need a copy/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear everything' }));

    expect(await screen.findByText(/The records are cleared/)).toBeInTheDocument();
    expect(screen.getByText('412 bills')).toBeInTheDocument();
    expect(screen.getByText('37 invoices Deli issued')).toBeInTheDocument();
    expect(screen.getByText('1 product')).toBeInTheDocument();
  });

  it('shows the database’s own sentence when it is refused', async () => {
    // All the refusals in `wipe_everything` are written to be read by a
    // person; a house message would replace a specific reason with a vague one.
    mocks.wipe.mockRejectedValue(new Error('Only the owner can clear the records.'));
    reachTheOffer();
    fireEvent.click(screen.getByRole('button', { name: /I don’t need a copy/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear everything' }));

    expect(await screen.findByText('Only the owner can clear the records.')).toBeInTheDocument();
  });
});


/* -------------------------------------------------------------------------- *
 * Export. J4, ARCHITECTURE §49.
 * -------------------------------------------------------------------------- */

function csv(name: string): File {
  return new File(['a,b'], name, { type: 'text/csv;charset=utf-8' });
}

describe('export', () => {
  const prepare = /Prepare export/;

  it('is offered to a manager as well as an owner', () => {
    /*
     * Every row in these files is a row a manager can already read on a
     * screen, so making it owner-only would be a permission invented by the
     * interface rather than one the database holds.
     */
    mocks.who = PROFILES.find((person) => person.role === 'manager')!;
    open();
    expect(screen.getByRole('button', { name: prepare })).toBeInTheDocument();
  });

  it('is not offered to a shop', () => {
    // A venue reads its own invoices through `staff_invoices` and nothing
    // else, so this would produce three files, two empty and one short.
    mocks.who = VENUE_PROFILE;
    open();
    expect(screen.queryByRole('button', { name: prepare })).not.toBeInTheDocument();
  });

  it('says which date it goes by', () => {
    // An export nobody can describe is an export nobody can check.
    open();
    expect(screen.getByText(/date on the invoice, not the date it falls due/)).toBeInTheDocument();
  });

  it('refuses a backwards range before it is run, and says why', () => {
    // An empty file reads as "there was no business that month".
    open();
    fireEvent.change(screen.getByLabelText('Export from'), { target: { value: '2026-02-01' } });
    fireEvent.change(screen.getByLabelText('Export to'), { target: { value: '2026-01-01' } });

    expect(screen.getByText(/wrong way round/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: prepare })).toBeDisabled();
    expect(mocks.runExport).not.toHaveBeenCalled();
  });

  it('cannot be run offline, and says what that means', () => {
    mocks.queue.online = false;
    open();
    expect(screen.getByRole('button', { name: prepare })).toBeDisabled();
    expect(screen.getByText(/only export what it can re-read/)).toBeInTheDocument();
  });

  it('asks for everything when neither date is filled in', async () => {
    // Null is "no bound", not today and not the first invoice ever entered.
    mocks.runExport.mockResolvedValue({
      files: [csv('a.csv'), csv('b.csv'), csv('c.csv')],
      counts: { bills: 0, sales: 0, lines: 0 },
    });
    open();
    fireEvent.click(screen.getByRole('button', { name: prepare }));

    await waitFor(() => expect(mocks.runExport).toHaveBeenCalledWith({ from: null, to: null }));
  });

  it('shows each file with its row count before anything is saved', async () => {
    /*
     * The counts are the only chance somebody gets to notice that the period
     * they typed was not the period they meant.
     */
    mocks.runExport.mockResolvedValue({
      files: [
        csv('shg-bills-everything.csv'),
        csv('shg-deli-invoices-everything.csv'),
        csv('shg-deli-invoice-lines-everything.csv'),
      ],
      counts: { bills: 412, sales: 37, lines: 189 },
    });
    open();
    fireEvent.click(screen.getByRole('button', { name: prepare }));

    /*
      * The row is headed by what the file IS, not by what it is called. Two of
      * the three filenames truncate at 375px, and they truncate inside the
      * date range -- the only part that tells two exports apart.
      */
    const name = await screen.findByText('Bills');
    expect(screen.getByText(/412 bills/)).toBeInTheDocument();
    expect(screen.getByText(/37 invoices Deli issued/)).toBeInTheDocument();
    expect(screen.getByText(/189 lines on those invoices/)).toBeInTheDocument();
    /* Scoped, because the owner's invoice-document form has a Save of its own
       and HANDOFF 5's accessible-name collision is exactly this. */
    const files = within(name.closest('section')!);
    expect(files.getAllByRole('button', { name: 'Save' })).toHaveLength(3);
  });

  it('says zero out loud rather than dropping the row', async () => {
    // A missing file cannot be told apart from a failed one.
    mocks.runExport.mockResolvedValue({
      files: [csv('a.csv'), csv('b.csv'), csv('c.csv')],
      counts: { bills: 0, sales: 0, lines: 0 },
    });
    open();
    fireEvent.click(screen.getByRole('button', { name: prepare }));

    const zero = await screen.findByText(/0 bills/);
    expect(within(zero.closest('section')!).getAllByRole('button', { name: 'Save' })).toHaveLength(
      3,
    );
  });

  it('shows the reason when the range is too wide, not a house message', async () => {
    // A refused answer can be narrowed; a short file gets kept.
    mocks.runExport.mockRejectedValue(new Error('That range covers more than 20,000 bills. Choose a shorter period.'));
    open();
    fireEvent.click(screen.getByRole('button', { name: prepare }));

    expect(await screen.findByText(/more than 20,000 bills/)).toBeInTheDocument();
  });

  it('offers no Share button where the browser cannot take a file', async () => {
    // §48.2: never a dead button. jsdom has no `navigator.share`.
    mocks.runExport.mockResolvedValue({
      files: [csv('a.csv'), csv('b.csv'), csv('c.csv')],
      counts: { bills: 1, sales: 0, lines: 0 },
    });
    open();
    fireEvent.click(screen.getByRole('button', { name: prepare }));

    await screen.findByText('Bills');
    expect(screen.queryByRole('button', { name: 'Share' })).not.toBeInTheDocument();
  });
});


/* ------------------------------------------------------------------------ *
   Not a test. A way to look at the screen. ARCHITECTURE 21.6.

   Settings grew a list of people with a control against each name, and a
   name plus a pill on a 375px phone is exactly the kind of thing that reads
   correctly in an assertion and wraps badly on glass. jsdom does no layout,
   so nothing above this line can see that (HANDOFF 6).
 * ------------------------------------------------------------------------ */

const OUT = process.env.PREVIEW_OUT ?? '';
const CSS = process.env.PREVIEW_CSS ?? '';

describe('preview', () => {
  async function write(name: string, html: string) {
    const { readFileSync, writeFileSync } = await import('node:fs');
    const css = CSS ? readFileSync(CSS, 'utf8') : '';
    writeFileSync(
      name,
      `<!doctype html><html lang="en-AU"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Settings preview</title>
<style>${css}</style>
<style>body{background:var(--page);margin:0}</style>
</head><body>${html}</body></html>`,
      'utf8',
    );
  }

  it.skipIf(!OUT)('snapshot', async () => {
    mocks.who = profile;
    const view = open();
    const html = view.container.innerHTML;
    view.unmount();
    await write(OUT, html);
  });

  /*
   * A second page, with the export's files on it.
   *
   * The first page cannot show them -- they only exist after somebody has
   * pressed Prepare -- and the row they render into is the one thing on this
   * screen that could go wrong on glass and pass every assertion above: a
   * filename carrying a date range, next to two pill buttons, on a 375px
   * phone. jsdom does no layout, so nothing here can see that; this is what
   * gets looked at. HANDOFF 5.
   */
  /*
   * The wipe's four steps, each written out.
   *
   * These are dialogs full of prose on a 375px phone, and the last thing
   * anybody wants is a warning that scrolls out of sight above a Continue
   * button. jsdom does no layout (HANDOFF 5), so this is the only way to
   * find that.
   */
  it.skipIf(!OUT)('snapshot of each wipe step', async () => {
    mocks.who = profile;
    mocks.wipe.mockResolvedValue({
      invoices: 412,
      sales_invoices: 37,
      suppliers: 19,
      customers: 8,
      products: 1,
    });

    const view = open();
    /* `document.body`, not the container: the sheets are portalled out of the
       screen so that `<main class="screen-in">` cannot become their containing
       block. A container snapshot would be a page with no dialog on it. */
    const stem = OUT.replace(/\.html$/, '');

    fireEvent.click(screen.getByRole('button', { name: /Clear all records/ }));
    await write(`${stem}-wipe-1.html`, document.body.innerHTML);

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await write(`${stem}-wipe-2.html`, document.body.innerHTML);

    fireEvent.change(screen.getByLabelText('Confirmation phrase'), {
      target: { value: WIPE_PHRASE },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await write(`${stem}-wipe-3.html`, document.body.innerHTML);

    fireEvent.click(screen.getByRole('button', { name: /I don’t need a copy/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear everything' }));
    await screen.findByText(/The records are cleared/);
    await write(`${stem}-wipe-4.html`, document.body.innerHTML);

    view.unmount();
  });

  it.skipIf(!OUT)('snapshot with the files prepared', async () => {
    mocks.who = profile;
    mocks.runExport.mockResolvedValue({
      files: [
        csv('shg-bills-2026-07-01_2026-07-31.csv'),
        csv('shg-deli-invoices-2026-07-01_2026-07-31.csv'),
        csv('shg-deli-invoice-lines-2026-07-01_2026-07-31.csv'),
      ],
      counts: { bills: 412, sales: 37, lines: 189 },
    });

    const view = open();
    fireEvent.click(screen.getByRole('button', { name: /Prepare export/ }));
    await screen.findByText('Bills');

    const html = view.container.innerHTML;
    view.unmount();
    await write(OUT.replace(/\.html$/, '-export.html'), html);
  });
});
