'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { PersonChip } from '@/components/ui/PersonChip';
import { useRecentActivity } from '@/lib/queries/detail';
import { useCurrentProfile, useProfiles } from '@/lib/queries/session';
import { countUnseen, describeActivity } from '@/lib/derive/activity';
import { formatDateTime } from '@/lib/date';
import { invoiceHref } from '@/lib/scope';

/**
 * The header bell. ARCHITECTURE §8.1.
 *
 * Everyone gets it, not just the owner — it is information, not a privilege.
 *
 * It is also the reason push can be built later without risk: push is never
 * guaranteed to arrive, so this is the channel that actually works. If a
 * notification is dropped by the phone, the same fact is still sitting here
 * the next time the app is opened, and it is still correct.
 *
 * "Seen" is per device, in localStorage. It is a convenience, not a record —
 * losing it shows a few extra items, which is the harmless direction.
 */

const SEEN_KEY = 'shg.activity.seen';

function readSeen(): string | null {
  try {
    return localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

/**
 * A bell, drawn.
 *
 * This was `&#9737;` — U+2609, "sun". It was standing in for a bell and looked
 * like neither on most devices, which is the same reason the menu and chevron
 * glyphs are drawn rather than typed: a character renders at whatever weight
 * and baseline each platform decides.
 */
function BellGlyph() {
  return (
    <svg aria-hidden width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path
        d="M9 2.25a4.5 4.5 0 0 0-4.5 4.5c0 2.4-.6 3.9-1.2 4.8-.3.45.03 1.05.57 1.05h10.26c.54 0 .87-.6.57-1.05-.6-.9-1.2-2.4-1.2-4.8A4.5 4.5 0 0 0 9 2.25Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M7.2 14.4a1.9 1.9 0 0 0 3.6 0" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function ActivityBell() {
  const { data: profile } = useCurrentProfile();
  const { data: people = [] } = useProfiles();
  const { data: activity = [] } = useRecentActivity();

  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  // Storage cannot be read during render without breaking hydration.
  useEffect(() => {
    setSeen(readSeen());
    setReady(true);
  }, []);

  const unseen = useMemo(
    () => (ready && profile ? countUnseen(activity, seen, profile.id) : 0),
    [activity, seen, profile, ready],
  );

  function toggle() {
    const next = !open;
    setOpen(next);

    // Opening it is what counts as having looked.
    if (next && activity[0]) {
      try {
        localStorage.setItem(SEEN_KEY, activity[0].created_at);
      } catch {
        /* the badge simply reappears; harmless */
      }
      setSeen(activity[0].created_at);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-label={unseen > 0 ? `Activity, ${unseen} new` : 'Activity'}
        className="touch relative flex items-center justify-center px-1 text-base text-muted"
      >
        <BellGlyph />
        {unseen > 0 ? (
          <span
            aria-hidden
            className="absolute right-0 top-1 flex size-4 items-center justify-center rounded-full text-[10px]"
            style={{ backgroundColor: 'var(--spine-overdue)', color: 'var(--card)' }}
          >
            {unseen > 9 ? '9+' : unseen}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="row-in absolute inset-x-0 top-14 z-40 max-h-[70dvh] overflow-y-auto border-b border-edge bg-card">
          <div className="mx-auto max-w-[560px] px-4 py-2">
            <p className="py-2 text-xs uppercase tracking-widest text-muted">Recent activity</p>

            {activity.length === 0 ? (
              <p className="pb-3 text-sm text-muted">Nothing has happened yet.</p>
            ) : (
              <ul>
                {activity.slice(0, 20).map((entry) => {
                  const actor = people.find((person) => person.id === entry.actor_id);
                  const described = describeActivity(entry);
                  return (
                    <li key={entry.id} className="border-b border-hairline last:border-b-0">
                      <Link
                        href={invoiceHref(entry.entity_id)}
                        onClick={() => setOpen(false)}
                        className="flex gap-3 py-2 active:bg-pressed"
                      >
                        {actor ? (
                          <PersonChip profile={actor} />
                        ) : (
                          <span className="size-6 shrink-0" />
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm text-ink">
                            {actor?.display_name ?? 'Someone'} {described.summary}
                          </span>
                          <span className="block text-xs text-muted">
                            {formatDateTime(entry.created_at)}
                          </span>
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}
