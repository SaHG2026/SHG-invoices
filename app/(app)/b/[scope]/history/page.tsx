import { HistoryList } from '@/components/screens/HistoryList';
import { parseScope } from '@/lib/scope';

/** Thin adapter — see the note on the week view route. */
export default async function Page({ params }: { params: Promise<{ scope: string }> }) {
  const { scope } = await params;
  return <HistoryList scope={parseScope(scope)} />;
}
