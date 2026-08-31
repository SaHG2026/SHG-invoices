'use client';

import { QueryClientContext, onlineManager } from '@tanstack/react-query';
import { useCallback, useContext, useSyncExternalStore } from 'react';

/**
 * How many writes are waiting for signal.
 *
 * ARCHITECTURE §7: "a pill in the header shows the pending count". This is
 * where that number comes from, and it is deliberately the queue's own count
 * rather than a counter the app increments — a hand-kept tally of unsent work
 * is exactly the kind of second source of truth that notes §3 warns about, and
 * the failure mode is a badge saying 1 with nothing behind it.
 *
 * ---------------------------------------------------------------------------
 * Read from the context directly, rather than through `useMutationState`
 *
 * `useMutationState` calls `useQueryClient`, which throws when there is no
 * provider above it. That is right for a screen — a screen with no query
 * client cannot show anything true — and wrong for this, which lives in the
 * header of every screen including the ones rendered in isolation by tests.
 *
 * With no client there is no queue, so the honest answer is zero rather than a
 * crash. It cannot hide a real misconfiguration either: an app that somehow
 * booted without a query client would have every screen throwing from its own
 * queries long before anybody looked at the header.
 * ---------------------------------------------------------------------------
 */
export function useQueuedWriteCount(): number {
  const client = useContext(QueryClientContext);

  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!client) return () => {};
      /*
       * The mutation cache, not a query. It fires when a write is queued and
       * again when it drains — including when it drains half a second after
       * the wifi returns with nobody touching the screen, which is the moment
       * this number most needs to change by itself.
       */
      return client.getMutationCache().subscribe(onChange);
    },
    [client],
  );

  return useSyncExternalStore(
    subscribe,
    () =>
      client
        ? client
            .getMutationCache()
            .getAll()
            .filter((mutation) => mutation.state.isPaused).length
        : 0,
    () => 0,
  );
}

/**
 * Is the phone online, as TanStack sees it.
 *
 * Read through `onlineManager` rather than `navigator.onLine` so that the
 * header and the queue can never disagree: this is the same flag that decides
 * whether a mutation runs or pauses. `navigator.onLine` is also a weaker claim
 * than it looks — it reports whether there is a network interface, not whether
 * anything is reachable over it.
 */
export function useIsOnline(): boolean {
  return useSyncExternalStore(
    (callback) => onlineManager.subscribe(callback),
    () => onlineManager.isOnline(),
    // On the server there is no such thing as an offline phone, and rendering
    // the offline banner into the HTML would flash it on every cold load.
    () => true,
  );
}
