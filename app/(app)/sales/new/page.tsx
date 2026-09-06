import { ComposeSalesInvoice } from '@/components/screens/ComposeSalesInvoice';

/**
 * Thin adapter — see the note on the week view route.
 *
 * The customer arrives in the query string because "new invoice for THIS
 * customer" has to actually be for that customer: the link said so, and a
 * screen that then asks you to choose again is the link not working. Search
 * params are unwrapped here and handed on as a plain string, the same split
 * every dynamic route in this app uses — HANDOFF §5, `use(params)` never
 * resumes in a bare test render.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string }>;
}) {
  const { customer } = await searchParams;
  return <ComposeSalesInvoice customerId={customer ?? ''} />;
}
