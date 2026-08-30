/**
 * Payment runs. Spec §6.
 *
 * Unpaid invoices sharing a supplier and a due date collapse into one row,
 * because that is how they get paid — one transfer, one reference. Ticking
 * the run marks every child paid in a single transaction (notes §1.6); the
 * grouping here is what decides which ids go into that one call.
 */

import { compareDates } from '../date';
import { sumCents } from '../money';
import type { InvoiceRow, PaymentRun } from '../types';

export function runKey(supplierId: string, dueDate: string): string {
  return `${supplierId}:${dueDate}`;
}

/**
 * Group into payment runs, largest urgency first (earliest due date), then by
 * supplier name so the order is stable between renders and between people.
 *
 * A supplier with a single invoice on a date still produces a run of one.
 * Keeping one shape rather than two — sometimes an invoice, sometimes a run —
 * means the tick-off path has no branch, and so no half-branch to get wrong.
 */
export function groupIntoRuns(rows: ReadonlyArray<InvoiceRow>): PaymentRun[] {
  const byKey = new Map<string, PaymentRun>();

  for (const row of rows) {
    const key = runKey(row.supplier_id, row.due_date);
    const existing = byKey.get(key);

    if (existing) {
      existing.invoices.push(row);
    } else {
      byKey.set(key, {
        key,
        supplier: row.supplier,
        due_date: row.due_date,
        invoices: [row],
        total_cents: 0,
      });
    }
  }

  const runs = [...byKey.values()];

  for (const run of runs) {
    // Oldest invoice first inside a run, so expanding reads chronologically.
    run.invoices.sort(
      (a, b) => compareDates(a.invoice_date, b.invoice_date) || a.internal_ref.localeCompare(b.internal_ref),
    );
    /*
     * What is still owed on this run, not what it was worth.
     *
     * A run keeps invoices ticked off during this session so it does not
     * collapse under the person reading it (lib/recently-paid.ts). Summing
     * them all would leave the run's figure unchanged after a payment, which
     * is money on screen that has already gone.
     */
    run.total_cents = sumCents(run.invoices.filter((invoice) => invoice.status === 'unpaid'));
  }

  runs.sort(
    (a, b) => compareDates(a.due_date, b.due_date) || a.supplier.name.localeCompare(b.supplier.name),
  );

  return runs;
}

/** The invoice ids a "mark run paid" call sends to `mark_invoices_paid`. */
export function runInvoiceIds(run: PaymentRun): string[] {
  return run.invoices.map((invoice) => invoice.id);
}
