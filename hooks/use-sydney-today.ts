'use client';

import { useEffect, useState } from 'react';
import { msUntilSydneyMidnight, sydneyToday, type DateStr } from '@/lib/date';

/**
 * Today, in Sydney, kept current.
 *
 * Returns `null` on the first render and the real date immediately after.
 * That is deliberate: the server cannot know what day it is where the person
 * is standing, so rendering a date during SSR would either be wrong or would
 * mismatch on hydration. Screens show a blank line for one frame instead.
 *
 * The timer matters more than it looks. A phone left open on the counter
 * overnight would otherwise keep yesterday's date forever — and every "due
 * today" and "4 days late" on screen would be quietly wrong the next morning,
 * which is precisely the moment the app is being trusted (spec §1, the
 * Monday-morning question).
 */
export function useSydneyToday(): DateStr | null {
  const [today, setToday] = useState<DateStr | null>(null);

  useEffect(() => {
    setToday(sydneyToday());

    let timer: ReturnType<typeof setTimeout>;

    const scheduleRollover = () => {
      // A second past midnight, so the clock has definitely ticked over.
      timer = setTimeout(() => {
        setToday(sydneyToday());
        scheduleRollover();
      }, msUntilSydneyMidnight() + 1000);
    };

    scheduleRollover();

    // Coming back to a backgrounded app is the other way the date goes stale:
    // some browsers throttle or drop timers while hidden.
    const onVisible = () => {
      if (document.visibilityState === 'visible') setToday(sydneyToday());
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return today;
}
