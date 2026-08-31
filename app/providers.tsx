'use client';

import { useState } from 'react';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { createQueryClient } from '@/lib/query-client';
import { createOfflinePersister, offlinePersistOptions } from '@/lib/offline/persister';
import { registerMutationDefaults } from '@/lib/offline/register';
import { ToastProvider } from '@/components/ui/Toast';
import { BrandAssetsProvider } from '@/lib/brand/context';
import { ServiceWorker } from '@/components/app/ServiceWorker';

/**
 * One QueryClient for the life of the app.
 *
 * Created inside useState rather than at module scope: at module scope it
 * would be shared between requests during server rendering, which leaks one
 * person's cached data into another's page. Here it is per-browser, created
 * once, and never recreated on re-render.
 *
 * The client's defaults are where the form guard is wired in — see
 * lib/query-client.ts and notes §1.1.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [{ queryClient, persistOptions }] = useState(() => {
    const client = createQueryClient();

    /*
     * Before anything is restored, not after.
     *
     * `PersistQueryClientProvider` starts reading IndexedDB on its first
     * render, and a write restored from yesterday is resumed by looking its
     * function up by key. Registering after the restore would be a race whose
     * losing side is an invoice that silently never sends — so it happens here,
     * in the same synchronous block that makes the client.
     */
    registerMutationDefaults(client);

    return { queryClient: client, persistOptions: offlinePersistOptions(createOfflinePersister()) };
  });

  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={persistOptions}
      /*
       * Fired once the queue has been read back off the disk. Resuming here
       * covers the app being opened while already online — the case where
       * nothing is going to fire a reconnect event, because the connection
       * never went away from this session's point of view. TanStack handles
       * the other case itself: coming back online later resumes the queue
       * without being asked.
       */
      onSuccess={() => {
        void queryClient.resumePausedMutations();
      }}
    >
      <ToastProvider>
        <ServiceWorker />
        <BrandAssetsProvider>{children}</BrandAssetsProvider>
      </ToastProvider>
    </PersistQueryClientProvider>
  );
}
