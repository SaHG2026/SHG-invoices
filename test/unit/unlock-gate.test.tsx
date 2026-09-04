import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Profile } from '@/lib/types';

/**
 * The gate has now produced two bugs, both of which let the PIN itself work
 * perfectly while the screen refused to move on. Neither was catchable by
 * looking at the PIN logic, because neither was in it.
 *
 * These walk the whole gate the way a person does.
 */

const profile: Profile = {
  id: 'p-rabindra',
  display_name: 'Rabindra',
  initials: 'RA',
  accent: '#12384B',
  role: 'owner',
  notify_on_new_invoice: true,
  active: true,
  business_id: null,
};

const pin = vi.hoisted(() => ({
  pinAvailable: vi.fn(() => true),
  hasPin: vi.fn(() => false),
  setPin: vi.fn(async () => {}),
  verifyPin: vi.fn(async () => ({ ok: true, attemptsLeft: 5, lockedOut: false })),
  clearPin: vi.fn(),
  isUnlocked: vi.fn(() => false),
  markUnlocked: vi.fn(),
  clearAllLockState: vi.fn(),
}));

const session = vi.hoisted(() => ({
  useCurrentProfile: vi.fn(),
  useSignOut: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
}));

vi.mock('@/lib/pin', () => pin);
vi.mock('@/lib/queries/session', () => session);

const { UnlockGate } = await import('@/components/auth/UnlockGate');

function type(digits: string) {
  for (const digit of digits) {
    fireEvent.click(screen.getByRole('button', { name: digit }));
  }
}

function renderGate() {
  return render(
    <UnlockGate>
      <div data-testid="app">The invoices</div>
    </UnlockGate>,
  );
}

beforeEach(() => {
  sessionStorage.clear();
  vi.clearAllMocks();
  pin.pinAvailable.mockReturnValue(true);
  pin.hasPin.mockReturnValue(false);
  pin.setPin.mockResolvedValue(undefined);
  pin.verifyPin.mockResolvedValue({ ok: true, attemptsLeft: 5, lockedOut: false });
  pin.isUnlocked.mockReturnValue(false);
  session.useCurrentProfile.mockReturnValue({
    data: profile,
    isLoading: false,
    isError: false,
  });
});

/*
 * These three set or verify a real PIN, which is PBKDF2 at 150,000 iterations
 * (lib/pin.ts) — deliberately slow, because that is what makes the hash worth
 * having. Two of them do it twice. Against vitest's 5s default that passes on
 * a quiet machine and fails on a busy one, and a suite that fails at random is
 * one nobody trusts enough to act on. The work is bounded and known, so the
 * timeout is raised to match it rather than the iterations lowered to fit.
 */
const SLOW_HASH_MS = 20_000;

describe('setting a PIN for the first time', () => {
  it('asks twice, then lets you through', async () => {
    renderGate();

    expect(await screen.findByText(/Choose a 6-digit PIN/)).toBeInTheDocument();
    type('123456');

    // The confirmation step must actually happen.
    expect(await screen.findByText('Enter it again')).toBeInTheDocument();
    expect(pin.setPin).not.toHaveBeenCalled();

    type('123456');

    // The bug this test exists for: the PIN saved, but the screen stayed on
    // the setup interface because "needs a PIN" was never cleared.
    expect(await screen.findByTestId('app')).toBeInTheDocument();
    expect(pin.setPin).toHaveBeenCalledWith(profile.id, '123456');
  }, SLOW_HASH_MS);

  it('rejects a second entry that does not match, and starts over', async () => {
    renderGate();

    await screen.findByText(/Choose a 6-digit PIN/);
    type('123456');
    await screen.findByText('Enter it again');
    type('654321');

    expect(await screen.findByRole('alert')).toHaveTextContent(/didn’t match/);
    expect(pin.setPin).not.toHaveBeenCalled();
    // Back to the first step, not stuck on the confirm step.
    expect(screen.getByText(/Choose a 6-digit PIN/)).toBeInTheDocument();
  }, SLOW_HASH_MS);

  it('lets you through when you skip', async () => {
    renderGate();

    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));

    expect(await screen.findByTestId('app')).toBeInTheDocument();
    expect(pin.setPin).not.toHaveBeenCalled();
  });

  it('does not strand you when saving the PIN fails', async () => {
    pin.setPin.mockRejectedValue(new Error('storage full'));
    renderGate();

    await screen.findByText(/Choose a 6-digit PIN/);
    type('123456');
    await screen.findByText('Enter it again');
    type('123456');

    expect(await screen.findByRole('alert')).toHaveTextContent(/Couldn’t save the PIN/);
    // Still usable: back at step one rather than frozen.
    expect(screen.getByText(/Choose a 6-digit PIN/)).toBeInTheDocument();
  }, SLOW_HASH_MS);
});

describe('unlocking with an existing PIN', () => {
  beforeEach(() => pin.hasPin.mockReturnValue(true));

  it('shows the pad, then the app once the PIN is right', async () => {
    renderGate();

    expect(await screen.findByText('Enter your PIN')).toBeInTheDocument();
    expect(screen.queryByTestId('app')).not.toBeInTheDocument();

    type('123456');

    expect(await screen.findByTestId('app')).toBeInTheDocument();
    expect(pin.verifyPin).toHaveBeenCalledWith(profile.id, '123456');
  });

  it('counts a wrong PIN once, not twice', async () => {
    pin.verifyPin.mockResolvedValue({ ok: false, attemptsLeft: 4, lockedOut: false });
    renderGate();

    await screen.findByText('Enter your PIN');
    type('999999');

    expect(await screen.findByRole('alert')).toHaveTextContent('4 tries left');
    // One entry is one attempt. The old pad fired completion twice.
    await waitFor(() => expect(pin.verifyPin).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('app')).not.toBeInTheDocument();
  });

  it('warns in the singular on the last try', async () => {
    pin.verifyPin.mockResolvedValue({ ok: false, attemptsLeft: 1, lockedOut: false });
    renderGate();

    await screen.findByText('Enter your PIN');
    type('999999');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'One more try before you need your password',
    );
  });

  it('goes straight through when already unlocked this session', async () => {
    pin.isUnlocked.mockReturnValue(true);
    renderGate();

    // Already unlocked this session: straight through, no pad.
    expect(await screen.findByTestId('app')).toBeInTheDocument();
    expect(pin.verifyPin).not.toHaveBeenCalled();
  });
});

describe('when the browser cannot hash a PIN', () => {
  it('says so and lets you through rather than pretending to lock', async () => {
    pin.pinAvailable.mockReturnValue(false);
    renderGate();

    expect(await screen.findByTestId('app')).toBeInTheDocument();
    expect(screen.getByText(/Quick unlock is off on this address/)).toBeInTheDocument();
  });
});

describe('when the account has no active profile', () => {
  it('explains instead of showing an empty app', async () => {
    session.useCurrentProfile.mockReturnValue({ data: null, isLoading: false, isError: false });
    renderGate();

    expect(await screen.findByText('This account is not active')).toBeInTheDocument();
    expect(screen.queryByTestId('app')).not.toBeInTheDocument();
  });
});
