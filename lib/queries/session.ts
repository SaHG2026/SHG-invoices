'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase/browser';
import { clearOfflineQueue, clearShellCache } from '@/lib/offline/persister';
import { clearAllLockState } from '@/lib/pin';
import { clearRecentlyPaid } from '@/lib/recently-paid';
import { roleMayBeChanged, runsTheBusinesses } from '@/lib/staff';
import { qk } from './keys';
import type { TimeStr } from '@/lib/date';
import type { Profile } from '@/lib/types';

/**
 * Who is signed in.
 *
 * Reads `profiles` with the person's own JWT, so a result here proves three
 * things at once: the session is real, RLS recognises them as a member, and
 * the row they get back is their own. If the account were deactivated, this
 * returns nothing and the app cannot be used — which is the deactivation
 * mechanism working, not an error.
 */
export function useCurrentProfile() {
  return useQuery({
    queryKey: qk.profiles.me,
    queryFn: async (): Promise<Profile | null> => {
      const client = supabase();

      const {
        data: { user },
        error: authError,
      } = await client.auth.getUser();

      if (authError || !user) return null;

      const { data, error } = await client
        .from('profiles')
        .select(PROFILE_COLUMNS)
        .eq('id', user.id)
        .maybeSingle();

      if (error) throw error;
      return (data as Profile | null) ?? null;
    },
    // The signed-in person does not change while the app is open.
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

/** Everyone, for the attribution chips and the unlock screen. */
export function useProfiles() {
  return useQuery({
    queryKey: qk.profiles.all,
    queryFn: async (): Promise<Profile[]> => {
      const { data, error } = await supabase()
        .from('profiles')
        .select(PROFILE_COLUMNS)
        .eq('active', true)
        .order('display_name');

      if (error) throw error;
      return (data ?? []) as Profile[];
    },
    staleTime: 5 * 60_000,
  });
}

/**
 * The people who run the businesses.
 *
 * The counterpart to `useProfiles`, and the distinction matters: that one is a
 * LOOKUP, used to put a name and a face against whoever touched a row, and it
 * must keep returning everybody or a chip somewhere cannot name its actor.
 * This one is a LIST OF PEOPLE, rendered as choices, and it leaves out
 * builders and venues.
 *
 * ARCHITECTURE §28.2: Rabindra builds and maintains the app and is not part of
 * running the businesses. Two facts about one person that the schema used to
 * be unable to tell apart. `role` carries the second one, so nothing about his
 * access changes — he simply stops being offered as one of the four.
 *
 * They are different questions, so they get different functions. Filtering the
 * lookup instead would leave an unnamed chip on any row he ever touched — and
 * that now matters twice over, because the two venue accounts DO enter
 * invoices, so `useProfiles` has to keep naming them while this one does not
 * offer them.
 *
 * The predicate is an allowlist and lives in `lib/staff.ts`. It used to read
 * `role !== 'builder'` inline, which would have listed GroceryMate Parramatta
 * as one of the people who run the businesses the day that account existed.
 */
export function useTeam() {
  const query = useProfiles();
  return {
    ...query,
    data: (query.data ?? []).filter(runsTheBusinesses),
  };
}

/**
 * Everybody whose role the owner may change. §52.
 *
 * The third list over the same query, and the third question: `useProfiles` is
 * a LOOKUP, `useTeam` is the people who run the businesses, and this one is
 * the rows `set_user_role` will accept.
 *
 * It has to include assistants where `useTeam` must not. Demote somebody and
 * they leave `useTeam` immediately — so a screen built on that list would
 * lose the row it had just changed, and with it the only way back.
 */
export function useChangeableRoles() {
  const query = useProfiles();
  return {
    ...query,
    data: (query.data ?? []).filter(roleMayBeChanged),
  };
}

/**
 * Every column of a profile the app reads, in one place.
 *
 * Four call sites used to spell this list out. Adding `reminder_time` to three
 * of them and missing the fourth would have produced a profile whose reminder
 * silently reset to off whenever that particular query was the one that
 * refreshed the cache — a bug that appears only after a specific navigation
 * and looks like the setting "not saving".
 */
const PROFILE_COLUMNS =
  'id, display_name, initials, accent, role, notify_on_new_invoice, reminder_time, title, active, business_id';

/**
 * The one field a person may change about themselves.
 *
 * ARCHITECTURE §8.1: two mechanisms in migration 007 enforce that, because
 * they do different jobs — the `self_update` RLS policy decides which ROW you
 * may touch (yours), and `grant update (notify_on_new_invoice)` decides which
 * FIELD you may set. RLS cannot restrict columns, so without the grant a
 * person could rename themselves or promote themselves to owner.
 *
 * Which means the failure mode worth handling here is a permission error, not
 * a validation one: if this ever starts failing, the grant has been lost, and
 * saying so plainly beats a silent no-op that leaves the switch looking set.
 */
export function useUpdateNotifyPreference() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, notify }: { id: string; notify: boolean }): Promise<Profile> => {
      const { data, error } = await supabase()
        .from('profiles')
        .update({ notify_on_new_invoice: notify })
        .eq('id', id)
        .select(PROFILE_COLUMNS)
        .single();

      if (error) throw error;
      return data as Profile;
    },
    onSuccess: (profile) => {
      queryClient.setQueryData<Profile | null>(qk.profiles.me, profile);
      queryClient.setQueryData<Profile[]>(qk.profiles.all, (current) =>
        (current ?? []).map((existing) => (existing.id === profile.id ? profile : existing)),
      );
    },
  });
}

