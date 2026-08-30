import { describe, expect, it } from 'vitest';
import { countUnseen, describeActivity, mergeStream } from '@/lib/derive/activity';
import type { ActivityEntry, InvoiceNote } from '@/lib/types';

/**
 * The stream people read when they disagree about an invoice.
 *
 * Spec §7.6 gives the exact shape it has to produce:
 *
 *     MI  Milan · added this invoice          28 Aug, 9:14am
 *     SU  Sujan · changed amount
 *         $5,420.00 → $5,220.00               29 Aug, 4:02pm
 *     MA  Mani  · marked paid  ref: TFR-88213 11 Sep, 8:30am
 *
 * The input is raw JSON written by a database trigger, so every shape the
 * trigger can produce is worth pinning down here rather than discovering on a
 * phone during an argument with a supplier.
 */

function entry(overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id: 1,
    entity_type: 'invoice',
    entity_id: 'i-1',
    action: 'edited',
    actor_id: 'p-sujan',
    detail: {},
    created_at: '2026-08-29T06:02:00.000Z',
    ...overrides,
  };
}

describe('describeActivity', () => {
  it('describes a creation without listing every field', () => {
    const described = describeActivity(
      entry({
        action: 'created',
        detail: { internal_ref: 'GMH-260828-03', amount_cents: 522_000, due_date: '2026-09-11' },
      }),
    );
    expect(described.summary).toBe('added this invoice');
    // The invoice itself is on screen above the stream; repeating it is noise.
    expect(described.changes).toHaveLength(0);
  });

  it('formats a changed amount as money, both sides', () => {
    const described = describeActivity(
      entry({ detail: { amount_cents: { from: 542_000, to: 522_000 } } }),
    );
    expect(described.summary).toBe('changed the amount');
    expect(described.changes).toEqual([
      { label: 'amount', from: '$5,420.00', to: '$5,220.00' },
    ]);
  });

  it('formats a changed date with its weekday — spec §8', () => {
    const described = describeActivity(
      entry({ detail: { due_date: { from: '2026-09-11', to: '2026-09-18' } } }),
    );
    expect(described.summary).toBe('changed the due date');
    expect(described.changes[0]).toEqual({
      label: 'due date',
      from: 'Fri 11 Sep 2026',
      to: 'Fri 18 Sep 2026',
    });
  });

  it('counts several changes rather than reciting them in the summary', () => {
    const described = describeActivity(
      entry({
        detail: {
          amount_cents: { from: 100, to: 200 },
          due_date: { from: '2026-09-11', to: '2026-09-18' },
        },
      }),
    );
    expect(described.summary).toBe('changed 2 details');
    expect(described.changes).toHaveLength(2);
  });

  it('says marked paid, and carries the reference', () => {
    const described = describeActivity(
      entry({
        action: 'paid',
        detail: {
          status: { from: 'unpaid', to: 'paid' },
          payment_ref: { from: null, to: 'TFR-88213' },
        },
      }),
    );
    expect(described.summary).toBe('marked paid');
    expect(described.reference).toBe('TFR-88213');
    // "status: unpaid -> paid" would be saying the same thing twice.
    expect(described.changes).toHaveLength(0);
  });

  it('handles marked paid with no reference', () => {
    const described = describeActivity(
      entry({ action: 'paid', detail: { status: { from: 'unpaid', to: 'paid' } } }),
    );
    expect(described.summary).toBe('marked paid');
    expect(described.reference).toBeUndefined();
  });

  it('records un-ticking loudly — spec §6', () => {
    const described = describeActivity(
      entry({ action: 'unpaid', detail: { status: { from: 'paid', to: 'unpaid' } } }),
    );
    expect(described.summary).toBe('put this back to unpaid');
  });

  it('gives the void reason in the line itself', () => {
    const described = describeActivity(
      entry({
        action: 'voided',
        detail: {
          status: { from: 'unpaid', to: 'void' },
          void_reason: { from: null, to: 'Duplicate of GMH-260828-02' },
        },
      }),
    );
    expect(described.summary).toBe('voided this — Duplicate of GMH-260828-02');
  });

  it('does not print raw ids at somebody', () => {
    const described = describeActivity(
      entry({
        detail: { supplier_id: { from: 'a207c7b2-5389-445a', to: 'f57715ab-a468-4d2a' } },
      }),
    );
    // A uuid tells a person nothing. The invoice above the stream says who.
    expect(JSON.stringify(described)).not.toContain('a207c7b2');
  });

  it('survives detail the trigger never wrote', () => {
    for (const detail of [null, {}, { nonsense: 1 }, { amount_cents: 'not an object' }]) {
      const described = describeActivity(entry({ detail: detail as never }));
      expect(described.summary).toBeTruthy();
      expect(JSON.stringify(described)).not.toMatch(/undefined|NaN|\[object Object\]/);
    }
  });

  it('never produces the forbidden strings for any action', () => {
    for (const action of ['created', 'edited', 'paid', 'unpaid', 'voided'] as const) {
      const described = describeActivity(entry({ action, detail: null }));
      expect(JSON.stringify(described)).not.toMatch(/undefined|NaN|\[object Object\]/);
      expect(described.summary).not.toMatch(/!/);
    }
  });
});

