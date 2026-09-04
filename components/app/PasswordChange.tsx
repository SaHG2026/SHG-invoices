'use client';

import { useState } from 'react';
import { supabase } from '@/lib/supabase/browser';
import { useToast } from '@/components/ui/Toast';
import { MIN_PASSWORD_LENGTH } from '@/lib/constants';

/**
 * Changing your own password, from inside the app.
 *
 * ---------------------------------------------------------------------------
 * The current password is required, and that is not a formality.
 *
 * `supabase.auth.updateUser({ password })` needs only a live session. It does
 * not ask what the old password was. So without the re-authentication below,
 * anybody holding an unlocked phone could set a new password and lock the real
 * owner out of their own account — and ARCHITECTURE §8 already states plainly
 * that an unlocked phone reaches the data, because the PIN is a UI lock and
 * the session cookie is present either way.
 *
 * That was an acceptable trade when the worst case was reading invoices. It is
 * not one when the worst case is account takeover, and the fix costs one
 * field.
 *
 * `signInWithPassword` is the re-authentication. Supabase's own
 * `reauthenticate()` is not usable here: it emails a nonce, and two of the six
 * accounts are shops with no mailbox anybody reads.
 * ---------------------------------------------------------------------------
 *
 * Two things this deliberately does NOT do:
 *
 *   * It does not sign out other devices. Supabase can, and for a personal
 *     account it would be right. These are shared shop logins, and the other
 *     device is somebody on the next shift who may be holding unsent invoices
 *     — ARCHITECTURE §32 is the whole story of why that matters.
 *   * It does not touch the PIN. The PIN locks this phone; the password
 *     establishes who you are. They are different facts and the last time two
 *     of those shared an owner, signing back in walked straight past the lock.
 */
export function PasswordChange() {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function reset() {
    setCurrent('');
    setNext('');
    setConfirm('');
    setError(null);
    setOpen(false);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (next.length < MIN_PASSWORD_LENGTH) {
      setError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (next !== confirm) {
      setError('Those two don’t match.');
      return;
    }
    if (next === current) {
      setError('That is the password you already have.');
      return;
    }

    setBusy(true);
    const client = supabase();

    /*
     * The email comes from the live session rather than a field.
     *
     * Asking for it would let somebody re-authenticate as a different account
     * and then change THAT account's password using this session. Reading it
     * from `getUser()` means the only account this form can ever change is the
     * one already signed in.
     */
    const {
      data: { user },
    } = await client.auth.getUser();

    if (!user?.email) {
      setBusy(false);
      setError('Couldn’t confirm who you are signed in as. Sign out and back in, then try again.');
      return;
    }

    const { error: wrongPassword } = await client.auth.signInWithPassword({
      email: user.email,
      password: current,
    });

    if (wrongPassword) {
      setBusy(false);
      // Named, not "authentication failed" (spec §8). This is the one error
      // here that a person can actually do something about.
      setError('That current password isn’t right.');
      return;
    }

    const { error: updateFailed } = await client.auth.updateUser({ password: next });
    setBusy(false);

    if (updateFailed) {
      setError(
        updateFailed.message.trim() === ''
          ? 'Couldn’t change the password. Nothing was changed.'
          : updateFailed.message,
      );
      return;
    }

    reset();
    toast.show('Password changed. Your PIN on this phone is unchanged.');
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="touch flex w-full items-center text-left text-sm text-action"
      >
        Change password
      </button>
    );
  }

  const fieldClass =
    'touch w-full rounded-sm border border-hairline bg-card px-3 text-base text-ink outline-none focus:border-action';

  return (
    <form onSubmit={submit} className="mt-1">
      <label className="mb-1 block text-xs uppercase tracking-widest text-muted" htmlFor="pw-current">
        Current password
      </label>
      <input
        id="pw-current"
        type="password"
        autoComplete="current-password"
        value={current}
        onChange={(event) => setCurrent(event.target.value)}
        className={`${fieldClass} mb-3`}
      />

      <label className="mb-1 block text-xs uppercase tracking-widest text-muted" htmlFor="pw-next">
        New password
      </label>
      <input
        id="pw-next"
        type="password"
        autoComplete="new-password"
        value={next}
        onChange={(event) => setNext(event.target.value)}
        className={`${fieldClass} mb-3`}
      />

      <label className="mb-1 block text-xs uppercase tracking-widest text-muted" htmlFor="pw-confirm">
        New password again
      </label>
      <input
        id="pw-confirm"
        type="password"
        autoComplete="new-password"
        value={confirm}
        onChange={(event) => setConfirm(event.target.value)}
        className={fieldClass}
      />

      {error ? (
        <p role="alert" className="mt-2 text-sm text-overdue">
          {error}
        </p>
      ) : null}

      {/*
        Said before it happens rather than after. Whoever is on the other shift
        stays signed in on their phone, which is what a shared login needs and
        is not what people assume a password change does.
      */}
      <p className="mt-2 text-xs text-muted">
        Other phones already signed in stay signed in. Nobody can see this password, so if it is
        forgotten Rabindra has to set a new one.
      </p>

      <div className="mt-3 flex gap-2">
        <button
          type="submit"
          disabled={busy}
          className="touch flex-1 rounded-full bg-action px-4 text-base font-medium text-action-text disabled:opacity-40"
        >
          {busy ? 'Changing…' : 'Change password'}
        </button>
        <button
          type="button"
          onClick={reset}
          disabled={busy}
          className="touch rounded-full border border-hairline px-4 text-base text-ink disabled:opacity-40"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
