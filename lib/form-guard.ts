/**
 * The background-refetch guard.
 *
 * Notes §1.1: a background refetch wiping a half-filled form shipped three
 * separate times in the previous app. Each time it was fixed in one place and
 * reappeared somewhere else, because the fix was local instead of structural.
 *
 * So this is not a per-component fix. It is one counter, consulted by the
 * QueryClient's own defaults (see lib/query-client.ts). While any form is
 * open, no query anywhere refetches on window focus or on reconnect. A screen
 * added in six months inherits the behaviour without knowing this file exists.
 *
 * The mechanism it defends against: someone opens the add-invoice sheet,
 * switches apps to read the paper docket, comes back. Focus fires, the query
 * refetches, the component re-renders, everything typed is gone. On the most
 * important screen in the app, that is fatal to adoption.
 *
 * A counter rather than a boolean, because a sheet can host a nested dialog
 * and the inner one closing must not unlock the outer one.
 */

let openForms = 0;

type Listener = (blocked: boolean) => void;
const listeners = new Set<Listener>();

function notify(): void {
  const blocked = openForms > 0;
  for (const listener of listeners) listener(blocked);
}

export const formGuard = {
  /** True while at least one form is open. */
  isBlocked(): boolean {
    return openForms > 0;
  },

  /**
   * Claim the guard. Returns the release function — call it exactly once.
   * `useFormGuard()` wires this to a component's mount and unmount.
   */
  acquire(): () => void {
    openForms += 1;
    notify();

    let released = false;
    return () => {
      if (released) return; // double-release must not unbalance the counter
      released = true;
      openForms = Math.max(0, openForms - 1);
      notify();
    };
  },

  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  /** Test-only. Never called by application code. */
  __reset(): void {
    openForms = 0;
    listeners.clear();
  },
};
