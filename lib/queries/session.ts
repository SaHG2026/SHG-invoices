'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase/browser';
import { clearAllLockState } from '@/lib/pin';
import { clearRecentlyPaid } from '@/lib/recently-paid';
import { qk } from './keys';
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
        .select('id, display_name, initials, accent, role, notify_on_new_invoice, active')
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
        .select('id, display_name, initials, accent, role, notify_on_new_invoice, active')
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
 * builders.
 *
 * ARCHITECTURE §28.2: Rabindra builds and maintains the app and is not part of
 * running the businesses. Two facts about one person that the schema used to
 * be unable to tell apart. `role` carries the second one and no RLS policy
 * reads it, so nothing about his access changes — he simply stops being
 * offered as one of the four.
 *
 * They are different questions, so they get different functions. Filtering the
 * lookup instead would leave an unnamed chip on any row he ever touched.
 */
export function useTeam() {
  const query = useProfiles();
  return {
    ...query,
    data: (query.data ?? []).filter((person) => person.role !== 'builder'),
  };
}

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
        .select('id, display_name, initials, accent, role, notify_on_new_invoice, active')
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
    },
    onSuccess: () => {
      queryClient.clear();
      // A full navigation rather than a client-side push: it discards every
      // scrap of in-memory state, which is what signing out should mean.
      window.location.href = '/login';
    },
  });
}
