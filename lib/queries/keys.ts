/**
 * Every query key in the app, in one place.
 *
 * Keys are what invalidation targets, so scattering them across files is how
 * an optimistic update ends up writing to one key and the refetch reading
 * another — the row flickers back and nobody can see why (notes §1.4).
 */
export const qk = {
  profiles: {
    all: ['profiles'] as const,
    me: ['profiles', 'me'] as const,
  },
  businesses: {
    all: ['businesses'] as const,
  },
  suppliers: {
    all: ['suppliers'] as const,
  },
  invoices: {
    /**
     * Every unpaid invoice, unfiltered. Architecture §2: Home, Pending, the
     * payment runs, every sort and every total are derived from this one
     * cache entry, which is what stops a total disagreeing with the list
     * above it. Business and supplier filters are NOT part of the key.
     */
    unpaid: ['invoices', 'unpaid'] as const,
    detail: (id: string) => ['invoices', 'detail', id] as const,
    history: (filters: Record<string, unknown>) => ['invoices', 'history', filters] as const,
  },
  activity: {
    forInvoice: (id: string) => ['activity', 'invoice', id] as const,
    recent: ['activity', 'recent'] as const,
  },
} as const;
