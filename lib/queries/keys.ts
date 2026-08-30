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
  /**
   * Deli Delights' customers. A separate key from suppliers, not a filter on
   * one shared key — ARCHITECTURE §17. Nothing here ever feeds a total.
   */
  customers: {
    all: ['customers'] as const,
    withInactive: ['customers', 'all-including-inactive'] as const,
  },
  invoices: {
    /**
     * The prefix every invoice list shares.
     *
     * Invalidating this covers the unpaid list, one invoice's detail, the
     * history and a supplier's invoices in one call. They were separate keys
     * and only the unpaid list was invalidated after a payment — so ticking an
     * invoice off a supplier page did nothing visible, and the natural
     * response was to tap again.
     */
    all: ['invoices'] as const,
    /**
     * Every unpaid invoice, unfiltered. Architecture §2: Home, Pending, the
     * payment runs, every sort and every total are derived from this one
     * cache entry, which is what stops a total disagreeing with the list
     * above it. Business and supplier filters are NOT part of the key.
     */
    unpaid: ['invoices', 'unpaid'] as const,
    detail: (id: string) => ['invoices', 'detail', id] as const,
    history: (filters: Record<string, unknown>) => ['invoices', 'history', filters] as const,
    forSupplier: (supplierId: string) => ['invoices', 'supplier', supplierId] as const,
  },
  activity: {
    forInvoice: (id: string) => ['activity', 'invoice', id] as const,
    recent: ['activity', 'recent'] as const,
  },
} as const;
