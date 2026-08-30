/**
 * Where a business's logo lives, once there is one.
 *
 * The four businesses will get their own marks. Until the files arrive the
 * menu shows a lettered tile in the same slot, so the layout is already the
 * shape it will be and dropping a logo in changes one row rather than the
 * design.
 *
 * ---------------------------------------------------------------------------
 * Why a hand-edited table rather than probing for the file.
 *
 * The tempting version is an <img> pointed at `/logos/gmh.png` that falls back
 * to the tile when it 404s. That works, and it costs a failed request per
 * business every time the menu opens, plus a visible flash of the broken state
 * on a slow connection. This is the same reasoning as the month-name table in
 * lib/date.ts: an explicit list is duller than runtime cleverness and it is
 * right on every device.
 *
 * To add one: put the file in `public/logos/`, add its line below. That is the
 * whole procedure. Square artwork, at least 96px, transparent or white ground —
 * it renders as a 28px rounded tile beside the business name.
 * ---------------------------------------------------------------------------
 */

/** Keyed by `businesses.code`, upper-case. Empty until the artwork arrives. */
export const BUSINESS_LOGOS: Readonly<Record<string, string>> = {
  // GMH: '/logos/grocerymate-hurstville.png',
  // GMP: '/logos/grocerymate-parramatta.png',
  // MJR: '/logos/majheri.png',
  // DDL: '/logos/deli-delights.png',
};

export function businessLogo(code: string): string | null {
  return BUSINESS_LOGOS[code.toUpperCase()] ?? null;
}
