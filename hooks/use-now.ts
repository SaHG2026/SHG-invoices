'use client';

import { useEffect, useState } from 'react';
import { nowMs } from '@/lib/date';

/**
 * The wall clock, re-read on an interval.
 *
 * The sibling of `useSydneyToday`, and it exists for the same reason at a
 * different scale: a value derived from "now" goes stale silently, and the
 * screen keeps showing the old answer with no sign that anything is wrong.
 *
 * Here that value is the venue edit window. Without a tick, an Edit button
 * would sit on a row for as long as the phone stayed open — five minutes past,
 * an hour past — and tapping it would produce a save the database refuses. A
 * button that stops working before it stops being offered is worse than no
 * button, because the person has already decided what they were going to do.
 *
 * Returns `null` on the first render, like `useSydneyToday` and for the same
 * reason: the server has no clock the client agrees with, so rendering a
 * time-dependent thing during SSR would mismatch on hydration.
 *
 * `visibilitychange` is not decoration. Browsers throttle and sometimes drop
 * timers in a backgrounded tab, and a phone put in a pocket mid-shift and
 * taken out ten minutes later is the ordinary case, not the edge one.
 */
export function useNow(intervalMs: number): number | null {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(nowMs());

    const timer = setInterval(() => setNow(nowMs()), intervalMs);

    const onVisible = () => {
      if (document.visibilityState === 'visible') setNow(nowMs());
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [intervalMs]);

  return now;
}
