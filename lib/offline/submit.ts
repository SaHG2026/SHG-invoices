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
 * What a database refusal actually said.
 *
 * `PostgrestError` carries four fields and this used to read one of them. The
 * library's own documentation is explicit that `hint` is usually the most
 * useful — for a `42501` it is literally the SQL that would fix it — and that
 * `code` is the thing to branch on rather than the message text.
 *
 * Pulled out separately from the sentence shown to a person, because the two
 * jobs are different: somebody standing at a counter needs one plain line, and
 * whoever they then ring needs the code.
 */
export interface WriteFailure {
  /** One plain sentence, safe to show anybody. */
  message: string;
  /** '42501', '23505', 'PGRST301' — empty when there was none. */
  code: string;
  /** Postgres' own suggested fix, when it had one. Never shown; logged. */
  hint: string;
  details: string;
}

/**
 * Codes worth saying in English, because the database's own words are not.
 *
 * "new row violates row-level security policy for table \"invoices\"" is
 * accurate and means nothing to somebody holding a docket. Everything not
 * listed falls through to the message, which is right — an unknown code is
 * exactly when the raw text is worth reading.
 */
const PLAIN: Record<string, string> = {
  '42501': 'This account isn’t allowed to do that.',
  '23505': 'That already exists.',
  '23503': 'Something it refers to is missing.',
  '23514': 'The database refused those values.',
  P0001: 'The database refused it.',
  PGRST301: 'Your session has expired. Sign in again.',
};

export function describeWriteFailure(error: unknown): WriteFailure {
  const raw = (error ?? {}) as Record<string, unknown>;
  const str = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

  return {
    message: error instanceof Error ? error.message.trim() : str(raw.message),
    code: str(raw.code),
    hint: str(raw.hint),
    details: str(raw.details),
  };
}

/**
 * What to say when a write is refused.
 *
 * Notes §6: name the cause, not the fix. **And the code is part of the cause.**
 *
 * This used to return a bare fallback whenever it could not read a message,
 * which meant a refusal and a network failure and a broken policy all produced
 * the same sentence — "Couldn't save that invoice. Nothing was written." True,
 * and useless to whoever has to work out why. The code is appended so the
 * person on the phone can read it out, and the hint goes to the console for
 * whoever picks it up afterwards.
 */
export function writeFailureMessage(error: unknown, fallback: string): string {
  const failure = describeWriteFailure(error);

  if (failure.hint || failure.details) {
    // Never shown, always available. The library's docs: logging only the
    // message hides the one field that says how to fix it.
    console.error('write refused', failure);
  }

  const plain = PLAIN[failure.code] ?? failure.message ?? '';
  const sentence = plain.trim() !== '' ? plain : fallback;

  return failure.code ? `${sentence} (${failure.code})` : sentence;
}
