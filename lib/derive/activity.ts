import { formatDayWithYear, isDateStr, type DateStr } from '../date';
import { formatCents } from '../money';
import type { ActivityEntry, InvoiceNote, StreamItem } from '../types';

/**
 * Turning the audit log into English.
 *
 * The database records what changed as raw JSON — `{"amount_cents": {"from":
 * 542000, "to": 522000}}`. Spec §7.6 wants that on screen as:
 *
 *     SU  Sujan · changed amount
 *         $5,420.00 → $5,220.00              29 Aug, 4:02pm
 *
 * All of it is pure, so every shape the trigger can produce is testable
 * without a database — which matters, because this is the screen people will
 * read when they disagree about an invoice, and it has to be right.
 */

export interface FieldChange {
  /** 'amount', 'due date' — how a person would say it. */
  label: string;
  from: string | null;
  to: string | null;
}

export interface ActivityDescription {
  /** 'added this invoice', 'marked paid', 'changed amount'. */
  summary: string;
  changes: FieldChange[];
  /** Payment reference, when the action carried one. */
  reference?: string;
}

/** Column name -> what a person calls it. */
const FIELD_LABEL: Record<string, string> = {
  amount_cents: 'amount',
  due_date: 'due date',
  invoice_date: 'invoice date',
  invoice_number: 'invoice number',
  business_id: 'business',
  supplier_id: 'supplier',
  status: 'status',
  payment_ref: 'payment reference',
  void_reason: 'void reason',
};

/** Fields whose change is already said by the summary line. */
const IMPLIED_BY_ACTION = new Set(['status', 'payment_ref', 'void_reason']);

function formatValue(field: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;

  if (field === 'amount_cents') {
    const cents = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(cents) ? formatCents(cents) : null;
  }

  if (typeof value === 'string' && isDateStr(value)) {
    return formatDayWithYear(value as DateStr);
  }

  // Ids are useless to read. The stream says a field changed; which supplier
  // it changed to is answered by the invoice itself, right above the stream.
  if (field.endsWith('_id')) return null;

  const text = String(value).trim();
  return text === '' ? null : text;
}

function isFromTo(value: unknown): value is { from?: unknown; to?: unknown } {
  return typeof value === 'object' && value !== null && ('from' in value || 'to' in value);
}

/** The changed fields worth showing, in a stable order. */
function changesOf(detail: Record<string, unknown> | null): FieldChange[] {
  if (!detail) return [];

  const changes: FieldChange[] = [];
  for (const field of Object.keys(FIELD_LABEL)) {
    if (IMPLIED_BY_ACTION.has(field)) continue;
    const raw = detail[field];
    if (!isFromTo(raw)) continue;

    const from = formatValue(field, raw.from);
    const to = formatValue(field, raw.to);
    if (from === null && to === null) continue;

    changes.push({ label: FIELD_LABEL[field]!, from, to });
  }
  return changes;
}

/**
 * One activity entry, described.
 *
 * Spec §8: sentence case, no exclamation marks, and the summary names what
 * happened rather than which column moved.
 */
export function describeActivity(entry: ActivityEntry): ActivityDescription {
  const detail = entry.detail ?? null;
  const changes = changesOf(detail);

  switch (entry.action) {
    case 'created':
      return { summary: 'added this invoice', changes: [] };

    case 'paid': {
      const raw = detail?.payment_ref;
      const reference = isFromTo(raw) ? formatValue('payment_ref', raw.to) : null;
      return {
        summary: 'marked paid',
        changes: [],
        ...(reference ? { reference } : {}),
      };
    }

    case 'unpaid':
      // Spec §6: un-ticking is "allowed, but logged loudly".
      return { summary: 'put this back to unpaid', changes: [] };

    case 'voided': {
      const raw = detail?.void_reason;
      const reason = isFromTo(raw) ? formatValue('void_reason', raw.to) : null;
      return {
        summary: reason ? `voided this — ${reason}` : 'voided this',
        changes: [],
      };
    }

    case 'edited':
    default: {
      if (changes.length === 1) {
        return { summary: `changed the ${changes[0]!.label}`, changes };
      }
      if (changes.length > 1) {
        return { summary: `changed ${changes.length} details`, changes };
      }
      return { summary: 'edited this invoice', changes: [] };
    }
  }
}

/**
 * Notes and activity in one chronological stream. Spec §7.6.
 *
 * Oldest first, so it reads as a story from the top: added, queried, corrected,
 * paid. Ties break with activity before notes, because a note is usually a
 * comment on the event it accompanies.
 */
export function mergeStream(
  activity: readonly ActivityEntry[],
  notes: readonly InvoiceNote[],
): StreamItem[] {
  const items: StreamItem[] = [
    ...activity.map(
      (entry): StreamItem => ({
        kind: 'activity',
        at: entry.created_at,
        actorId: entry.actor_id,
        entry,
      }),
    ),
    ...notes.map(
      (note): StreamItem => ({
        kind: 'note',
        at: note.created_at,
        actorId: note.author_id,
        note,
      }),
    ),
  ];

  return items.sort(
    (a, b) =>
      a.at.localeCompare(b.at) ||
      (a.kind === b.kind ? 0 : a.kind === 'activity' ? -1 : 1),
  );
}

/**
 * How many entries are newer than the last time this person looked.
 *
 * Used by the header bell. `since` is an ISO timestamp kept per device; a
 * missing one means everything is new, which is the right answer on a phone
 * that has never opened the app.
 */
export function countUnseen(
  activity: readonly ActivityEntry[],
  since: string | null,
  viewerId: string,
): number {
  return activity.filter(
    // Your own actions are never news to you.
    (entry) => entry.actor_id !== viewerId && (since === null || entry.created_at > since),
  ).length;
}