describe('mergeStream', () => {
  const activity: ActivityEntry[] = [
    entry({ id: 1, action: 'created', created_at: '2026-08-28T23:14:00.000Z' }),
    entry({ id: 2, action: 'paid', created_at: '2026-09-11T22:30:00.000Z' }),
  ];
  const notes: InvoiceNote[] = [
    {
      id: 'n-1',
      invoice_id: 'i-1',
      author_id: 'p-milan',
      body: 'Short delivery — 2 cartons missing, credit note expected',
      created_at: '2026-08-28T23:15:00.000Z',
    },
  ];

  it('reads as one story, oldest first', () => {
    const stream = mergeStream(activity, notes);
    expect(stream.map((item) => item.kind)).toEqual(['activity', 'note', 'activity']);
    for (let i = 1; i < stream.length; i++) {
      expect(stream[i]!.at >= stream[i - 1]!.at).toBe(true);
    }
  });

  it('loses nothing', () => {
    expect(mergeStream(activity, notes)).toHaveLength(activity.length + notes.length);
  });

  it('puts the event before a note written in the same second', () => {
    // A note is usually a comment on the thing that just happened.
    const stream = mergeStream(
      [entry({ created_at: '2026-08-28T23:15:00.000Z' })],
      [{ ...notes[0]!, created_at: '2026-08-28T23:15:00.000Z' }],
    );
    expect(stream[0]!.kind).toBe('activity');
  });

  it('copes with either side being empty', () => {
    expect(mergeStream([], [])).toHaveLength(0);
    expect(mergeStream(activity, [])).toHaveLength(2);
    expect(mergeStream([], notes)).toHaveLength(1);
  });
});

describe('countUnseen', () => {
  const activity: ActivityEntry[] = [
    entry({ id: 1, actor_id: 'p-sujan', created_at: '2026-08-28T01:00:00.000Z' }),
    entry({ id: 2, actor_id: 'p-milan', created_at: '2026-08-29T01:00:00.000Z' }),
    entry({ id: 3, actor_id: 'p-mani', created_at: '2026-08-30T01:00:00.000Z' }),
  ];

  it('counts what happened since you last looked', () => {
    expect(countUnseen(activity, '2026-08-28T12:00:00.000Z', 'p-rabindra')).toBe(2);
    expect(countUnseen(activity, '2026-08-30T02:00:00.000Z', 'p-rabindra')).toBe(0);
  });

  it('never counts your own actions', () => {
    // Being told about what you just did is noise, and it trains people to
    // ignore the bell.
    expect(countUnseen(activity, '2026-08-28T12:00:00.000Z', 'p-mani')).toBe(1);
    expect(countUnseen(activity, null, 'p-mani')).toBe(2);
  });

  it('treats never having looked as everything being new', () => {
    expect(countUnseen(activity, null, 'p-rabindra')).toBe(3);
  });
});
