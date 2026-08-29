'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useCurrentProfile, useProfiles, useSignOut } from '@/lib/queries/session';
import { greet } from '@/lib/greeting';
import { formatDayWithYear, sydneyToday } from '@/lib/date';

/**
 * Phase 2 dashboard.
 *
 * Deliberately thin. The real dashboard — the greeting over Overall plus the
 * four businesses with their totals — is Phase 4 (ARCHITECTURE §16), and
 * building it now would be running ahead.
 *
 * What this page is for is proving the chain end to end: the session is real,
 * the JWT reaches Postgres, RLS recognises the person as a member, and the row
 * that comes back is their own. If a name appears below, all four are true.
 */
export default function Dashboard() {
  const { data: profile } = useCurrentProfile();
  const { data: profiles } = useProfiles();
  const signOut = useSignOut();

  // The greeting depends on the current time, which the server does not know
  // and must not guess — rendering it server-side would produce a hydration
  // mismatch and, worse, the wrong greeting.
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => setNow(new Date()), []);

  if (!profile) return null;

  return (
    <main className="mx-auto min-h-dvh max-w-[560px] px-4 py-8">
      <header className="mb-8">
        <p className="text-xs uppercase tracking-widest text-mute">
          {now ? formatDayWithYear(sydneyToday(now)) : ' '}
        </p>
        <h1 className="text-h1 text-ink">{now ? greet(profile.display_name) : ' '}</h1>
        <p className="mt-1 text-sm text-mute">
          Signed in as {profile.display_name}
          {profile.role === 'owner' ? ' · owner' : ''}
        </p>
      </header>

      <section className="mb-8 border-t border-hair pt-4">
        <h2 className="text-h2 mb-1 text-ink">Phase 2 is working</h2>
        <p className="text-sm text-mute">
          Your name above was read from the database using your own sign-in. That means the session
          is real, the security rules recognise you, and the row you got back is yours.
        </p>
      </section>

      <section className="mb-8">
        <p className="mb-2 text-xs uppercase tracking-widest text-mute">Everyone</p>
        <ul className="border-t border-hair bg-card">
          {(profiles ?? []).map((person) => (
            <li
              key={person.id}
              className="flex h-row items-center gap-3 border-b border-hair px-3 last:border-b-0"
            >
              <span
                className="flex size-6 shrink-0 items-center justify-center rounded-sm text-white"
                style={{
                  backgroundColor: person.accent,
                  fontFamily: 'var(--font-mono)',
                  fontSize: '11px',
                }}
              >
                {person.initials}
              </span>
              <span className="flex-1 text-sm text-ink">{person.display_name}</span>
              <span className="text-xs text-mute">
                {person.role === 'owner' ? 'owner' : 'member'}
                {person.notify_on_new_invoice ? ' · notified' : ''}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="mb-8">
        <Link
          href="/specimen"
          className="touch flex items-center rounded-sm border border-hair bg-card px-3 text-sm text-ink"
        >
          Design tokens (Phase 1 review page)
        </Link>
      </section>

      <footer className="border-t border-hair pt-4">
        <button
          type="button"
          onClick={() => signOut.mutate()}
          disabled={signOut.isPending}
          className="touch w-full rounded-sm border border-hair px-4 text-sm text-ink disabled:opacity-40"
        >
          {signOut.isPending ? 'Signing out…' : 'Sign out'}
        </button>
        <p className="mt-2 text-xs text-mute">
          Signing out clears the PIN on this device, so you will need your password next time.
        </p>
      </footer>
    </main>
  );
}
