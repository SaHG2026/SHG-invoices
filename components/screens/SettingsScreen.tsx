'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { useEffect, useState } from 'react';
import { AppChrome } from '@/components/app/AppChrome';
import { PersonChip } from '@/components/ui/PersonChip';
import { useToast } from '@/components/ui/Toast';
import { useCurrentProfile, useSignOut, useUpdateNotifyPreference } from '@/lib/queries/session';
import { clearAllLockState, hasPin, pinAvailable } from '@/lib/pin';
import { PIN_LENGTH } from '@/lib/constants';

/**
 * Settings.
 *
 * The menu needed somewhere to send Settings, and the three things that were
 * hiding behind a tap on the header chip — who you are, the design tokens,
 * signing out — were already a settings screen wearing a dropdown. Now they
 * have a page, and the notification preference finally has somewhere to live:
 * ARCHITECTURE §8.1 gave every person the right to change it and nothing in
 * the app has ever offered them the switch.
 *
 * The switch covers new invoices and nothing else. Being told when a bill is
 * PAID is Mani's alone, by the client's decision, and it is deliberately not a
 * preference on this screen — ARCHITECTURE §26. Everyone still sees every
 * payment in History and in the bell; this governs only what a phone
 * interrupts you for.
 *
 * The copy is one line per control on purpose. It read like an explanation of
 * itself, and a settings screen that argues its own case is one nobody
 * finishes reading.
 *
 * What is deliberately not here: anything about anybody else. `role` is not a
 * permission (§8.1), there is no admin, and the only row a person can update
 * is their own — enforced by an RLS policy and a column grant, not by which
 * controls this screen renders. The interface is never the enforcement layer.
 */
export function SettingsScreen() {
  const toast = useToast();
  const { data: profile } = useCurrentProfile();
  const signOut = useSignOut();
  const updateNotify = useUpdateNotifyPreference();

  // Storage cannot be read during render without breaking hydration.
  const [lock, setLock] = useState<{ supported: boolean; set: boolean } | null>(null);

  useEffect(() => {
    if (!profile) return;
    setLock({ supported: pinAvailable(), set: pinAvailable() && hasPin(profile.id) });
  }, [profile]);

  if (!profile) {
    return (
      <AppChrome back={{ href: '/' as Route, label: 'Invoices' }}>
        <h1 className="text-h1 text-ink">Settings</h1>
        <p className="mt-2 text-sm text-muted">Loading…</p>
      </AppChrome>
    );
  }

  async function toggleNotify(notify: boolean) {
    if (!profile) return;
    try {
      await updateNotify.mutateAsync({ id: profile.id, notify });
      toast.show(notify ? 'You’ll be told about new invoices.' : 'Notifications off.');
    } catch {
      // The switch snaps back on its own — it renders from the query, and the
      // query was never changed. Saying why matters more than saying it failed.
      toast.show('Couldn’t save that. It stays as it was.', 'problem');
    }
  }

  /**
   * Clearing the lock, then a full navigation rather than a router push.
   *
   * The gate reads storage once, in an effect keyed on the profile, so
   * changing what is in storage underneath it changes nothing until the tree
   * remounts. And `clearAllLockState` rather than `clearPin`: the PIN and the
   * "already unlocked" flag are two halves of one fact, and the last time they
   * had two owners, signing back in walked straight past the lock.
   */
  function changePin() {
    clearAllLockState();
    window.location.href = '/';
  }

  return (
    <AppChrome back={{ href: '/' as Route, label: 'Invoices' }}>
      <h1 className="text-h1 mb-4 text-ink">Settings</h1>

      <section className="mb-4 flex items-center gap-3 rounded-sm border border-edge bg-card p-4">
        <PersonChip profile={profile} size="lg" />
        <span className="min-w-0">
          <span className="block truncate text-base text-ink">{profile.display_name}</span>
          <span className="block truncate text-xs text-muted">
            Sagarmatha Holdings{profile.role === 'owner' ? ' · owner' : ''}
          </span>
        </span>
      </section>

      <section className="mb-4 rounded-sm border border-edge bg-card p-4">
        <p className="mb-2 text-xs uppercase tracking-widest text-muted">Notifications</p>

        <label className="flex items-start gap-3 text-sm text-ink">
          <input
            type="checkbox"
            checked={profile.notify_on_new_invoice}
            disabled={updateNotify.isPending}
            onChange={(event) => void toggleNotify(event.target.checked)}
            className="mt-0.5 size-4 shrink-0"
          />
          <span>Notify me when a new invoice is added</span>
        </label>
      </section>

      <section className="mb-4 rounded-sm border border-edge bg-card p-4">
        <p className="mb-2 text-xs uppercase tracking-widest text-muted">This device</p>

        {lock === null ? (
          <p className="text-sm text-muted">Checking…</p>
        ) : !lock.supported ? (
          <p className="text-sm text-muted">
            No PIN on this address — it needs https. Your sign-in still applies.
          </p>
        ) : (
          <>
            <p className="text-sm text-ink">
              {lock.set ? `${PIN_LENGTH}-digit PIN set.` : 'No PIN on this device.'}
            </p>
            <button
              type="button"
              onClick={changePin}
              className="touch mt-2 flex items-center text-sm text-action"
            >
              {lock.set ? 'Change PIN' : 'Set a PIN'}
            </button>
          </>
        )}
      </section>

      <section className="rounded-sm border border-edge bg-card p-4">
        <p className="mb-1 text-xs uppercase tracking-widest text-muted">Account</p>

        <Link href={'/specimen' as Route} className="touch flex items-center text-sm text-action">
          Design tokens
        </Link>
        <button
          type="button"
          onClick={() => signOut.mutate()}
          disabled={signOut.isPending}
          className="touch flex w-full items-center text-left text-sm text-action disabled:opacity-40"
        >
          {signOut.isPending ? 'Signing out…' : 'Sign out'}
        </button>
        <p className="mt-1 text-xs text-muted">Signing out clears the PIN on this device.</p>
      </section>
    </AppChrome>
  );
}
