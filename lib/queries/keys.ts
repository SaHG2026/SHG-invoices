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
    /**
     * The other half of `unpaid`: entered by a venue, not yet accepted.
     *
     * Disjoint from `unpaid` by construction — one query asks for
     * `approved_at is not null`, the other for `is null` — so no invoice can
     * be in both, and nothing here can reach an owed total.
     */
    review: ['invoices', 'review'] as const,
    reviewNotes: (ids: string) => ['invoices', 'review', 'notes', ids] as const,
    forSupplier: (supplierId: string) => ['invoices', 'supplier', supplierId] as const,
    /**
     * One supplier, one date range — its own cache entry, not a filter over
     * `forSupplier`.
     *
     * `forSupplier` is capped at 300 rows for the page's own lists. A range
     * asked about two years ago would silently fall off the end of that cap and
     * report a total missing its oldest invoices, which is notes §3's
     * trust-destroying bug arrived at by arithmetic rather than by a second
     * query. So the range asks the database its own question.
     */
    forSupplierRange: (supplierId: string, range: Record<string, unknown>) =>
      ['invoices', 'supplier', supplierId, 'range', range] as const,
  },
  /**
   * Deli's price list. Scoped by business, because a price is a fact about who
   * is selling the thing.
   */
  products: {
    all: ['products'] as const,
    forBusiness: (businessId: string) => ['products', businessId] as const,
    withInactive: (businessId: string) => ['products', businessId, 'all'] as const,
  },
  /**
   * Invoices Deli Delights has sent. A separate key from `invoices`, not a
   * filter on it — ARCHITECTURE §17. Nothing here feeds an owed total.
   */
  sales: {
    all: ['sales'] as const,
    outstanding: ['sales', 'outstanding'] as const,
    forCustomer: (customerId: string) => ['sales', 'customer', customerId] as const,
    /** One issued invoice and its lines, for the record and the document. */
    detail: (id: string) => ['sales', 'detail', id] as const,
  },
  /**
   * What a venue account sees: the `staff_invoices` view, its own venue only.
   *
   * A separate key from `invoices`, and not a filter on one — the same
   * reasoning ARCHITECTURE §17 gives for the two ledgers. These rows have no
   * `status` column at all (CATCH_UP_010 §3), so anything that reached them
   * through an invoice key would be a different shape than every consumer of
   * that key expects, and `onlyUnpaid` would silently return all of them.
   *
   * There is no `unpaid` sibling here on purpose. A venue is never told what
   * has been paid, so it has no unpaid list to hold.
   */
  venue: {
    invoices: ['venue', 'invoices'] as const,
  },
  activity: {
    forInvoice: (id: string) => ['activity', 'invoice', id] as const,
    recent: ['activity', 'recent'] as const,
  },
} as const;
