import { UnlockGate } from '@/components/auth/UnlockGate';

/**
 * Everything that requires a signed-in, unlocked person.
 *
 * Two layers, doing different jobs:
 *   middleware.ts  — no session at all, redirect to /login before this renders
 *   UnlockGate     — session but locked, show the PIN pad
 *
 * Neither is the security boundary. RLS is. If both of these were deleted the
 * data would still be safe; you would just see an empty app instead of a
 * login screen (notes §2).
 *
 * This layout does no data fetching, per architecture §1.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <UnlockGate>{children}</UnlockGate>;
}
