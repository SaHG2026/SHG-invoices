import { SalesInvoiceDocument } from '@/components/screens/SalesInvoiceDocument';

/**
 * Thin adapter — see the note on the week view route.
 *
 * The document takes a plain id, which is what makes it renderable in a test
 * and in the preview harness without a router (HANDOFF §5).
 */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SalesInvoiceDocument id={id} />;
}
