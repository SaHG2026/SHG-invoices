import { CustomerDetail } from '@/components/screens/CustomerDetail';

/**
 * Thin adapter, matching suppliers/[id]: unwrap the route params, hand a plain
 * id to the screen. Route mechanics stay out of the part with the logic in it.
 */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CustomerDetail id={id} />;
}
