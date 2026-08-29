'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase/browser';
import { clearAllLockState } from '@/lib/pin';
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

export function useSignOut() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      // Wipe the whole device lock first — PINs, failed attempts, and the
      // "already unlocked" flag. Missing that last one meant signing back in
      // walked straight past the PIN screen.
      clearAllLockState();
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
