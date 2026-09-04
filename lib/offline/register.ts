import type { QueryClient } from '@tanstack/react-query';
import { registerInvoiceMutations } from '@/lib/queries/invoices';
import { registerPaymentMutations } from '@/lib/queries/payments';
import { registerNoteMutations } from '@/lib/queries/detail';
import { registerSupplierMutations } from '@/lib/queries/reference';
import { registerSupplierEditMutations } from '@/lib/queries/history';
import { registerCustomerMutations } from '@/lib/queries/customers';
import { registerSalesMutations } from '@/lib/queries/sales';
import { registerVenueMutations, registerVenueUpdateMutations } from '@/lib/queries/venue';
import { QUEUEABLE_KEYS } from './keys';

/**
 * Teach the query client how to run every write, before any of them run.
 *
 * Called once, at app startup, from `app/providers.tsx` — and it must be
 * called before the persister restores anything, or a write queued yesterday
 * comes back to find no function under its key.
 *
 * ---------------------------------------------------------------------------
 * Why the implementations are still in `lib/queries/*` and only the wiring is
 * here
 *
 * The obvious alternative is one file holding all eleven mutation functions.
 * It would put the whole offline story in one place, and it would separate
 * each write from the query keys it invalidates, the types it uses and the
 * reasoning written beside it. Every one of those is a stronger relationship
 * than "is also queueable".
 *
 * So each module registers its own, and this file's whole job is to be the
 * list — the thing you read to find out what the app can do while offline,
 * and the thing that fails to compile when somebody adds a write and forgets.
 * ---------------------------------------------------------------------------
 */
export function registerMutationDefaults(queryClient: QueryClient) {
  registerInvoiceMutations(queryClient);
  registerPaymentMutations(queryClient);
  registerNoteMutations(queryClient);
  registerSupplierMutations(queryClient);
  registerSupplierEditMutations(queryClient);
  registerCustomerMutations(queryClient);
  registerSalesMutations(queryClient);
  registerVenueMutations(queryClient);
  registerVenueUpdateMutations(queryClient);
}

/**
 * Every key in `mk` has a function registered under it.
 *
 * The failure this catches is quiet and slow: a write added to `mk`, persisted
 * because `isQueueable` says so, and resumed a day later against a client that
 * has no function for it. Nothing goes wrong at the keyboard, on the test run,
 * or in review — it goes wrong on somebody's phone in a car park, and the
 * symptom is an invoice that was entered and is not there.
 *
 * Exported rather than called at startup because a test is the right place to
 * find out. `test/unit/offline-queue.test.ts` runs it.
 */
export function unregisteredKeys(queryClient: QueryClient): string[] {
  registerMutationDefaults(queryClient);

  return QUEUEABLE_KEYS.filter(
    (key) => queryClient.getMutationDefaults([...key]).mutationFn === undefined,
  ).map((key) => key.join('/'));
}
