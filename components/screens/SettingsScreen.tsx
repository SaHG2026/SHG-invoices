'use client';

import Link from 'next/link';
import type { Route } from 'next';
import type { Profile } from '@/lib/types';
import { useEffect, useState } from 'react';
import { AppChrome } from '@/components/app/AppChrome';
import { PushSwitch } from '@/components/app/PushSwitch';
import { PasswordChange } from '@/components/app/PasswordChange';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useIsOnline, useQueuedWriteCount } from '@/lib/offline/pending';
import { useQueryClient } from '@tanstack/react-query';
import { PersonChip } from '@/components/ui/PersonChip';
import { useToast } from '@/components/ui/Toast';
import {
  useCurrentProfile,
  useSetUserRole,
  useSignOut,
  useTeam,
  useUpdateNotifyPreference,
  useUpdateReminderTime,
} from '@/lib/queries/session';
import { formatTime, isTimeStr } from '@/lib/date';
import { clearAllLockState, hasPin, pinAvailable } from '@/lib/pin';
import { isOwner, isStaff, STAFF_HOME } from '@/lib/staff';
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
  const updateReminder = useUpdateReminderTime();

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

  /*
   * Where "back" goes. A venue account has never seen the dashboard and
   * cannot — `VenueGate` sends it to its own screen and `is_member()` would
   * refuse the data anyway — so a back link pointing at `/` would bounce off a
   * redirect and land somewhere it did not name.
   */
  const backHref = isStaff(profile) ? STAFF_HOME : ('/' as Route);

  if (!profile) {
    return (
      <AppChrome back={{ href: '/' as Route, label: 'Invoices' }}>
        <h1 className="text-h1 text-ink">Settings</h1>
        <p className="mt-2 text-sm text-muted">Loading…</p>
      </AppChrome>
    );
  }

  /**
   * The daily reminder, set to a time or turned off.
   *
   * Null is off, and the field is the switch — there is no separate checkbox,
   * because a time and an enabled flag are two values describing three states
   * when two are real, and they can disagree.
   *
   * An empty `<input type="time">` reports `''`, which is exactly the "off"
   * the column wants, so the two agree without a translation step. Anything
   * else that is not a real 'HH:MM' is refused rather than sent — a browser
   * that produced '8:5' would otherwise store a time nothing can read back.
   */
  async function setReminder(raw: string) {
    if (!profile) return;
    const value = raw === '' ? null : raw;
    if (value !== null && !isTimeStr(value)) return;

    try {
      await updateReminder.mutateAsync({ id: profile.id, time: value });
      toast.show(
        value === null
          ? 'Daily reminder off.'
          : `Reminder set for ${formatTime(value)}, every day.`,
      );
    } catch {
      toast.show('Couldn’t save that. It stays as it was.', 'problem');
    }
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
    <AppChrome back={{ href: backHref, label: 'Invoices' }}>
      <h1 className="text-h1 mb-4 text-ink">Settings</h1>

      <section className="mb-4 flex items-center gap-3 rounded-sm border border-edge bg-card p-4">
        <PersonChip profile={profile} size="lg" />
        <span className="min-w-0">
          <span className="block truncate text-base text-ink">{profile.display_name}</span>
          <span className="block truncate text-xs text-muted">
            {/*
              A venue is a shop, not a person with a job title. Saying
              "Sagarmatha Holdings" to whoever is on shift at Parramatta names
              the wrong thing entirely — the useful fact is which login this
              phone is signed in as, because it is shared.
            */}
            {isStaff(profile)
              ? 'Shop login · shared'
              : /*
                 * The title, not the role.
                 *
                 * `role` said "owner" for two of the four and nothing for the
                 * other two, which is a permission leaking into a place that
                 * wanted a job. `profiles.title` is the fact being asked for
                 * (CATCH_UP_016 §4), and it falls back to the company name
                 * alone rather than to a role — a person with no title yet
                 * should read as unremarkable, not as less senior.
                 */
                `Sagarmatha Holdings${profile.title ? ` · ${profile.title}` : ''}`}
          </span>
        </span>
      </section>

      {/*
        Not shown to a venue. CATCH_UP_010 §6 turned both push audiences into
        allowlists of `member` and `owner`, so a shop switching this on would
        change a flag that no view reads and no notification would ever arrive.
        Notes §6: the interface should not offer what it cannot do.
      */}
      {isStaff(profile) ? null : (
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

        {/*
          The reminder. Asked for after real use: "an option to send the
          managements an alert at a time of their choosing, as a reminder to
          check today's invoices."

          Under the per-invoice switch and above the per-device one, which is
          the order the three of them read: whether I am told about other
          people's work, when I am reminded about my own, and which of my
          phones rings. All three are one person's own settings.

          It sends every day whether or not anything happened — a reminder that
          appears only when there is news is an alert, and "nothing logged
          today" is how you find out a shop forgot.
        */}
        <div className="mt-4 border-t border-hairline pt-4">
          <label
            className="mb-1 block text-sm text-ink"
            htmlFor="reminder-time"
          >
            Remind me to check the day’s invoices
          </label>
          <div className="flex items-center gap-2">
            <input
              id="reminder-time"
              type="time"
              value={profile.reminder_time ?? ''}
              disabled={updateReminder.isPending}
              onChange={(event) => void setReminder(event.target.value)}
              className="figure-date touch rounded-sm border border-hairline bg-card px-3 text-base text-ink outline-none focus:border-action disabled:opacity-50"
            />
            {profile.reminder_time ? (
              <button
                type="button"
                onClick={() => void setReminder('')}
                disabled={updateReminder.isPending}
                className="touch rounded-full border border-hairline px-3 text-sm text-muted disabled:opacity-50"
              >
                Turn off
              </button>
            ) : null}
          </div>
          <p className="mt-1 text-xs text-muted">
            {profile.reminder_time
              ? `Every day at ${formatTime(profile.reminder_time)}, Sydney time.`
              : 'Off. Set a time and you’ll get one notification a day.'}
          </p>
        </div>

        <PushSwitch profileId={profile.id} />
      </section>
      )}

      {/*
        Who can do what. CATCH_UP_019 §6, and owner-only.

        A manager is not shown this at all rather than shown it greyed out.
        Every button on it would come back 42501 — `set_user_role` refuses a
        non-owner before it looks at anything else — and notes §6 is that the
        interface should not offer what it cannot do.

        The builder is not in `useTeam()` and so is not on this list, which is
        §44.2 exactly: hidden from lists, honest about actions. He also cannot
        be changed FROM here even if a row for him were somehow rendered — the
        function refuses a builder row, because an owner able to demote the
        builder can lock the builder out of the app he maintains.
      */}
      {isOwner(profile) ? <RoleSection me={profile} /> : null}

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

        <PasswordChange />

        {/*
          The token specimen is a builder's page. It was reachable by everyone
          when everyone was one of four people who would never tap it; a shop
          phone is a different audience, and a screen full of colour swatches
          is noise on it.
        */}
        {profile.role === 'builder' ? (
          <Link href={'/specimen' as Route} className="touch flex items-center text-sm text-action">
            Design tokens
          </Link>
        ) : null}
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

      {/*
        Which build this phone is running.
        
        Added after a deploy silently did not reach the live URL, and two
        rounds were spent on "it still says the old thing" before anybody
        checked. Nothing on any screen said which version it was; the answer
        came from fetching the stylesheet and comparing a border radius.
        
        Deliberately the last thing on the page and deliberately dull. Nobody
        needs it until somebody asks "did that go out", and then it is the
        whole answer.
      */}
      <p className="mt-6 text-center text-xs text-muted">
        Build {process.env.NEXT_PUBLIC_BUILD_STAMP ?? 'dev'}
      </p>
    </AppChrome>
  );
}


