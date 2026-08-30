/**
 * Business marks and people's photographs.
 *
 * Both are hand-edited tables rather than anything clever, and for the same
 * reason as the month-name table in lib/date.ts: an explicit list is duller
 * than runtime cleverness and it is right on every device.
 *
 * The tempting alternative for either is an <img> pointed at a conventional
 * path that falls back when it 404s. That works, and it costs a failed request
 * per person per screen, plus a visible flash of the broken state on a slow
 * connection. A phone on shop wifi is exactly where that shows.
 */

/* -------------------------------------------------------------------------- *
 * Businesses
 * -------------------------------------------------------------------------- */

export interface BusinessMarkSpec {
  /** File under public/. Absent means fall back to the letters below. */
  src?: string;
  /**
   * What to show when there is no artwork.
   *
   * Defaults to `businesses.code`, which is the three letters already stamped
   * into every internal ref. Overridden where the client asked for something
   * friendlier — Deli Delights reads better as DD than DDL.
   */
  label?: string;
}

/**
 * Keyed by `businesses.code`, upper-case.
 *
 * Both GroceryMates carry the same mark: they are one brand in two locations,
 * and the shop name beside it is what tells them apart. Deli Delights has no
 * artwork of its own yet, so it gets letters rather than borrowing somebody
 * else's mark — three identical green circles out of four would make the menu
 * less readable, not more.
 *
 * To add one: put a square-ish file in `public/logos/`, add its line here.
 */
export const BUSINESS_MARKS: Readonly<Record<string, BusinessMarkSpec>> = {
  GMH: { src: '/logos/grocery-mate.png' },
  GMP: { src: '/logos/grocery-mate.png' },
  MJR: { src: '/logos/majheri.png' },
  DDL: { label: 'DD' },
};

export function businessMark(code: string): BusinessMarkSpec {
  return BUSINESS_MARKS[code.toUpperCase()] ?? {};
}

/* -------------------------------------------------------------------------- *
 * People
 * -------------------------------------------------------------------------- */

/**
 * Keyed by `profiles.display_name`, lower-cased.
 *
 * Deliberately not a `profiles.avatar_url` column. Four photographs that
 * change roughly never do not need a migration, a round trip through the
 * Supabase editor, and a nullable column on the table every attribution chip
 * reads. `display_name` rather than `id` because a UUID in a hand-edited table
 * is unreadable, and because this file is meant to be edited by hand.
 *
 * A name that is missing here falls back to initials, which is what every chip
 * showed before — so a renamed profile degrades to the old behaviour rather
 * than breaking.
 *
 * To add one: put a square file in `public/people/`, add its line here.
 */
export const PERSON_PHOTOS: Readonly<Record<string, string>> = {
  milan: '/people/milan.jpg',
  sujan: '/people/sujan.jpg',
  // mani: '/people/mani.jpg',       <- drop the file in and uncomment
  // rabindra: '/people/rabindra.jpg',
};

export function personPhoto(displayName: string): string | null {
  return PERSON_PHOTOS[displayName.trim().toLowerCase()] ?? null;
}
