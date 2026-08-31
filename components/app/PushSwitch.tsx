'use client';

import { useToast } from '@/components/ui/Toast';
import { useDisablePush, useEnablePush, usePushSupport } from '@/lib/queries/push';

/**
 * Notifications on this phone.
 *
 * Sits under the person-level switch in Settings, and the pairing is the point:
 * the switch above decides whether they are told, this decides which of their
 * devices rings. Milan with a phone and a tablet turns this on twice.
 *
 * ---------------------------------------------------------------------------
 * What this does not do
 *
 * It never asks first. No prompt on the dashboard, no interstitial after
 * signing in, no badge suggesting anybody enable anything — ARCHITECTURE §28.4:
 * the client's instruction is that the app should be *capable* of push and that
 * turning it on is theirs to decide. Somebody who never opens Settings never
 * hears about this, which is the intended outcome and not an oversight.
 *
 * The browser's own permission prompt is fired from the tap on this switch and
 * nowhere else. Asked cold, it is the prompt everybody denies by reflex — and a
 * denial cannot be undone by the app, only by the person, in browser settings.
 * ---------------------------------------------------------------------------
 */
export function PushSwitch({ profileId }: { profileId: string | undefined }) {
  const toast = useToast();
  const { data: support, isLoading } = usePushSupport();
  const enable = useEnablePush(profileId);
  const disable = useDisablePush();

  if (isLoading || support === undefined) {
    return <p className="mt-3 text-sm text-muted">Checking this device…</p>;
  }

  /*
   * Apple's, and worth saying plainly rather than hiding the control.
   *
   * On an iPhone a site in a Safari tab has no Push API at all; added to the
   * Home Screen, the same site has one. There is no way to work around it and
   * no setting that helps, so the honest thing is to say what to do.
   */
  if (support === 'needs-home-screen') {
    return (
      <p className="mt-3 text-sm text-muted">
        Add SHG Invoices to your Home Screen to get notifications on this phone. Share, then{' '}
        <span className="text-ink">Add to Home Screen</span>.
      </p>
    );
  }

  if (support === 'denied') {
    return (
      <p className="mt-3 text-sm text-muted">
        Notifications are blocked for this app. Your browser&rsquo;s settings for this site is the
        only place that can be changed.
      </p>
    );
  }

  if (support === 'unavailable') {
    // No Push API, or no key in this build. Nothing to offer and nothing the
    // person can do, so nothing is said.
    return null;
  }

  const busy = enable.isPending || disable.isPending;

  async function toggle(on: boolean) {
    try {
      if (on) await enable.mutateAsync();
      else await disable.mutateAsync();
      toast.show(on ? 'This device will be notified.' : 'This device will not be notified.');
    } catch (error) {
      toast.show(
        error instanceof Error ? error.message : 'Couldn’t change that on this device.',
        'problem',
      );
    }
  }

  return (
    <label className="mt-3 flex items-start gap-3 text-sm text-ink">
      <input
        type="checkbox"
        checked={support === 'on'}
        disabled={busy}
        onChange={(event) => void toggle(event.target.checked)}
        className="mt-0.5 size-4 shrink-0"
      />
      <span>Notify this device</span>
    </label>
  );
}
