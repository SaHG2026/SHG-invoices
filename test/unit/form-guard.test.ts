import { afterEach, describe, expect, it, vi } from 'vitest';
import { formGuard } from '@/lib/form-guard';
import { createQueryClient } from '@/lib/query-client';

afterEach(() => formGuard.__reset());

describe('formGuard', () => {
  it('blocks while a form is open and releases when it closes', () => {
    expect(formGuard.isBlocked()).toBe(false);
    const release = formGuard.acquire();
    expect(formGuard.isBlocked()).toBe(true);
    release();
    expect(formGuard.isBlocked()).toBe(false);
  });

  it('counts, so a nested dialog closing does not unlock the sheet under it', () => {
    const releaseSheet = formGuard.acquire();
    const releaseDialog = formGuard.acquire();

    releaseDialog();
    expect(formGuard.isBlocked()).toBe(true); // the sheet is still open

    releaseSheet();
    expect(formGuard.isBlocked()).toBe(false);
  });

  it('ignores a double release rather than going negative', () => {
    const releaseA = formGuard.acquire();
    const releaseB = formGuard.acquire();

    releaseA();
    releaseA(); // React strict mode, or a careless effect cleanup
    expect(formGuard.isBlocked()).toBe(true);

    releaseB();
    expect(formGuard.isBlocked()).toBe(false);
  });

  it('notifies subscribers', () => {
    const seen: boolean[] = [];
    const unsubscribe = formGuard.subscribe((blocked) => seen.push(blocked));

    const release = formGuard.acquire();
    release();
    unsubscribe();

    expect(seen).toEqual([true, false]);
  });
});

describe('the QueryClient consults the guard — notes §1.1', () => {
  /**
   * The bug: open the add-invoice sheet, switch apps to read the paper docket,
   * come back. Focus fires, the query refetches, the component re-renders,
   * everything typed is gone. It shipped three times in the previous app
   * because each fix was local.
   *
   * These assertions are on the global default rather than on any screen,
   * which is the whole point — a screen written in six months inherits it.
   */
  it('wires refetchOnWindowFocus and refetchOnReconnect to the guard', () => {
    const client = createQueryClient();
    const defaults = client.getDefaultOptions().queries!;

    const onFocus = defaults.refetchOnWindowFocus as () => boolean;
    const onReconnect = defaults.refetchOnReconnect as () => boolean;

    expect(typeof onFocus).toBe('function');
    expect(typeof onReconnect).toBe('function');

    expect(onFocus()).toBe(true);
    expect(onReconnect()).toBe(true);

    const release = formGuard.acquire();
    expect(onFocus()).toBe(false);
    expect(onReconnect()).toBe(false);

    release();
    expect(onFocus()).toBe(true);
  });

  it('is evaluated at refetch time, not at declaration time', () => {
    // If these were booleans read once when the client was built, opening a
    // sheet afterwards would have no effect. Prove the guard is consulted late.
    const client = createQueryClient();
    const onFocus = client.getDefaultOptions().queries!.refetchOnWindowFocus as () => boolean;

    const results: boolean[] = [];
    results.push(onFocus());
    const release = formGuard.acquire();
    results.push(onFocus());
    release();
    results.push(onFocus());

    expect(results).toEqual([true, false, true]);
  });

  it('never sets staleTime to 0 on a list that takes optimistic updates', () => {
    // Notes §1.4.
    const client = createQueryClient();
    expect(client.getDefaultOptions().queries!.staleTime).toBeGreaterThan(0);
  });
});

describe('no stray timers', () => {
  it('the guard schedules nothing', () => {
    const spy = vi.spyOn(globalThis, 'setInterval');
    const release = formGuard.acquire();
    release();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
