/**
 * The only place these values exist.
 *
 * Notes §5: a default was written as `5` in a placeholder and `1` in the
 * calculation, and thirty people got thirty portions instead of six. If a
 * value appears in both a validation schema and a UI hint, both import the
 * same symbol from here. Never two literals that happen to match today.
 */

/** The "next 7 days" bucket on Home, and the copy that describes it. */
export const WEEK_HORIZON_DAYS = 7;

/**
 * The due-date preset pills in the add-invoice sheet, and their date maths.
 * Counted from the INVOICE date, not from today — see defaultDueDate.
 */
export const DUE_PRESETS_DAYS = [7, 14, 30] as const;

/** Used when a supplier has no `default_terms_days` of its own. */
export const DEFAULT_TERMS_DAYS = 14;

/**
 * How far back the duplicate warning looks for a matching supplier +
 * invoice number. Suppliers restart their numbering, so an unbounded search
 * produces false warnings on old numbers that have come around again.
 */
export const DUPE_LOOKBACK_DAYS = 180;

/** Auth session lifetime. Must match the Supabase Auth project setting. */
export const SESSION_DAYS = 30;

export const PIN_LENGTH = 6;
export const PIN_MAX_ATTEMPTS = 5;

/** Spec §9 quality floor. Mirrored as --spacing-touch in globals.css. */
export const MIN_TOUCH_PX = 44;

/** Dense list row. Mirrored as --spacing-row in globals.css. */
export const ROW_HEIGHT_PX = 56;

/**
 * Cache freshness for the unpaid list. Notes §1.4: never 0 on a list that
 * receives optimistic updates, or a refetch can land on top of one.
 */
export const UNPAID_STALE_MS = 30_000;

/** History page size. */
export const HISTORY_PAGE_SIZE = 50;

/** The four businesses, in display order. Codes match `businesses.code`. */
export const BUSINESS_CODES = ['GMH', 'GMP', 'MJR', 'DDL'] as const;
export type BusinessCode = (typeof BUSINESS_CODES)[number];
