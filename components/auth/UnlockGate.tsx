'use client';

import { useCallback, useEffect, useState } from 'react';
import { PinPad } from './PinPad';
import { useCurrentProfile, useSignOut } from '@/lib/queries/session';
import { clearPin, hasPin, pinAvailable, setPin, verifyPin } from '@/lib/pin';
import { PIN_LENGTH } from '@/lib/constants';
import type { Profile } from '@/lib/types';

/**
 * Everything behind this is only rendered once the person has unlocked.
 *
 * This is a lock on the interface, not on the data — spec §2, and see
 * ARCHITECTURE §8 for the honest limits. RLS is what protects the invoices;
 * this stops a phone left on a counter being picked up and used.
 *
 * "Unlocked" lives in sessionStorage, so it survives switching apps and
 * backgrounding but not closing the app. That is the intent of spec §7.1: the
 * PIN on every open, the password only every thirty days.
 */

const UNLOCK_PREFIX = 'shg.unlocked.';

function readUnlocked(profileId: string): boolean {
  try {
    return sessionStorage.getItem(UNLOCK_PREFIX + profileId) === '1';
  } catch {
    return false;
  }
}

function writeUnlocked(profileId: string): void {
  try {
    sessionStorage.setItem(UNLOCK_PREFIX + profileId, '1');
  } catch {
    /* the gate simply reappears next render; harmless */
  }
}

function Field({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col justify-center bg-ink px-6 py-12">
      <div className="mx-auto w-full max-w-[360px]">{children}</div>
    </main>
  );
}

function Chip({ profile, large = false }: { profile: Profile; large?: boolean }) {
  return (
    <span
      className={`flex items-center justify-center rounded-sm text-white ${large ? 'size-12' : 'size-6'}`}
      style={{
        backgroundColor: profile.accent,
        fontFamily: 'var(--font-mono)',
        fontSize: large ? '18px' : '11px',
      }}
    >
      {profile.initials}
    </span>
  );
}

export function UnlockGate({ children }: { children: React.ReactNode }) {
  const { data: profile, isLoading, isError } = useCurrentProfile();
  const signOut = useSignOut();

  // Storage cannot be read during render without breaking hydration, so the
  // gate starts closed and opens in an effect once the browser is in charge.
  const [ready, setReady] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [needsPin, setNeedsPin] = useState(false);
  const [available, setAvailable] = useState(true);

  useEffect(() => {
    if (!profile) return;
    setAvailable(pinAvailable());
    setUnlocked(readUnlocked(profile.id));
    setNeedsPin(!hasPin(profile.id));
    setReady(true);
  }, [profile]);

  const open = useCallback(() => {
    if (!profile) return;
    writeUnlocked(profile.id);
    setUnlocked(true);
  }, [profile]);

  if (isLoading || (profile && !ready)) {
    return <Field><p className="text-center text-sm text-hair/60">Loading…</p></Field>;
  }

  if (isError || !profile) {
    // The middleware would have redirected an unauthenticated request, so
    // reaching here with no profile means the account exists in auth but has
    // no active profile row — i.e. it has been deactivated.
    return (
      <Field>
        <h1 className="text-h2 text-snow" style={{ fontFamily: 'var(--font-display)' }}>
          This account is not active
        </h1>
        <p className="mt-2 text-sm text-hair/70">
          Your sign-in worked, but there is no active profile for it. Ask Rabindra to reactivate it.
        </p>
        <button
          type="button"
          onClick={() => signOut.mutate()}
          className="touch mt-6 w-full rounded-sm border border-slate/50 px-4 text-base text-snow"
        >
          Sign out
        </button>
      </Field>
    );
  }

  if (!available) {
    // crypto.subtle is missing, which means this is an insecure context — a
    // plain http:// address on the local network. Rather than fall back to a
    // weaker hash and let it be trusted, say so and let them through: the
    // session is still real and RLS is still doing the actual protecting.
    return (
      <>
        <p className="bg-gold px-4 py-2 text-center text-xs text-ink">
          Quick unlock is off on this address. Open the app over https to use a PIN.
        </p>
        {children}
      </>
    );
  }

  if (needsPin) return <SetPinScreen profile={profile} onDone={open} onSkip={open} />;
  if (!unlocked) return <UnlockScreen profile={profile} onDone={open} />;

  return <>{children}</>;
}

