import type { Route } from 'next';
import type { Profile } from './types';

/**
 * What a venue account is, in one place.
 *
 * ---------------------------------------------------------------------------
 * Why this is a module and not `profile.role === 'staff'` written eleven times
 *
 * Because the app is not the enforcement layer and must never look like it is.
 * Every real boundary lives in CATCH_UP_010 — `is_member()`, `staff_venue()`,
 * the `staff_invoices` view, and the insert policy's `with check`. If every
 * function in this file were deleted, a venue account would still be unable to
 * see another venue or a payment status; it would just be shown a menu full of
 * screens that come back empty (notes §2).
 *
 * So what this file decides is what somebody is OFFERED, and that is a real
 * job worth doing once: notes §6 says the interface should not offer what it
 * cannot do, and a drawer listing Customers, Suppliers and Paid history to
 * somebody who will get four blank screens is exactly that failure.
 * ---------------------------------------------------------------------------
 */

/**
 * Where a venue account lives. Their whole app is this one screen.
 *
 * Kept here rather than in `lib/nav.ts` because nav is the menu the four see,
 * and staff have no menu — one screen needs no navigation.
 */
export const STAFF_HOME = '/venue' as Route;

/**
 * A venue, not a person.
 *
 * Takes the nullable profile every caller actually holds, because
 * `useCurrentProfile` returns null while it loads and on a dead session. The
 * answer for "we do not know yet" has to be false: treating an unknown profile
 * as staff would flash the venue screen at Mani for one frame, and treating it
 * as a member shows a loading state, which is what it is.
 */
export function isStaff(profile: Profile | null | undefined): boolean {
  return profile?.role === 'staff';
}

/**
 * One of the four. The opposite of `isStaff`, except while loading, when both
 * are false — which is the honest answer and the reason this is not written as
 * a negation at its call sites.
 */
export function isFullMember(profile: Profile | null | undefined): boolean {
  if (!profile) return false;
  return profile.role === 'member' || profile.role === 'owner' || profile.role === 'builder';
}

/**
 * An allowlist, deliberately, and the same shape as the one CATCH_UP_010 §6
 * put into `push_targets`.
 *
 * `useTeam()` used to filter `role !== 'builder'`, written when builder was
 * the only role that had to be kept out. A blocklist admits every role
 * invented after it — so on the day the venues existed, the profile picker
 * and every type-ahead would have listed GroceryMate Parramatta as one of the
 * people who run the businesses.
 *
 * Nobody would have written that bug; it would simply have happened. Which is
 * the argument for allowlists generally, and the reason this one is a named
 * function rather than an inline predicate: it is easy to find, and it fails
 * closed for whatever the fifth role turns out to be.
 */
export function runsTheBusinesses(profile: Pick<Profile, 'role'>): boolean {
  return profile.role === 'member' || profile.role === 'owner';
}
