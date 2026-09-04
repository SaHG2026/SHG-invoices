/**
 * Every write's mutation key, in one place.
 *
 * The counterpart to `lib/queries/keys.ts`, and it exists for a sharper reason
 * than symmetry.
 *
 * A queued write outlives the screen that started it — and outlives the whole
 * running app. When the phone comes back online after being closed, TanStack
 * restores mutations from IndexedDB as a **key plus its variables**, and
 * nothing else: the function that was going to run is long gone. It finds the
 * function again by looking the key up in the defaults registered at startup
 * (`lib/offline/register.ts`).
 *
 * Which makes these keys load-bearing in a way query keys are not. Rename one
 * without a migration and every write queued under the old name becomes an
 * orphan: restored, resumed, and unable to find a function to run. That is why
 * they live here, why they are literals rather than derived, and why
 * `OFFLINE_SCHEMA` below exists.
 */

export const mk = {
  invoices: {
    create: ['invoices', 'create'] as const,
  },
  payments: {
    markPaid: ['payments', 'mark-paid'] as const,
    unmarkPaid: ['payments', 'unmark-paid'] as const,
    voidInvoice: ['payments', 'void'] as const,
  },
  notes: {
    add: ['notes', 'add'] as const,
  },
  suppliers: {
    create: ['suppliers', 'create'] as const,
    update: ['suppliers', 'update'] as const,
  },
  customers: {
    create: ['customers', 'create'] as const,
    update: ['customers', 'update'] as const,
  },
  sales: {
    create: ['sales', 'create'] as const,
    markReceived: ['sales', 'mark-received'] as const,
    unmarkReceived: ['sales', 'unmark-received'] as const,
  },
  /**
   * A venue logging its own invoice.
   *
   * Its own key rather than `invoices.create`, for a reason that is not
   * tidiness: the two send different requests. A venue account has no SELECT
   * policy on `invoices` (CATCH_UP_010 §4), so its insert must not ask for the
   * row back — `.select()` would read the base table and hand over the very
   * status columns the whole feature exists to withhold. One key, one
   * function, one request shape.
   */
  venue: {
    create: ['venue', 'create'] as const,
    /**
     * A venue correcting an invoice inside its five-minute window.
     *
     * Queueable like every other write, and the window is measured by the
     * DATABASE against `created_at`, not by the queue. So an edit made in a
     * dead spot and sent twenty minutes later is refused — correctly. The
     * alternative, a client-side clock deciding, would mean a shop with a
     * wrong phone clock editing an invoice from last Tuesday.
     */
    update: ['venue', 'update'] as const,
  },
} as const;

/**
 * Bumped whenever a queued write's variables change shape.
 *
 * It is the buster on the persisted cache, so raising it throws away anything
 * already queued on every device that loads the new build.
 *
 * **That is a real cost and the reason to think before bumping it**: somebody's
 * unsent invoice disappears without ever having been saved. It is still the
 * right move when the shape changes, because the alternative is a resumed
 * write whose variables the new code reads wrongly — and a wrong invoice is
 * worse than a missing one, because nobody goes looking for it.
 *
 * Leave it alone for changes that do not touch what a mutation is *called
 * with*. Adding a screen, changing a total, repainting: none of those.
 */
export const OFFLINE_SCHEMA = 'v1';

/** Every key above, flattened — what `register.ts` and the persister check against. */
export const QUEUEABLE_KEYS: readonly (readonly string[])[] = [
  mk.invoices.create,
  mk.payments.markPaid,
  mk.payments.unmarkPaid,
  mk.payments.voidInvoice,
  mk.notes.add,
  mk.suppliers.create,
  mk.suppliers.update,
  mk.customers.create,
  mk.customers.update,
  mk.sales.create,
  mk.sales.markReceived,
  mk.sales.unmarkReceived,
  mk.venue.create,
  mk.venue.update,
];

/**
 * Is this mutation one we know how to resume?
 *
 * The persister asks before writing anything to disk, so an unregistered
 * mutation is **dropped rather than stored**. That ordering matters: a stored
 * mutation with no registered function fails on resume with "no mutationFn
 * found", which surfaces as a write that silently never happened. Refusing to
 * store it at least keeps the failure inside the session that made it, where
 * the person is still standing in front of the screen.
 */
export function isQueueable(mutationKey: unknown): boolean {
  if (!Array.isArray(mutationKey)) return false;
  return QUEUEABLE_KEYS.some(
    (known) =>
      known.length === mutationKey.length &&
      known.every((segment, index) => segment === mutationKey[index]),
  );
}
