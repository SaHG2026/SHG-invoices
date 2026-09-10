import type { Route } from 'next';
import type { Profile } from './types';

/**
 * What a venue account is, in one place.
 *
 * ---------------------------------------------------------------------------
 * Why this is a module and not `profile.role === 'staff'` written eleven times
 *
 * Because the app is not the enforcement layer and must never look like it is.
 * Every real boundary lives in the database — `is_manager_or_above()`,
 * `is_owner()`, `staff_venue()`, the `staff_invoices` view, and the insert
 * policy's `with check`. If every
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
 * May log a bill, and may not act on one. CATCH_UP_022, §52.
 *
 * The database is the boundary: `is_assistant()` guards a SELECT and an
 * INSERT, and there is no UPDATE policy for this tier anywhere. If every use
 * of this function were deleted, an assistant would still be unable to edit,
 * void, approve or settle anything; they would simply be shown buttons that
 * come back 42501 (notes §2).
 *
 * So what this decides is what they are OFFERED, which is the same job
 * `isStaff` does one tier down.
 */
export function isAssistant(profile: Profile | null | undefined): boolean {
  return profile?.role === 'assistant';
}

/**
 * One of the people who run the businesses, with full use of the ledger.
 *
 * `assistant` is deliberately NOT here, and this is the app-side twin of the
 * rule CATCH_UP_022 spends its header on: `is_manager_or_above()` was not
 * widened either. Every screen that asks this question means "may change
 * things", and an assistant may not.
 *
 * The opposite of `isStaff` for three of the four values, and no longer the
 * exact opposite of it — which is why it is still not written as a negation
 * at its call sites.
 */
export function isFullMember(profile: Profile | null | undefined): boolean {
  if (!profile) return false;
  return (
    profile.role === 'manager' || profile.role === 'owner' || profile.role === 'builder'
  );
}

/**
 * Whose role this app may change, which is a different question from every
 * other allowlist in this file.
 *
 * ---------------------------------------------------------------------------
 * Why this is not `runsTheBusinesses`.
 *
 * The role screen used that one, and it means "people who run the
 * businesses" — the audience for a person picker and a notification. Adding
 * `assistant` to it would put a demoted person into the paid-by filter on
 * History, where they can never appear because they cannot pay anything, and
 * into the builder's photo screen.
 *
 * But leaving them OUT of the role screen is worse than either: demote
 * somebody and they drop off the only list that could promote them back, so
 * the demotion is one-way from inside the app and the way back is Supabase.
 *
 * One predicate answering two questions is what this project keeps unpicking,
 * so it is two predicates. `set_user_role` refuses a builder and a shop
 * login, and this list holds exactly the rows it will accept — the screen and
 * the function agree by construction rather than by both remembering the same
 * two exceptions.
 * ---------------------------------------------------------------------------
 */
export function roleMayBeChanged(profile: Pick<Profile, 'role'>): boolean {
  return (
    profile.role === 'manager' || profile.role === 'owner' || profile.role === 'assistant'
  );
}

/** What the role screen calls each tier. The one place these words live. */
export const TIER_LABEL: Record<'owner' | 'manager' | 'assistant', string> = {
  owner: 'Owner',
  manager: 'Manager',
  assistant: 'Assistant',
};

/**
 * May move a bill between paid and unpaid, and may change anybody's role.
 *
 * The second permission this app has, after `staff` — and like that one, it is
 * a permission because the DATABASE says so. `is_owner()` sits inside
 * `mark_invoices_paid`, `unmark_invoice_paid`, `mark_sales_received`,
 * `unmark_sales_received` and `set_user_role`, and refuses with 42501. If this
 * function were deleted, a manager would be shown four buttons that raise an
 * error — which is notes §6 failing, not the boundary failing.
 *
 * `builder` is included, and that is §44.2: owner powers, invisible in lists.
 * The invisibility is `runsTheBusinesses` below, and the two are deliberately
 * separate — a permission that hides itself from the permission check is a
 * permission nobody can reason about.
 *
 * Null is false, like `isStaff`: while the profile loads the honest answer is
 * "we do not know yet", and the owner's controls appearing for a frame and
 * then vanishing is the one direction that must not flicker.
 */
export function isOwner(profile: Profile | null | undefined): boolean {
  if (!profile) return false;
  return profile.role === 'owner' || profile.role === 'builder';
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
 *
 * It failed closed once already, on purpose. CATCH_UP_019 renamed `member` to
 * `manager`, and an allowlist has the opposite failure to a blocklist: a tier
 * added without visiting each one is a tier quietly excluded. There are six
 * allowlists between the app and the database, four of them in SQL, and §1 of
 * that file names all six. This is one, `isFullMember` is another, and both
 * were changed by hand rather than by search-and-replace so that they were
 * decided rather than swept up.
 */
export function runsTheBusinesses(profile: Pick<Profile, 'role'>): boolean {
  return profile.role === 'manager' || profile.role === 'owner';
}
