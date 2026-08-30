import { InvoiceDetail } from '@/components/screens/InvoiceDetail';

/** Thin adapter — see the note on the week view route. */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <InvoiceDetail id={id} />;
}
