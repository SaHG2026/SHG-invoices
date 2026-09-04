import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '@/components/ui/Toast';
import { MIN_PASSWORD_LENGTH } from '@/lib/constants';

/**
 * Changing your own password.
 *
 * ---------------------------------------------------------------------------
 * The test that earns its place is the first one.
 *
 * `supabase.auth.updateUser({ password })` needs a live session and nothing
 * else — it never asks what the old password was. ARCHITECTURE §8 states
 * plainly that an unlocked phone reaches the data, because the PIN is a UI
 * lock and the session cookie is there either way. Put those two facts
 * together and, without a re-authentication step, anybody holding an unlocked
 * phone can lock its owner out of their own account.
 *
 * That is a different order of problem from reading invoices, and the whole
 * reason this component asks for the current password. If somebody later
 * "simplifies" the form by dropping that field, this test is what says no.
 * ---------------------------------------------------------------------------
 */

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  signIn: vi.fn(),
  updateUser: vi.fn(),
}));

vi.mock('@/lib/supabase/browser', () => ({
  supabase: () => ({
    auth: {
      getUser: mocks.getUser,
      signInWithPassword: mocks.signIn,
      updateUser: mocks.updateUser,
    },
  }),
}));

const { PasswordChange } = await import('@/components/app/PasswordChange');

const GOOD = 'a-long-enough-one';

function open() {
  render(
    <ToastProvider>
      <PasswordChange />
    </ToastProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
}

function fill(fields: { current?: string; next?: string; confirm?: string }) {
  if (fields.current !== undefined) {
    fireEvent.change(screen.getByLabelText('Current password'), {
      target: { value: fields.current },
    });
  }
  if (fields.next !== undefined) {
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: fields.next } });
  }
  if (fields.confirm !== undefined) {
    fireEvent.change(screen.getByLabelText('New password again'), {
      target: { value: fields.confirm },
    });
  }
}

const submit = () => fireEvent.click(screen.getByRole('button', { name: /^Change password$/ }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({ data: { user: { email: 'mani@example.com' } } });
  mocks.signIn.mockResolvedValue({ error: null });
  mocks.updateUser.mockResolvedValue({ error: null });
});

describe('proving who is asking', () => {
  it('re-authenticates with the current password before changing anything', async () => {
    open();
    fill({ current: 'the-old-one', next: GOOD, confirm: GOOD });
    submit();

    await waitFor(() => expect(mocks.updateUser).toHaveBeenCalled());

    expect(mocks.signIn).toHaveBeenCalledWith({
      email: 'mani@example.com',
      password: 'the-old-one',
    });
    // Order matters: proving it, then changing it.
    expect(mocks.signIn.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.updateUser.mock.invocationCallOrder[0]!,
    );
  });

  it('changes nothing when the current password is wrong', async () => {
    mocks.signIn.mockResolvedValue({ error: { message: 'Invalid login credentials' } });
    open();
    fill({ current: 'not-it', next: GOOD, confirm: GOOD });
    submit();

    expect(await screen.findByText(/current password isn’t right/)).toBeInTheDocument();
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });

  /**
   * The email comes from the session, never from a field.
   *
   * Asking for it would let somebody re-authenticate as a different account
   * and then change THAT account's password using this session. Reading it
   * from `getUser()` means the only account this form can change is the one
   * already signed in.
   */
  it('takes the account from the live session, not from anything typed', () => {
    open();
    expect(screen.queryByLabelText(/email/i)).not.toBeInTheDocument();
  });

  it('says what to do when the session cannot name an account', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });
    open();
    fill({ current: 'x', next: GOOD, confirm: GOOD });
    submit();

    expect(await screen.findByText(/Sign out and back in/)).toBeInTheDocument();
    expect(mocks.signIn).not.toHaveBeenCalled();
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });
});

describe('the new password', () => {
  it('refuses one shorter than the floor, without asking the server', async () => {
    open();
    const short = 'a'.repeat(MIN_PASSWORD_LENGTH - 1);
    fill({ current: 'the-old-one', next: short, confirm: short });
    submit();

    expect(await screen.findByText(new RegExp(`at least ${MIN_PASSWORD_LENGTH}`))).toBeInTheDocument();
    expect(mocks.signIn).not.toHaveBeenCalled();
  });

  it('refuses a mistyped confirmation', async () => {
    open();
    fill({ current: 'the-old-one', next: GOOD, confirm: `${GOOD}x` });
    submit();

    expect(await screen.findByText(/don’t match/)).toBeInTheDocument();
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });

  it('refuses the password they already have', async () => {
    open();
    fill({ current: GOOD, next: GOOD, confirm: GOOD });
    submit();

    expect(await screen.findByText(/already have/)).toBeInTheDocument();
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });

  /**
   * Spec §8, and notes §6: name the cause. A refused change that says "an
   * error occurred" leaves somebody retyping the same thing.
   */
  it('passes the server’s own reason through when it refuses', async () => {
    mocks.updateUser.mockResolvedValue({ error: { message: 'Password is known to be weak.' } });
    open();
    fill({ current: 'the-old-one', next: GOOD, confirm: GOOD });
    submit();

    expect(await screen.findByText(/known to be weak/)).toBeInTheDocument();
  });
});

describe('what it promises', () => {
  /**
   * A shared shop login means the other device is somebody on the next shift,
   * possibly holding unsent invoices. ARCHITECTURE §32 is the whole story of
   * why signing them out is the wrong move — and saying so before it happens
   * matters, because it is not what people assume a password change does.
   */
  it('says other phones stay signed in, before anything is typed', () => {
    open();
    expect(screen.getByText(/Other phones already signed in stay signed in/)).toBeInTheDocument();
  });

  it('says plainly that nobody can read the password back', () => {
    open();
    expect(screen.getByText(/Nobody can see this password/)).toBeInTheDocument();
  });

  /**
   * The PIN locks this phone; the password establishes who you are. Two
   * different facts, and the last time two of those shared an owner, signing
   * back in walked straight past the lock.
   */
  it('confirms the PIN is untouched', async () => {
    open();
    fill({ current: 'the-old-one', next: GOOD, confirm: GOOD });
    submit();

    expect(await screen.findByText(/PIN on this phone is unchanged/)).toBeInTheDocument();
  });
});
