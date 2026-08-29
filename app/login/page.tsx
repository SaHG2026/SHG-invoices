'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabase/browser';

/**
 * Email and password. Spec §7.1: only seen when the session has expired or on
 * a new device. There is deliberately no sign-up route and no password reset —
 * three accounts, created by hand, and nothing in the app can create a fourth.
 */

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next') ?? '/';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);

    const { error: signInError } = await supabase().auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    if (signInError) {
      // Spec §8: say what went wrong and what to do. Never "an error occurred".
      setError(
        signInError.message.toLowerCase().includes('invalid')
          ? 'That email and password don’t match. Check both and try again.'
          : `Couldn’t sign in — ${signInError.message}`,
      );
      setBusy(false);
      return;
    }

    router.replace(next as never);
    // Allowed here, and only here: the layout must re-read the new session
    // cookie. Banned everywhere near an open form (notes §1.1).
    router.refresh();
  }

  return (
    <main className="flex min-h-dvh flex-col justify-center bg-ink px-6 py-12">
      <div className="mx-auto w-full max-w-[360px]">
        <header className="mb-10">
          <h1
            className="text-h1 text-snow"
            style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.02em' }}
          >
            SHG
          </h1>
          <p className="mt-1 text-sm text-hair/70">Sagarmatha Holdings Group</p>
        </header>

        <form onSubmit={onSubmit} noValidate>
          <label className="mb-4 block">
            <span className="mb-1 block text-xs uppercase tracking-widest text-hair/70">Email</span>
            <input
              type="email"
              inputMode="email"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="touch w-full rounded-sm border border-slate/50 bg-ink px-3 text-base text-snow outline-none focus:border-gold"
            />
          </label>

          <label className="mb-6 block">
            <span className="mb-1 block text-xs uppercase tracking-widest text-hair/70">
              Password
            </span>
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="touch w-full rounded-sm border border-slate/50 bg-ink px-3 text-base text-snow outline-none focus:border-gold"
            />
          </label>

          {error ? (
            <p role="alert" className="mb-4 text-sm text-gold">
              {error}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={busy || email === '' || password === ''}
            className="touch w-full rounded-sm bg-gold px-4 text-base font-medium text-ink disabled:opacity-40"
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="mt-8 text-xs text-hair/50">
          Accounts are created by hand. If you can&rsquo;t get in, ask Rabindra to reset it.
        </p>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-dvh bg-ink" />}>
      <LoginForm />
    </Suspense>
  );
}
