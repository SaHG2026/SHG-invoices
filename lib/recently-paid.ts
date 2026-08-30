'use client';

import { useSyncExternalStore } from 'react';
import type { InvoiceRow } from './types';

/**
 * Invoices ticked off during this session, kept on screen.
 *
 * ---------------------------------------------------------------------------
 * The bug this exists to fix.
 *
 * Two invoices from one supplier sharing a due date collapse into a payment
 * run (spec §6). Tick one, the refetch drops it, the run falls to a single
 * invoice — and a run of one does not render as an expanded group at all, it
 * renders as one plain row somewhere else in the list. So both child rows left
 * the screen at once, and the honest report was "ticking one erased both".
 *
 * Nothing was ever wrong in the database: `mark_invoices_paid` only touches
 * the ids it is handed. The row was wrong about what had happened.
 *
 * Keeping the paid invoice on screen fixes it at the root. The run stays a run
 * of two, one of them struck through, and nothing moves that you did not move.
 * ---------------------------------------------------------------------------
 *
 * In memory, deliberately — not localStorage. "Until the session is over" is
 * what the client asked for, and a struck-through row surviving a reload would
 * be a paid invoice sitting in a list of unpaid ones with no way to explain
 * itself. Closing the app is the natural end of the thought.
 *
 * These rows carry `status: 'paid'`, and every total in the app filters on
 * status (see `onlyUnpaid` in lib/derive/select.ts). A paid row on screen
 * therefore contributes nothing to any figure — which is the invariant notes
 * §3 cares about, kept by construction rather than by remembering.
 */

let paid: ReadonlyMap<string, InvoiceRow> = new Map();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

/** Called after the database confirms the tick, never optimistically. */
export function rememberPaid(invoices: readonly InvoiceRow[]): void {
  if (invoices.length === 0) return;
  const next = new Map(paid);
  for (const invoice of invoices) next.set(invoice.id, invoice);
  paid = next;
  emit();
}

/** Undo puts it back to unpaid, so it stops being a remembered paid row. */
export function forgetPaid(id: string): void {
  if (!paid.has(id)) return;
  const next = new Map(paid);
  next.delete(id);
  paid = next;
  emit();
}

/** Sign-out clears it, the same way it clears the device lock. */
export function clearRecentlyPaid(): void {
  if (paid.size === 0) return;
  paid = new Map();
  emit();
}

export function recentlyPaidSnapshot(): ReadonlyMap<string, InvoiceRow> {
  return paid;
}

/*
 * A stable empty map for the server snapshot.
 *
 * useSyncExternalStore calls getServerSnapshot during SSR and compares it by
 * identity on hydration; returning `new Map()` each time is a new object every
 * render and React loops. Nothing is ticked off on the server anyway.
 */
const EMPTY: ReadonlyMap<string, InvoiceRow> = new Map();

export function useRecentlyPaid(): ReadonlyMap<string, InvoiceRow> {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    recentlyPaidSnapshot,
    () => EMPTY,
  );
}

/**
 * Fold the session's paid invoices back into a freshly fetched unpaid list.
 *
 * Anything the server still returns wins — if somebody un-ticked it elsewhere
 * it is genuinely unpaid again, and the server's row is the true one.
 */
export function mergeRecentlyPaid(
  rows: readonly InvoiceRow[],
  remembered: ReadonlyMap<string, InvoiceRow>,
): InvoiceRow[] {
  if (remembered.size === 0) return [...rows];

  const present = new Set(rows.map((row) => row.id));
  const extra = [...remembered.values()].filter((row) => !present.has(row.id));
  return extra.length === 0 ? [...rows] : [...rows, ...extra];
}
