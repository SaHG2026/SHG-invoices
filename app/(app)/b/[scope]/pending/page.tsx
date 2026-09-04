import { PendingList } from '@/components/screens/PendingList';
import { parseScope } from '@/lib/scope';
import { parseDueWindow } from '@/lib/derive/select';

/**
 * Thin adapter — see the note on the week view route.
 *
 * The due window is unwrapped here, alongside the scope, rather than read
 * inside the screen with `useSearchParams`. Two reasons, and only the second
 * is about this app in particular:
 *
 *  - `useSearchParams` in a client component forces a Suspense boundary at
 *    build time, and the boundary would sit around the whole list.
 *  - HANDOFF §5: a screen that takes plain values is a screen a test can
 *    render by passing it a literal. That is the same split every dynamic
 *    route here already uses, and the reason all of them are testable.
 */
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ scope: string }>;
  searchParams: Promise<{ due?: string }>;
}) {
  const { scope } = await params;
  const { due } = await searchParams;
  return <PendingList scope={parseScope(scope)} due={parseDueWindow(due)} />;
}
