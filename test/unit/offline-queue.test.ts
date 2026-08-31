import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, onlineManager } from '@tanstack/react-query';
import { QUEUEABLE_KEYS, isQueueable, mk } from '@/lib/offline/keys';
import { unregisteredKeys } from '@/lib/offline/register';
import { createOfflinePersister, offlinePersistOptions } from '@/lib/offline/persister';
import { submitWrite, writeFailureMessage } from '@/lib/offline/submit';

/**
 * The queue, tested where it actually breaks.
 *
 * Everything here is about the same failure: a write that a person was told
 * was safe, which then quietly never happens. It has no symptom at the
 * keyboard, none in review, and none in the test run unless something like
 * this stands over it — it appears days later as an invoice somebody is sure
 * they entered.
 */

afterEach(() => {
  onlineManager.setOnline(true);
});

describe('every queueable write can actually be resumed', () => {
  /**
   * The one that would otherwise be found on a phone in a car park.
   *
   * A restored write is matched to its function by key. Add a write to `mk`,
   * forget to register it, and it persists happily, restores happily, and then
   * fails on resume with "no mutationFn found" — after the person has closed
   * the app believing it was saved.
   */
  it('has a registered mutationFn for every key in mk', () => {
    expect(unregisteredKeys(new QueryClient())).toEqual([]);
  });

  it('lists every key that mk defines', () => {
    // Guards the other direction: a key added to `mk` and left out of
    // QUEUEABLE_KEYS is never persisted at all, and the write is lost on close
    // rather than failing loudly.
    const declared = Object.values(mk).flatMap((group) => Object.values(group));
    expect(QUEUEABLE_KEYS).toHaveLength(declared.length);
  });
});

describe('isQueueable', () => {
  it('recognises a known key', () => {
    expect(isQueueable(['invoices', 'create'])).toBe(true);
  });

  it('rejects a key nobody registered', () => {
    expect(isQueueable(['invoices', 'delete'])).toBe(false);
  });

  it('does not match on a prefix', () => {
    // ['invoices'] is the query key for every invoice list. Matching it here
    // would persist mutations that have no function of their own.
    expect(isQueueable(['invoices'])).toBe(false);
    expect(isQueueable(['invoices', 'create', 'extra'])).toBe(false);
  });

  it('rejects a mutation with no key at all', () => {
    expect(isQueueable(undefined)).toBe(false);
  });
});

describe('what reaches the disk', () => {
  const options = offlinePersistOptions(createOfflinePersister());
  const dehydrate = options.dehydrateOptions!;

  /**
   * Notes §1.5, and the decision most likely to be reversed by somebody trying
   * to make the app open faster offline. It must not be: an hours-stale total
   * that looks current is the trust-destroying failure the bug notes name.
   */
  it('never persists a read', () => {
    expect(dehydrate.shouldDehydrateQuery!({} as never)).toBe(false);
  });

  const mutation = (isPaused: boolean, mutationKey: unknown) =>
    ({ state: { isPaused }, options: { mutationKey } }) as never;

  it('persists a paused write we know how to resume', () => {
    expect(dehydrate.shouldDehydrateMutation!(mutation(true, mk.invoices.create))).toBe(true);
  });

  it('does not persist a write that is already running', () => {
    expect(dehydrate.shouldDehydrateMutation!(mutation(false, mk.invoices.create))).toBe(false);
  });

  it('refuses to store a paused write it could not resume', () => {
    // Dropped rather than stored: a stored write with no function fails after
    // the session that made it has gone, where nobody can be told.
    expect(dehydrate.shouldDehydrateMutation!(mutation(true, ['something', 'new']))).toBe(false);
  });
});

describe('submitWrite tells the truth about all three outcomes', () => {
  const online = { mutate: vi.fn(), mutateAsync: vi.fn() };

  it('reports saved, with what came back', async () => {
    const mutation = { mutate: vi.fn(), mutateAsync: vi.fn().mockResolvedValue({ ref: 'GMH-01' }) };
    await expect(submitWrite(mutation, { a: 1 })).resolves.toEqual({
      kind: 'saved',
      data: { ref: 'GMH-01' },
    });
  });

  /**
   * The bug this whole module exists for. A paused mutation never settles, so
   * awaiting one offline hangs forever — which is why the offline path starts
   * the write with `mutate` and does not await anything.
   */
  it('reports queued without awaiting, when offline', async () => {
    onlineManager.setOnline(false);
    const mutation = {
      mutate: vi.fn(),
      mutateAsync: vi.fn(() => new Promise<never>(() => {})), // never settles, like the real one
    };

    await expect(submitWrite(mutation, { a: 1 })).resolves.toEqual({ kind: 'queued' });
    expect(mutation.mutate).toHaveBeenCalledWith({ a: 1 });
    expect(mutation.mutateAsync).not.toHaveBeenCalled();
  });

  it('reports failed when the write was refused, and does not call it queued', async () => {
    const refusal = new Error('new row violates row-level security policy');
    const mutation = { ...online, mutateAsync: vi.fn().mockRejectedValue(refusal) };

    await expect(submitWrite(mutation, { a: 1 })).resolves.toEqual({
      kind: 'failed',
      error: refusal,
    });
  });

  it('reports queued when the connection dropped mid-request', async () => {
    // TanStack pauses the retry rather than failing, so the write is waiting
    // rather than lost. Saying "couldn't save" would send somebody to enter it
    // a second time.
    const mutation = {
      ...online,
      mutateAsync: vi.fn().mockImplementation(() => {
        onlineManager.setOnline(false);
        return Promise.reject(new Error('network error'));
      }),
    };

    await expect(submitWrite(mutation, { a: 1 })).resolves.toEqual({ kind: 'queued' });
  });
});

describe('writeFailureMessage', () => {
  it('prefers the cause the database gave', () => {
    expect(writeFailureMessage(new Error('There is already a supplier called Bidfood.'), 'no')).toBe(
      'There is already a supplier called Bidfood.',
    );
  });

  it('falls back when there is nothing useful to say', () => {
    expect(writeFailureMessage(new Error('   '), 'Could not save.')).toBe('Could not save.');
    expect(writeFailureMessage({ weird: true }, 'Could not save.')).toBe('Could not save.');
  });
});
