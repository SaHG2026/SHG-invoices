/**
 * Urgency is derived at read time. It is never stored.
 *
 * Notes §8: storing it means a scheduled job that will one day fail quietly
 * and be trusted anyway. So it lives here, as a pure function of a due date
 * and a `today` that is handed in — never one this module works out for
 * itself, which is what keeps it testable at 09:00 and at 23:00.
 */

import { compareDates, daysBetween, formatDay, formatWeekdayDay, type DateStr } from '../date';
import { WEEK_HORIZON_DAYS } from '../constants';
import type { InvoiceRow } from '../types';

export type Urgency = 'overdue' | 'today' | 'week' | 'later';

/** Spec §6, and the spine colours in §9. */
export const URGENCY_COLOUR: Record<Urgency, string> = {
  overdue: 'var(--spine-overdue)',
  today: 'var(--spine-today)',
  week: 'var(--spine-week)',
  later: 'var(--spine-later)',
};

/** Tinted backgrounds, paired with the colour above as text. */
export const URGENCY_TINT: Record<Urgency, string> = {
  overdue: 'var(--spine-overdue-bg)',
  today: 'var(--spine-today-bg)',
  week: 'var(--spine-week-bg)',
  later: 'var(--spine-later-bg)',
};

export function urgencyOf(dueDate: DateStr, today: DateStr): Urgency {
  const cmp = compareDates(dueDate, today);
  if (cmp < 0) return 'overdue';
  if (cmp === 0) return 'today';
  return daysBetween(today, dueDate) <= WEEK_HORIZON_DAYS ? 'week' : 'later';
}

/** How many days late. Zero for anything not yet overdue. */
export function daysLate(dueDate: DateStr, today: DateStr): number {
  const diff = daysBetween(dueDate, today);
  return diff > 0 ? diff : 0;
}

/** '4 days late' / '1 day late'. Spec §8: no exclamation marks. */
export function formatDaysLate(dueDate: DateStr, today: DateStr): string | null {
  const late = daysLate(dueDate, today);
  if (late === 0) return null;
  return late === 1 ? '1 day late' : `${late} days late`;
}

/**
 * The one-line label on a due pill: '4 days late', 'Due today', 'Mon 31',
 * 'Fri 11 Sep'.
 *
 * One function rather than a ternary at each call site, because the four cases
 * have to stay in step: the pill's colour comes from `urgencyOf` and its words
 * come from here, and a row reading "Due today" in the overdue colour is the
 * kind of small contradiction that makes people stop believing the screen.
 *
 * Both are derived from the same `today`, handed in, never worked out here.
 */
export function formatDueLabel(dueDate: DateStr, today: DateStr): string {
  const urgency = urgencyOf(dueDate, today);

  switch (urgency) {
    case 'overdue':
      // Never null in this branch: overdue means at least one day late.
      return formatDaysLate(dueDate, today) ?? 'Overdue';
    case 'today':
      return 'Due today';
    case 'week':
      return formatWeekdayDay(dueDate);
    case 'later':
      return formatDay(dueDate);
  }
}

export interface UrgencyBuckets<T> {
  overdue: T[];
  today: T[];
  week: T[];
  later: T[];
}

/**
 * Split invoices into the four sections of the Home screen.
 *
 * Order within each bucket is by due date then supplier, so the spine reads
 * as a timeline top to bottom.
 */
export function bucketByUrgency(
  rows: ReadonlyArray<InvoiceRow>,
  today: DateStr,
): UrgencyBuckets<InvoiceRow> {
  const buckets: UrgencyBuckets<InvoiceRow> = { overdue: [], today: [], week: [], later: [] };

  for (const row of rows) {
    buckets[urgencyOf(row.due_date, today)].push(row);
  }

  for (const key of Object.keys(buckets) as Urgency[]) {
    buckets[key].sort(
      (a, b) =>
        compareDates(a.due_date, b.due_date) || a.supplier.name.localeCompare(b.supplier.name),
    );
  }

  return buckets;
}
