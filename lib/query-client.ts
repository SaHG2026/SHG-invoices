import { QueryClient } from '@tanstack/react-query';
import { formGuard } from './form-guard';
import { UNPAID_STALE_MS } from './constants';

/**
 * One QueryClient, one cache. Architecture §1: there is no server-side fetch
 * cache to disagree with this one.
 *
 * The two `refetchOn*` options are functions rather than booleans on purpose.
 * TanStack evaluates them at refetch time, so the form guard is consulted at
 * the moment focus returns — not at the moment the query was declared. That
 * is what makes notes §1.1 structurally impossible rather than remembered.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: () => !formGuard.isBlocked(),
        refetchOnReconnect: () => !formGuard.isBlocked(),
        // Notes §1.4: never 0 on a list that receives optimistic updates.
        staleTime: UNPAID_STALE_MS,
        retry: 2,
      },
      mutations: {
        // Writes are queued and resumed when the connection returns rather
        // than failing at the sheet. Notes §1.5.
        networkMode: 'offlineFirst',
        retry: 3,
      },
    },
  });
}
