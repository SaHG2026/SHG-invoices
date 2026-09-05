import { ReviewList } from '@/components/screens/ReviewList';

/**
 * Thin adapter — see the note on the week view route.
 *
 * No scope segment on purpose. Reviewing is a job done across the whole group
 * in one sitting, and a business filter in the URL would hide the second
 * shop's morning behind a control nobody thought to change.
 */
export default function Page() {
  return <ReviewList />;
}
