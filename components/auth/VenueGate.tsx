'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useCurrentProfile } from '@/lib/queries/session';
import { isStaff, STAFF_HOME } from '@/lib/staff';

/**
 * Keeps a venue account on the two screens that mean anything to it.
 *
 * ---------------------------------------------------------------------------
 * This is not a security boundary and must never be mistaken for one.
 *
 * Notes §2: "Enforcement lives in the database, never the interface. 'The
 * button isn't rendered' is not access control." If this file were deleted, a
 * venue account navigating to `/b/mjr` would see an empty week, `/customers`
 * would list nobody, and `/invoices/<id>` would find nothing — because
 * `is_member()` refuses all three, not because a router said so.
 *
 * What this does is stop them being shown four blank screens and left to
 * wonder whether the app is broken. That is a real job, and it is the only
 * job: a redirect, not a refusal.
 * ---------------------------------------------------------------------------
 *
 * Sits INSIDE `UnlockGate`, which already waits for the profile before
 * rendering anything. So by the time this runs the profile is in cache and
 * there is no window in which a venue sees the dashboard — the flash this
 * would otherwise have is the reason for the ordering, not an accident of it.
 */

/**
 * Where a venue account is allowed to be.
 *
 * Settings is on the list because it is how they sign out, change their
 * password and set a PIN. Three things a shared shop login genuinely needs,
 * and the alternative is a screen with no way off it.
 *
 * An allowlist, and deliberately not a blocklist of the screens they cannot
 * see. A blocklist would let every route added in a later phase through by
 * default — which is the same trap `push_targets` was carrying, and the same
 * fix (CATCH_UP_010 §6).
 */
const VENUE_PATHS = [STAFF_HOME as string, '/settings'];

function allowed(pathname: string): boolean {
  return VENUE_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

export function VenueGate({ children }: { children: React.ReactNode }) {
  const { data: profile } = useCurrentProfile();
  const pathname = usePathname() ?? '/';
  const router = useRouter();

  const staff = isStaff(profile);
  const misplaced = staff && !allowed(pathname);

  useEffect(() => {
    // `replace`, not `push`. A venue tapping back should leave the app rather
    // than bounce off a redirect it never chose to make.
    if (misplaced) router.replace(STAFF_HOME);
  }, [misplaced, router]);

  /*
   * Nothing rather than the wrong screen for one frame.
   *
   * The redirect is asynchronous, so returning `children` here would render
   * the dashboard — queries and all — until the router caught up. Every one of
   * those queries would come back empty under RLS, which is harmless, and the
   * screen would still have been on a shop's phone, which is the thing worth
   * avoiding.
   */
  if (misplaced) return null;

  return <>{children}</>;
}
