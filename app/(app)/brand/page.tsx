import { BrandScreen } from '@/components/screens/BrandScreen';

/**
 * Thin, like every other route in this app: the page is the URL and the screen
 * is the component. ARCHITECTURE §10 and HANDOFF §5 — a screen that takes plain
 * values is a screen a test can render.
 */
export default function Page() {
  return <BrandScreen />;
}
