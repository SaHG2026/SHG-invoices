/**
 * Every date decision in this app comes from this file.
 *
 * Notes §1.2: in the previous app, invoices logged before ~10am filed into the
 * previous week because a date key was built with `toISOString()`. Silent, and
 * only visible as a total that didn't add up. Postgres and Vercel both run UTC;
 * the phones run Sydney. That gap is the bug.
 *
 * Two rules make it structurally impossible here:
 *
 *   1. `new Date()` appears in this file and nowhere else in application code.
 *   2. A calendar date is a `DateStr` — the ten characters 'YYYY-MM-DD'. It is
 *      never converted into a `Date` in application code, so it can never
 *      acquire a timezone and can never shift by one day.
 *
 * All arithmetic below anchors to UTC internally. UTC has no daylight saving,
 * so "add 7 days" is exactly 7 x 86_400_000 ms with no discontinuity, and the
 * result does not depend on where the machine running it happens to be.
 */

export const TZ = 'Australia/Sydney';

/** A calendar date with no time and no timezone: 'YYYY-MM-DD'. */
export type DateStr = string;

/** An instant, as returned by Postgres `timestamptz`. */
export type Timestamp = string;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

/**
 * Month and weekday names are spelled out here rather than left to
 * `Intl.DateTimeFormat`.
 *
 * Not pedantry: Node's ICU renders 'en-AU' September as 'Sept' and puts a
 * comma after the weekday — 'Fri, 11 Sept' — while other runtimes give
 * 'Fri 11 Sep'. That output is not stable across Node versions or browsers,
 * so a phone and a laptop can disagree about the same invoice. Spec §8 fixes
 * the format; this table is what makes it actually fixed.
 *
 * Intl is still used below, but only ever to ask for *numbers* in a given
 * timezone. Numbers are locale-stable; names are not.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function isDateStr(value: unknown): value is DateStr {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  // Reject 2026-02-31 and friends: round-trip it and see if it survives.
  return fromEpoch(toEpoch(value)) === value;
}

function assertDateStr(value: string, label: string): void {
  if (!DATE_RE.test(value)) {
    throw new Error(`${label} must be 'YYYY-MM-DD', received: ${JSON.stringify(value)}`);
  }
}

/** 'YYYY-MM-DD' -> ms since epoch at UTC midnight. Internal anchor only. */
function toEpoch(d: DateStr): number {
  assertDateStr(d, 'date');
  const year = Number(d.slice(0, 4));
  const month = Number(d.slice(5, 7));
  const day = Number(d.slice(8, 10));
  return Date.UTC(year, month - 1, day);
}

/** ms since epoch -> 'YYYY-MM-DD', read back in UTC. Internal anchor only. */
function fromEpoch(ms: number): DateStr {
  const d = new Date(ms);
  const year = String(d.getUTCFullYear()).padStart(4, '0');
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Wall-clock numbers for an instant, in a given timezone. Locale-stable. */
function zonedParts(
  instant: Date,
  timeZone: string,
): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(instant);

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);

  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    // Some ICU builds render midnight as hour 24 under hour12:false.
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  };
}

/**
 * Today, in Sydney, as 'YYYY-MM-DD'.
 *
 * The only function in the codebase permitted to ask what day it is. Pass the
 * result explicitly into anything that compares against it — never let a
 * component or a query work it out for itself, and never let Postgres do it.
 */
export function sydneyToday(now: Date = new Date()): DateStr {
  const { year, month, day } = zonedParts(now, TZ);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * The hour of the day in Sydney, 0–23.
 *
 * Used for the dashboard greeting. Deliberately not the phone's own clock: a
 * phone can be set to any timezone, and a person in the Hurstville shop at 9am
 * should be told good morning whatever their handset thinks.
 */
export function sydneyHour(now: Date = new Date()): number {
  return zonedParts(now, TZ).hour;
}

/** Milliseconds from `now` until the next Sydney midnight. */
export function msUntilSydneyMidnight(now: Date = new Date()): number {
  const { hour, minute, second } = zonedParts(now, TZ);
  const elapsed = hour * 3_600_000 + minute * 60_000 + second * 1_000;
  return MS_PER_DAY - elapsed;
}

/** Add (or subtract) whole days. DST-proof: the arithmetic happens in UTC. */
export function addDays(d: DateStr, days: number): DateStr {
  return fromEpoch(toEpoch(d) + days * MS_PER_DAY);
}

/**
 * Whole days from `from` to `to`. Negative when `to` is earlier.
 * `daysBetween(today, dueDate)` is negative for an overdue invoice.
 */
export function daysBetween(from: DateStr, to: DateStr): number {
  return (toEpoch(to) - toEpoch(from)) / MS_PER_DAY;
}

/**
 * Compare two dates. Both are 'YYYY-MM-DD', so a plain string comparison is
 * already chronological — this exists to make that intent readable, and to
 * validate its inputs.
 */
export function compareDates(a: DateStr, b: DateStr): number {
  assertDateStr(a, 'date');
  assertDateStr(b, 'date');
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 'Fri 11 Sep'.
 *
 * Spec §8: dates always carry the weekday, because the weekday is what
 * matters when you are planning transfers. Formatted in UTC against a
 * UTC-anchored date, so the weekday is the one belonging to that calendar
 * date and not to the reader's location.
 */
export function formatDay(d: DateStr): string {
  const at = new Date(toEpoch(d));
  return `${WEEKDAYS[at.getUTCDay()]} ${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}`;
}

/** 'Fri 11 Sep 2026' — used where the year is not obvious from context. */
export function formatDayWithYear(d: DateStr): string {
  return `${formatDay(d)} ${d.slice(0, 4)}`;
}

/**
 * 'Mon 31' — weekday and day, no month.
 *
 * Only ever used for a date inside the coming week, where the month is not in
 * doubt and the weekday is the thing being read: "Monday" is what you plan a
 * transfer around, "31 August" is not. Anything further out uses `formatDay`,
 * which carries the month, because a bare 'Mon 31' two months ahead is a
 * genuinely ambiguous date rather than a terse one.
 */
export function formatWeekdayDay(d: DateStr): string {
  const at = new Date(toEpoch(d));
  return `${WEEKDAYS[at.getUTCDay()]} ${at.getUTCDate()}`;
}

/** '11 Sep' — for tight columns where the weekday is already on the spine. */
export function formatDayShort(d: DateStr): string {
  const at = new Date(toEpoch(d));
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}`;
}

/**
 * '11 Sep, 8:30am' — a `timestamptz` rendered in Sydney.
 *
 * Used for the activity stream, where the time of day is meaningful. Never
 * compare the underlying instant to a DateStr; convert with `sydneyDateOf`.
 */
export function formatDateTime(ts: Timestamp): string {
  const { month, day, hour, minute } = zonedParts(new Date(ts), TZ);
  const meridiem = hour < 12 ? 'am' : 'pm';
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${day} ${MONTHS[month - 1]}, ${hour12}:${String(minute).padStart(2, '0')}${meridiem}`;
}

/** Which Sydney calendar date a `timestamptz` fell on. */
export function sydneyDateOf(ts: Timestamp): DateStr {
  return sydneyToday(new Date(ts));
}
