import { SupplierDetail } from '@/components/screens/SupplierDetail';

/** Thin adapter — see the note on the week view route. */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SupplierDetail id={id} />;
}
