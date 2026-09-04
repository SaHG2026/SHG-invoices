import { VenueInvoices } from '@/components/screens/VenueInvoices';

/**
 * A venue account's only screen.
 *
 * Thin, like every other page here: the screen component takes plain values so
 * it can be rendered in a test without a router. HANDOFF §5 — `use(params)`
 * never resumes in a bare test render, and although this route has no params,
 * keeping the split means this page stays the same shape as its neighbours.
 */
export default function VenuePage() {
  return <VenueInvoices />;
}
