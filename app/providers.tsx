'use client';

import { useState } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '@/lib/query-client';

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
  const [queryClient] = useState(createQueryClient);

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
