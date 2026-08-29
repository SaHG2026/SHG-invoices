import { sydneyHour } from './date';

/**
 * The dashboard greeting.
 *
 * Spec §8 still applies: sentence case, no exclamation marks, no emoji. This
 * is the one place in the app allowed any warmth, and it stays quiet — the
 * screen underneath it is about money leaving the account.
 *
 * The hour comes from Sydney, not from the phone. A handset can be set to any
 * timezone; somebody standing in the Hurstville shop at 9am gets told good
 * morning regardless of what their device thinks the time is.
 */

export type TimeOfDay = 'morning' | 'afternoon' | 'evening' | 'night';

export function timeOfDay(hour: number): TimeOfDay {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 22) return 'evening';
  return 'night';
}

const GREETING: Record<TimeOfDay, (name: string) => string> = {
  morning: (name) => `Good morning, ${name}`,
  afternoon: (name) => `Afternoon, ${name}`,
  evening: (name) => `Evening, ${name}`,
  night: (name) => `Late night, ${name}?`,
};

/**
 * `greet('Sujan')` -> 'Good morning, Sujan'
 *
 * `now` is injectable so the four cases can be tested at fixed instants
 * rather than by waiting until evening.
 */
export function greet(displayName: string, now: Date = new Date()): string {
  const name = displayName.trim();
  if (name === '') return 'Hello';
  return GREETING[timeOfDay(sydneyHour(now))](name);
}