/* -------------------------------------------------------------------------- */

function SetPinScreen({
  profile,
  onDone,
  onSkip,
}: {
  profile: Profile;
  onDone: () => void;
  onSkip: () => void;
}) {
  const [first, setFirst] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resetToken, setResetToken] = useState(0);

  const onComplete = useCallback(
    async (pin: string) => {
      if (first === null) {
        setFirst(pin);
        setError(null);
        setResetToken((n) => n + 1);
        return;
      }

      if (pin !== first) {
        setFirst(null);
        setError('Those two didn’t match. Start again.');
        setResetToken((n) => n + 1);
        return;
      }

      setBusy(true);
      try {
        await setPin(profile.id, pin);
        onDone();
      } catch {
        setError('Couldn’t save the PIN on this device.');
        setFirst(null);
        setBusy(false);
        setResetToken((n) => n + 1);
      }
    },
    [first, profile.id, onDone],
  );

  return (
    <Field>
      <div className="mb-8 flex flex-col items-center">
        <Chip profile={profile} large />
        <h1
          className="mt-4 text-h2 text-snow"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          {first === null ? `Choose a ${PIN_LENGTH}-digit PIN` : 'Enter it again'}
        </h1>
        <p className="mt-1 text-center text-sm text-hair/70">
          {first === null
            ? 'It unlocks this app on this phone. It is not your password.'
            : 'Just to be sure it is what you meant.'}
        </p>
      </div>

      <PinPad onComplete={onComplete} busy={busy} resetToken={resetToken} />

      {error ? (
        <p role="alert" className="mt-6 text-center text-sm text-gold">
          {error}
        </p>
      ) : null}

      <button
        type="button"
        onClick={onSkip}
        className="touch mt-8 w-full text-center text-sm text-hair/60 underline"
      >
        Not now
      </button>
    </Field>
  );
}

/* -------------------------------------------------------------------------- */

function UnlockScreen({ profile, onDone }: { profile: Profile; onDone: () => void }) {
  const signOut = useSignOut();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resetToken, setResetToken] = useState(0);

  const onComplete = useCallback(
    async (pin: string) => {
      setBusy(true);
      const result = await verifyPin(profile.id, pin);

      if (result.ok) {
        onDone();
        return;
      }

      if (result.lockedOut) {
        clearPin(profile.id);
        signOut.mutate();
        return;
      }

      setError(
        result.attemptsLeft === 1
          ? 'Wrong PIN. One more try before you need your password.'
          : `Wrong PIN. ${result.attemptsLeft} tries left.`,
      );
      setBusy(false);
      setResetToken((n) => n + 1);
    },
    [profile.id, onDone, signOut],
  );

  return (
    <Field>
      <div className="mb-8 flex flex-col items-center">
        <Chip profile={profile} large />
        <h1 className="mt-4 text-h2 text-snow" style={{ fontFamily: 'var(--font-display)' }}>
          {profile.display_name}
        </h1>
        <p className="mt-1 text-sm text-hair/70">Enter your PIN</p>
      </div>

      <PinPad onComplete={onComplete} busy={busy} resetToken={resetToken} />

      {error ? (
        <p role="alert" className="mt-6 text-center text-sm text-gold">
          {error}
        </p>
      ) : null}

      <button
        type="button"
        onClick={() => signOut.mutate()}
        className="touch mt-8 w-full text-center text-sm text-hair/60 underline"
      >
        Sign in as someone else
      </button>
    </Field>
  );
}
