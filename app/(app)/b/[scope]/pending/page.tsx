import { PendingList } from '@/components/screens/PendingList';
import { parseScope } from '@/lib/scope';

/** Thin adapter — see the note on the week view route. */
export default async function Page({ params }: { params: Promise<{ scope: string }> }) {
  const { scope } = await params;
  return <PendingList scope={parseScope(scope)} />;
}
