import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import type { PersistQueryClientOptions } from '@tanstack/react-query-persist-client';
import { del, get, set } from 'idb-keyval';
import { OFFLINE_SCHEMA, isQueueable } from './keys';

/**
 * Where a write waits while the phone is out of signal.
 *
 * ARCHITECTURE §7, stated there before any of this was built and unchanged by
 * building it: the queue is TanStack Query's own paused-mutation mechanism
 * persisted to disk. Not a hand-rolled queue, and **not the service worker**.
 * The service worker serves the shell and touches no writes at all.
 *
 * ---------------------------------------------------------------------------
 * Why IndexedDB and not localStorage
 *
 * localStorage is synchronous, which means every write to it blocks the main
 * thread — on the one screen whose whole design is a fifteen-second target. It
 * is also capped around 5MB per origin and throws when full, and the thing it
 * would be throwing away is an invoice somebody has already been told is
 * saved. IndexedDB is asynchronous and has room.
 * ---------------------------------------------------------------------------
 */
function idbStorage() {
  return {
    getItem: (key: string) => get<string>(key).then((value) => value ?? null),
    setItem: (key: string, value: string) => set(key, value),
    removeItem: (key: string) => del(key),
  };
}

export function createOfflinePersister() {
  return createAsyncStoragePersister({
    storage: idbStorage(),
    key: 'shg-offline-writes',
    /*
     * The default serialiser, deliberately: JSON, not structured clone.
     *
     * IndexedDB could store the object graph directly and skip a step, but
     * JSON is what makes the failure mode loud. Anything that cannot survive
     * the round trip — a Date, a class instance, an Error — throws here, at
     * the moment it is queued, rather than coming back as something subtly
     * different an hour later. Every payload in this app is already plain
     * data, and this keeps it that way.
     */
    throttleTime: 1_000,
  });
}

/**
 * What gets written to disk, and what is thrown away.
 *
 * Two rules, and both are §7's rather than TanStack's defaults.
 */
export function offlinePersistOptions(
  persister: ReturnType<typeof createOfflinePersister>,
): Omit<PersistQueryClientOptions, 'queryClient'> {
  return {
    persister,

    /*
     * Bumping OFFLINE_SCHEMA discards every queued write on the next load.
     * See the note on it in ./keys.ts — it costs somebody an unsent invoice,
     * and it is still right when a payload's shape changes.
     */
    buster: OFFLINE_SCHEMA,

    /*
     * A week.
     *
     * The number is a judgement about people, not about storage. A write made
     * on a Friday at a supplier's dock and resumed on the Monday is the case
     * this queue exists for. A write made three weeks ago and resumed now is
     * something else: nobody remembers entering it, the invoice has almost
     * certainly been entered again by hand in the meantime, and replaying it
     * quietly adds a second one. Seven days is long enough for the first and
     * short enough to make the second unlikely.
     */
    maxAge: 7 * 24 * 60 * 60 * 1_000,

    dehydrateOptions: {
      /*
       * **No reads are ever persisted.** Notes §1.5, and it is the decision
       * this file would most easily get wrong, because persisting queries is
       * what every tutorial does and it would make the app open instantly
       * while offline.
       *
       * It would also open showing last Tuesday's totals with no indication
       * of their age — and a wrong number that looks authoritative is the
       * exact failure the bug notes call trust-destroying. An honest empty
       * state is worse to look at and better to rely on.
       */
      shouldDehydrateQuery: () => false,

      /*
       * Only paused writes, and only ones `register.ts` knows how to resume.
       *
       * The `isQueueable` half is what stops a mutation being restored that
       * has no function to run — see the note on it in ./keys.ts.
       */
      shouldDehydrateMutation: (mutation) =>
        mutation.state.isPaused && isQueueable(mutation.options.mutationKey),
    },
  };
}
