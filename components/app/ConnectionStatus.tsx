'use client';

import { useIsOnline, useQueuedWriteCount } from '@/lib/offline/pending';

/**
 * Whether the phone is on the network, in the header, all the time.
 *
 * Asked for directly: "include a wifi like symbol on the header bar to signify
 * if they are online or offline".
 *
 * ---------------------------------------------------------------------------
 * Always visible, which is a change of mind worth recording
 *
 * This started as a pill that appeared only when something was wrong — nothing
 * to say when there is signal, per notes §6 about interfaces that narrate
 * themselves. The client asked for the opposite and is right, for a reason
 * that only applies to this app: **a symbol that appears when there is a
 * problem is a symbol nobody has ever seen before the problem.** On a dock
 * with one bar, the question is not "is something wrong" but "did that save",
 * and an indicator that is normally absent cannot answer it — you cannot tell
 * "fine" from "not rendered".
 *
 * So it is always there, and the arcs simply go quiet. It costs 16 pixels of
 * a header that has just given up 24 by dropping the profile chip.
 * ---------------------------------------------------------------------------
 */
export function ConnectionStatus() {
  const online = useIsOnline();
  const queued = useQueuedWriteCount();

  /*
   * The count is the more useful fact when there is one.
   *
   * "2 waiting" already implies there is no signal, and it is the half that
   * says something about somebody's invoices rather than about their phone.
   */
  const label =
    queued > 0
      ? `${queued} ${queued === 1 ? 'invoice' : 'writes'} waiting to send`
      : online
        ? 'Online'
        : 'Offline';

  return (
    <span
      role="status"
      aria-live="polite"
      aria-label={label}
      title={label}
      className={`flex shrink-0 items-center gap-1 px-1 ${online ? 'text-muted' : 'text-ink'}`}
    >
      <WifiGlyph online={online} />

      {queued > 0 ? (
        <span className="text-xs" style={{ fontFamily: 'var(--font-mono)' }}>
          {queued}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Drawn rather than typed, like every other glyph in this header: the wifi
 * characters that exist render as emoji on some phones and as boxes on others.
 *
 * Offline is the same three arcs with a stroke through them rather than a
 * different icon — so the two states read as one thing changing rather than as
 * two unrelated symbols, which is what makes it legible at 16px without
 * anybody having been told what it means.
 */
function WifiGlyph({ online }: { online: boolean }) {
  return (
    <svg aria-hidden width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path
        d="M1.6 5.6a9.5 9.5 0 0 1 12.8 0"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        opacity={online ? 1 : 0.35}
      />
      <path
        d="M4 8.2a6 6 0 0 1 8 0"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        opacity={online ? 1 : 0.35}
      />
      <path
        d="M6.4 10.8a2.5 2.5 0 0 1 3.2 0"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      {online ? null : (
        <path d="M2.5 13.5 13.5 2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      )}
    </svg>
  );
}
