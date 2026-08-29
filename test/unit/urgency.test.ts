import { describe, expect, it } from 'vitest';
import { bucketByUrgency, formatDaysLate, urgencyOf } from '@/lib/derive/urgency';
import { sydneyToday } from '@/lib/date';
import { FIXTURE_TODAY, makeInvoice, makeInvoices } from '../fixtures/invoices';

describe('urgencyOf', () => {
  const today = FIXTURE_TODAY; // 2026-08-28

  it('matches the buckets in spec §6', () => {
    expect(urgencyOf('2026-08-24', today)).toBe('overdue');
    expect(urgencyOf('2026-08-27', today)).toBe('overdue');
    expect(urgencyOf('2026-08-28', today)).toBe('today');
    expect(urgencyOf('2026-08-29', today)).toBe('week');
    expect(urgencyOf('2026-09-04', today)).toBe('week'); // exactly 7 days out
    expect(urgencyOf('2026-09-05', today)).toBe('later'); // 8 days out
  });

  it('puts the horizon boundary in one place', () => {
    // The 7 comes from WEEK_HORIZON_DAYS, not a literal here — notes §5.
    expect(urgencyOf('2026-09-04', today)).not.toBe('later');
  });
});

describe('the 09:00 / 23:00 test — notes §6', () => {
  /**
   * Same due date, same Sydney day, two very different instants. One of them
   * (09:00 Sydney) is still yesterday in UTC. If any part of the urgency path
   * touched UTC, these two would disagree, and Home would tell Mani an
   * invoice was overdue when it was not.
   */
  const at0900 = new Date('2026-08-28T23:00:00.000Z'); // 9am Sat 29 Aug Sydney
  const at2300 = new Date('2026-08-29T13:00:00.000Z'); // 11pm Sat 29 Aug Sydney

  it('resolves to the same Sydney day at both times', () => {
    expect(sydneyToday(at0900)).toBe('2026-08-29');
    expect(sydneyToday(at2300)).toBe('2026-08-29');
  });

  it('buckets every fixture invoice identically at both times', () => {
    const rows = makeInvoices(200);
    const morning = bucketByUrgency(rows, sydneyToday(at0900));
    const night = bucketByUrgency(rows, sydneyToday(at2300));

    expect(morning.overdue.map((r) => r.id)).toEqual(night.overdue.map((r) => r.id));
    expect(morning.today.map((r) => r.id)).toEqual(night.today.map((r) => r.id));
    expect(morning.week.map((r) => r.id)).toEqual(night.week.map((r) => r.id));
    expect(morning.later.map((r) => r.id)).toEqual(night.later.map((r) => r.id));
  });

  it('does not flip an invoice due today into overdue during the morning', () => {
    const dueToday = makeInvoice({ due_date: '2026-08-29' });
    expect(urgencyOf(dueToday.due_date, sydneyToday(at0900))).toBe('today');
    expect(urgencyOf(dueToday.due_date, sydneyToday(at2300))).toBe('today');
  });
});

describe('formatDaysLate', () => {
  it('reads as plain English, singular and plural — spec §8', () => {
    expect(formatDaysLate('2026-08-24', '2026-08-28')).toBe('4 days late');
    expect(formatDaysLate('2026-08-27', '2026-08-28')).toBe('1 day late');
  });

  it('says nothing at all when the invoice is not late', () => {
    expect(formatDaysLate('2026-08-28', '2026-08-28')).toBeNull();
    expect(formatDaysLate('2026-09-11', '2026-08-28')).toBeNull();
  });
});

describe('bucketByUrgency', () => {
  const rows = makeInvoices(200);
  const buckets = bucketByUrgency(rows, FIXTURE_TODAY);

  it('accounts for every invoice exactly once', () => {
    const total =
      buckets.overdue.length + buckets.today.length + buckets.week.length + buckets.later.length;
    expect(total).toBe(rows.length);

    const ids = new Set([
      ...buckets.overdue.map((r) => r.id),
      ...buckets.today.map((r) => r.id),
      ...buckets.week.map((r) => r.id),
      ...buckets.later.map((r) => r.id),
    ]);
    expect(ids.size).toBe(rows.length);
  });

  it('orders each bucket by due date, so the spine reads as a timeline', () => {
    for (const bucket of [buckets.overdue, buckets.week, buckets.later]) {
      for (let i = 1; i < bucket.length; i++) {
        expect(bucket[i]!.due_date >= bucket[i - 1]!.due_date).toBe(true);
      }
    }
  });

  it('does not mutate the array it was given', () => {
    const original = makeInvoices(20);
    const snapshot = original.map((r) => r.id);
    bucketByUrgency(original, FIXTURE_TODAY);
    expect(original.map((r) => r.id)).toEqual(snapshot);
  });
});
