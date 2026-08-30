import { WeekView } from '@/components/screens/WeekView';
import { parseScope } from '@/lib/scope';

/**
 * Thin adapter: unwrap the route params, hand a plain scope to the screen.
 *
 * The screen itself takes a string rather than a promise, which keeps the
 * component testable without a Suspense boundary and keeps route mechanics out
 * of the part that has the logic in it.
 */
export default async function Page({ params }: { params: Promise<{ scope: string }> }) {
  const { scope } = await params;
  return <WeekView scope={parseScope(scope)} />;
}
