import { UnlockGate } from '@/components/auth/UnlockGate';
import { VenueGate } from '@/components/auth/VenueGate';

/**
 * Everything that requires a signed-in, unlocked person.
 *
 * Three layers, doing different jobs:
 *   middleware.ts  — no session at all, redirect to /login before this renders
 *   UnlockGate     — session but locked, show the PIN pad
 *   VenueGate      — a venue account somewhere only the four belong
 *
 * None of them is the security boundary. RLS is. If all three were deleted the
 * data would still be safe; you would just see an empty app instead of a
 * login screen (notes §2).
 *
 * The order is load-bearing. `VenueGate` reads the profile to know whether it
 * is looking at a venue, and `UnlockGate` has already waited for that profile
 * before rendering anything — so nested this way there is no frame in which a
 * shop's phone shows the dashboard. The other way round, there would be.
 *
 * This layout does no data fetching, per architecture §1.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <UnlockGate>
      <VenueGate>{children}</VenueGate>
    </UnlockGate>
  );
}
