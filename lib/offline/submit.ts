'use client';

import { onlineManager } from '@tanstack/react-query';

/**
 * How a screen finds out what actually happened to a write.
 *
 * ---------------------------------------------------------------------------
 * The bug this exists to remove, because it was already shipped
 *
 * The add-invoice sheet did this:
 *
 *     try   { await createInvoice.mutateAsync(...); toast('Saved · REF') }
 *     catch { toast('Saved — will send when you’re back online.') }
 *
 * which reads correctly and is wrong twice.
 *
 * **A paused mutation never settles.** `networkMode: 'offlineFirst'` means an
 * offline write is not attempted and not rejected — it waits. So `await` does
 * not throw, it hangs, and the catch that was written to handle being offline
 * is the one branch being offline can never reach. The person got no message
 * at all: the sheet closed and nothing was said.
 *
 * **And the catch lied about everything else.** A write refused by RLS, a
 * malformed payload, a supplier that no longer exists — all of them landed in
 * a catch that says "Saved". In a payments ledger, "saved" when nothing was
 * saved is the worst sentence the app can say.
 *
 * Three outcomes exist, so this returns three.
 * ---------------------------------------------------------------------------
 */
export type WriteOutcome<TData> =
  /** It reached the database. `data` is what came back. */
  | { kind: 'saved'; data: TData }
  /** It is on the phone, in IndexedDB, and will be sent when there is signal. */
  | { kind: 'queued' }
  /** It was refused. Nothing was written and nothing is waiting. */
  | { kind: 'failed'; error: unknown };

interface Submittable<TData, TVariables> {
  mutate: (variables: TVariables) => void;
  mutateAsync: (variables: TVariables) => Promise<TData>;
}

/**
 * Start a write and say honestly which of the three happened.
 *
 * Offline is checked **before** starting rather than after failing, because of
 * the never-settles problem above: once a mutation is paused there is nothing
 * to await. `mutate` (not `mutateAsync`) is used on that path deliberately —
 * it starts the mutation, lets it pause, and returns immediately, which is
 * what leaves a promise nobody is holding.
 *
 * The catch re-checks. Going offline *during* a request is the case that
 * reaches it: TanStack pauses the retry rather than failing, so if we are
 * offline by the time we get here the write is waiting rather than lost, and
 * saying "couldn't save" would send somebody to re-enter an invoice that is
 * about to arrive twice.
 */
export async function submitWrite<TData, TVariables>(
  mutation: Submittable<TData, TVariables>,
  variables: TVariables,
): Promise<WriteOutcome<TData>> {
  if (!onlineManager.isOnline()) {
    mutation.mutate(variables);
    return { kind: 'queued' };
  }

  try {
    return { kind: 'saved', data: await mutation.mutateAsync(variables) };
  } catch (error) {
    if (!onlineManager.isOnline()) return { kind: 'queued' };
    return { kind: 'failed', error };
  }
}

/**
 * What to say when a write is refused.
 *
 * Notes §6: name the cause, not the fix. The message from a thrown Error is
 * almost always the useful one — "There is already a customer called Bidfood"
 * — and the fallback is only for the cases where something non-Error came back
 * from the network layer.
 */
export function writeFailureMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() !== '' ? error.message : fallback;
}