/**
 * Promote and demote, the only screen that can.
 *
 * ---------------------------------------------------------------------------
 * Two tiers on the list, not four.
 *
 * `useTeam()` is the allowlist of people who run the businesses — manager and
 * owner — so the builder and both shop logins are absent, which is what the
 * database refuses to change anyway. The list and the function agree by
 * construction rather than by both remembering the same three exceptions.
 *
 * The last owner is the one refusal this screen states BEFORE tapping. The
 * others are conditions on rows that are not here; this one is a condition on
 * a row that is, and "Make manager" on the only owner is a button whose entire
 * job is to fail.
 * ---------------------------------------------------------------------------
 */
function RoleSection({ me }: { me: Profile }) {
  const toast = useToast();
  const { data: team = [] } = useTeam();
  const setRole = useSetUserRole();
  const [changing, setChanging] = useState<{ person: Profile; to: 'manager' | 'owner' } | null>(
    null,
  );

  const owners = team.filter((person) => person.role === 'owner');

  async function apply() {
    if (!changing) return;
    const { person, to } = changing;
    try {
      await setRole.mutateAsync({ id: person.id, role: to });
      setChanging(null);
      toast.show(
        to === 'owner'
          ? `${person.display_name} is now an owner.`
          : `${person.display_name} is now a manager.`,
      );
    } catch (error) {
      /*
       * The database's own sentence, not one of ours.
       *
       * All five refusals in `set_user_role` are written to be read by a
       * person -- "That is the only owner. Make somebody else the owner
       * first." A house message here would replace five specific reasons with
       * one vague one, and the specific reason is the whole value.
       */
      setChanging(null);
      toast.show(error instanceof Error ? error.message : 'Couldn’t change that.', 'problem');
    }
  }

  return (
    <section className="mb-4 rounded-sm border border-edge bg-card p-4">
      <p className="mb-1 text-xs uppercase tracking-widest text-muted">Who can do what</p>
      <p className="mb-3 text-sm text-muted">
        An owner marks bills paid, records money received, and changes this list. A manager does
        everything else — reviewing, editing, voiding, suppliers, customers and invoices.
      </p>

      <ul>
        {team.map((person) => {
          const owner = person.role === 'owner';
          /* The refusal stated in advance. Demoting the only owner leaves
             nobody who can promote anybody, and no way back except a
             hand-written statement. */
          const lastOwner = owner && owners.length <= 1;

          return (
            <li
              key={person.id}
              className="flex items-center gap-3 border-b border-hairline py-2 last:border-b-0"
            >
              <PersonChip profile={person} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-ink">
                  {person.display_name}
                  {person.id === me.id ? ' · you' : ''}
                </span>
                <span className="block text-xs text-muted">{owner ? 'Owner' : 'Manager'}</span>
              </span>

              {lastOwner ? (
                <span className="shrink-0 text-xs text-muted">The only owner</span>
              ) : (
                <button
                  type="button"
                  disabled={setRole.isPending}
                  onClick={() =>
                    setChanging({ person, to: owner ? 'manager' : 'owner' })
                  }
                  className="touch shrink-0 rounded-full border border-hairline bg-card px-3 text-sm text-action disabled:opacity-40"
                >
                  {owner ? 'Make manager' : 'Make owner'}
                </button>
              )}
            </li>
          );
        })}
      </ul>

      <ConfirmDialog
        open={changing !== null}
        title={
          changing?.to === 'owner'
            ? `Make ${changing.person.display_name} an owner?`
            : `Make ${changing?.person.display_name ?? ''} a manager?`
        }
        points={
          changing?.to === 'owner'
            ? [
                <>They will be able to mark bills paid and record money received.</>,
                <>They will be able to change this list, including your own place on it.</>,
              ]
            : [
                <>
                  They keep everything else — reviewing, editing, voiding, suppliers,
                  customers and invoices.
                </>,
                <>
                  They stop being able to mark anything paid.
                  {changing?.person.id === me.id
                    ? ' That includes you, from the moment you tap this.'
                    : ''}
                </>,
              ]
        }
        question={changing?.to === 'owner' ? 'Make them an owner?' : 'Make them a manager?'}
        confirmLabel={changing?.to === 'owner' ? 'Make owner' : 'Make manager'}
        onConfirm={() => void apply()}
        onCancel={() => setChanging(null)}
      />
    </section>
  );
}
