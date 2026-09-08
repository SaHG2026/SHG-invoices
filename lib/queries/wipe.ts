'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase/browser';
import { clearOfflineQueue } from '@/lib/offline/persister';
import { clearRecentlyPaid } from '@/lib/recently-paid';

/**
 * Rule 5's one exception. ARCHITECTURE §49.5, J4.
 *
 * ===========================================================================
 * The phrase is a constant, and it is the same string the database checks.
 *
 * `wipe_everything` refuses anything but this, exactly and case-sensitively
 * (CATCH_UP_021 §1). That second check is not security — this file is in the
 * bundle and anybody reading it can send the string. It is protection against
 * the call being made by ACCIDENT, and the two ends have to agree, so the app
 * types it once and the field compares against the same symbol the RPC is
 * called with. Notes §5: never two literals that happen to match today.
 * ===========================================================================
 */
export const WIPE_PHRASE = 'Wipe everything';

/** What was there, counted before it was deleted. The only receipt anybody gets. */
export interface WipeCounts {
  invoices: number;
  sales_invoices: number;
  suppliers: number;
  customers: number;
  products: number;
}

/**
 * Empty the ledger.
 *
 * ---------------------------------------------------------------------------
 * Deliberately NOT queueable, and this is the one write in the app that must
 * never be.
 *
 * Every other write in `lib/offline/keys.ts` is safe to replay from a cold
 * start days later, because it adds one row that was already true when it was
 * typed. This one is not: a wipe queued on a phone with no signal, sent on
 * Thursday, would delete every invoice entered between Tuesday and Thursday —
 * by people who never asked for it and are not looking at a confirmation.
 *
 * So it has no `mk` key, no mutation default, and no offline path. If there is
 * no signal it fails, says so, and nothing happens. **A destructive action
 * must be a thing that happens now or not at all.**
 * ---------------------------------------------------------------------------
 *
 * ---------------------------------------------------------------------------
 * Then this device's own state, and only this device's.
 *
 * `queryClient.clear()` empties what the app is holding in memory. The queue
 * on disk is a separate store and has to be cleared separately — the same
 * pairing `useSignOut` gets wrong-proof by doing both, for a related reason:
 * a queued invoice surviving a wipe is one invoice in an otherwise empty
 * ledger.
 *
 * **It cannot reach any other phone**, and nothing here pretends otherwise.
 * That warning belongs to the screen, in front of somebody, before they type
 * the phrase — CATCH_UP_021 §2 and §49.5.
 *
 * The struck-through "just paid" rows go too. They are a picture of a session
 * that no longer has anything behind it.
 * ---------------------------------------------------------------------------
 */
export function useWipeEverything() {
  const queryClient = useQueryClient();

  return useMutation<WipeCounts, Error, void>({
    mutationFn: async (): Promise<WipeCounts> => {
      const { data, error } = await supabase().rpc('wipe_everything', {
        p_confirm: WIPE_PHRASE,
      });

      /*
       * The database's own sentence. Both refusals in `wipe_everything` are
       * written to be read by a person — "Only the owner can clear the
       * records." — and a house message here would replace a specific reason
       * with a vague one, which is the mistake `RoleSection` avoids for the
       * same reason.
       */
      if (error) throw new Error(error.message);
      return data as WipeCounts;
    },

    onSuccess: async () => {
      clearRecentlyPaid();
      await clearOfflineQueue();
      queryClient.clear();
    },
  });
}
