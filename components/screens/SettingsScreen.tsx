'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { useEffect, useState } from 'react';
import { AppChrome } from '@/components/app/AppChrome';
import { PushSwitch } from '@/components/app/PushSwitch';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useIsOnline, useQueuedWriteCount } from '@/lib/offline/pending';
import { useQueryClient } from '@tanstack/react-query';
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

  // What is still waiting to send, and whether it could. Both are live, so the
  // sign-out question below answers itself when the signal comes back.
  const queued = useQueuedWriteCount();
  const online = useIsOnline();
  const queryClient = useQueryClient();

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

  const [askingSignOut, setAskingSignOut] = useState(false);

  /**
   * Never sign out quietly over the top of unsent work.
   *
   * With nothing queued this is the plain sign-out it always was. With
   * something queued it asks first, because the alternative is an invoice
   * disappearing after the app promised to send it — which is the one thing
   * this app is built never to do.
   *
   * Resuming first, when there is signal: the queue usually drains in the time
   * it takes to read the question, and a question that answers itself is
   * better than one somebody has to think about.
   */
  function pressedSignOut() {
    if (queued === 0) {
      signOut.mutate();
      return;
    }
    if (online) void queryClient.resumePausedMutations();
    setAskingSignOut(true);
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

        <PushSwitch profileId={profile.id} />
      </section>

      {/*
        Only shown to whoever maintains the app, who is the only person who can
        change a picture — the three of them are users, not editors. A row
        that opens a screen where every button is missing is worse than no row
        — notes §6, the interface should not offer what it cannot do.
      */}
      {profile.role === 'builder' ? (
        <section className="mb-4 rounded-sm border border-edge bg-card p-4">
          <p className="mb-2 text-xs uppercase tracking-widest text-muted">Pictures</p>
          <Link href={'/brand' as Route} className="touch flex items-center text-base text-action">
            Logos and photographs
          </Link>
        </section>
      ) : null}

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
          onClick={pressedSignOut}
          disabled={signOut.isPending}
          className="touch flex w-full items-center text-left text-sm text-action disabled:opacity-40"
        >
          {signOut.isPending ? 'Signing out…' : 'Sign out'}
        </button>
        <p className="mt-1 text-xs text-muted">Signing out clears the PIN on this device.</p>
      </section>

      {/*
        Signing out clears this device, including anything still waiting to
        send. That is the right thing to do and the wrong thing to do quietly:
        somebody was told their invoice would go when the signal came back.

        So the count is put in front of them, and it is live — if the wifi
        returns while the question is on screen the queue drains, the count
        reaches zero, and this closes itself rather than making somebody answer
        a question that has stopped being true.
      */}
      <ConfirmDialog
        open={askingSignOut && queued > 0}
        title={
          queued === 1
            ? 'One invoice hasn’t sent yet'
            : `${queued} things haven’t sent yet`
        }
        points={[
          online
            ? 'You have signal, so this should clear by itself in a moment. Waiting is the safe option.'
            : 'This phone has no signal. Nothing can be sent until it comes back.',
          'Signing out clears this device, and anything still waiting is lost.',
        ]}
        question="Sign out anyway?"
        confirmLabel="Sign out anyway"
        cancelLabel="Wait"
        onConfirm={() => {
          setAskingSignOut(false);
          signOut.mutate();
        }}
        onCancel={() => setAskingSignOut(false)}
      />
    </AppChrome>
  );
}