export function useSignOut() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      // Wipe the whole device lock first — PINs, failed attempts, and the
      // "already unlocked" flag. Missing that last one meant signing back in
      // walked straight past the PIN screen.
      clearAllLockState();
      // The struck-through rows belong to a session, and this is the end of
      // one. Leaving them would show the next person what the last one paid.
      clearRecentlyPaid();
      const { error } = await supabase().auth.signOut();
      if (error) throw error;

      /*
       * Both of this device's stores, not just the one in memory.
       *
       * `queryClient.clear()` below empties the cache the app is holding; it
       * does not touch the copy of the write queue on disk. Leaving that
       * behind meant a queued invoice could either be lost without anybody
       * being told, or be sent later by whoever signed in next.
       * lib/offline/persister.ts has the full account.
       *
       * Awaited before the navigation, because the navigation kills this page.
       */
      await clearOfflineQueue();
      await clearShellCache();
    },
    onSuccess: () => {
      queryClient.clear();
      // A full navigation rather than a client-side push: it discards every
      // scrap of in-memory state, which is what signing out should mean.
      window.location.href = '/login';
    },
  });
}

/**
 * When this person wants their daily nudge, or null for not at all.
 *
 * The second field in the column grant (CATCH_UP_014 §1), and the same two
 * mechanisms guard it as guard the notify switch: the `self_update` policy
 * decides which row, the grant decides which field.
 *
 * The value is a plain 'HH:MM' string all the way to Postgres, which accepts
 * it as a `time`. It is never turned into a `Date` — §3, and the reason
 * `TimeStr` exists: half past eight in Sydney is a fact about a wall clock,
 * and a `Date` would make it a fact about an instant.
 */
export function useUpdateReminderTime() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      time,
    }: {
      id: string;
      time: TimeStr | null;
    }): Promise<Profile> => {
      const { data, error } = await supabase()
        .from('profiles')
        .update({ reminder_time: time })
        .eq('id', id)
        .select(PROFILE_COLUMNS)
        .single();

      if (error) throw error;
      return data as Profile;
    },
    onSuccess: (profile) => {
      queryClient.setQueryData<Profile | null>(qk.profiles.me, profile);
      queryClient.setQueryData<Profile[]>(qk.profiles.all, (current) =>
        (current ?? []).map((existing) => (existing.id === profile.id ? profile : existing)),
      );
    },
  });
}

/**
 * Promote somebody to owner, or put them back to manager.
 *
 * ---------------------------------------------------------------------------
 * Not an update. An RPC, and the difference is the whole design.
 *
 * Migration 007 revoked blanket UPDATE on `profiles` and granted back exactly
 * `notify_on_new_invoice` and `reminder_time`. `role` is unreachable from a
 * browser by construction, and it stays that way: widening the grant would let
 * anybody signed in write any value into anybody's row, because a grant is
 * coarse, permanent, and cannot ask who is calling.
 *
 * `set_user_role` can. It refuses a non-owner, a builder row, a staff row, a
 * role that is not manager or owner, and the demotion of the last owner —
 * CATCH_UP_019 §6, which has the reasoning for each. All five come back as a
 * sentence, which is what `message` carries, so the screen shows what the
 * database actually said rather than a house error of its own invention.
 *
 * Deliberately NOT offline-capable. Every other write in this app queues; this
 * one does not, because a promotion applied twenty minutes later against a
 * table somebody else has also changed is a permission decision made in the
 * dark. It fails, and it says so.
 * ---------------------------------------------------------------------------
 */
export function useSetUserRole() {
  const queryClient = useQueryClient();

  /* Three destinations since CATCH_UP_022, and `builder` and `staff` are
     still not among them — `set_user_role` refuses both, so a type that
     offered them would be offering something the database will not do. */
  return useMutation<Profile, Error, { id: string; role: 'manager' | 'owner' | 'assistant' }>({
    mutationFn: async ({ id, role }): Promise<Profile> => {
      const { data, error } = await supabase().rpc('set_user_role', {
        p_profile_id: id,
        p_role: role,
      });

      if (error) throw new Error(error.message);
      return data as Profile;
    },
    onSuccess: (profile) => {
      const replace = (current: Profile[] | undefined) =>
        (current ?? []).map((existing) => (existing.id === profile.id ? profile : existing));

      queryClient.setQueryData<Profile[]>(qk.profiles.all, replace);
      /*
       * Your own row too, and this is the case that matters: an owner who
       * makes themselves a manager must stop being shown the owner's controls
       * on the very next frame, not after a refetch that may not come while
       * `staleTime` is five minutes.
       */
      queryClient.setQueryData<Profile | null>(qk.profiles.me, (current) =>
        current && current.id === profile.id ? profile : current,
      );
      queryClient.invalidateQueries({ queryKey: qk.profiles.all });
      queryClient.invalidateQueries({ queryKey: qk.profiles.me });
    },
  });
}
