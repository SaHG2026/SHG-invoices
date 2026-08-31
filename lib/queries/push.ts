'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase/browser';

/**
 * Turning phone notifications on, for one device.
 *
 * ---------------------------------------------------------------------------
 * Per device, not per person — and that is the whole shape of this file.
 *
 * A push subscription belongs to a browser on a handset, not to a human.
 * Milan with a phone and a tablet has two, and turning notifications off on
 * the tablet must not turn them off on the phone. So `push_subscriptions` is
 * keyed on the endpoint the browser hands out, and this file only ever touches
 * the row for the browser it is running in.
 *
 * The person-level preference is separate and lives on `profiles`: the switch
 * in Settings decides whether they are told at all, this decides which of
 * their devices rings. Both have to be on.
 * ---------------------------------------------------------------------------
 *
 * ARCHITECTURE §8.1, and worth restating where the code is: **push is a nudge
 * on top of the in-app bell, never the channel.** The phone can be off, the
 * endpoint can expire, iOS drops it entirely unless the app has been added to
 * the Home Screen. Nothing in this app may depend on a notification arriving,
 * and nothing does — the bell holds the same information the next time the app
 * is opened.
 */

/** Supplied at build time. Public by definition: it ships in every bundle. */
const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? '';

export type PushSupport =
  /** Subscribed on this device. */
  | 'on'
  /** Could be, and is not. */
  | 'off'
  /** The person said no. Only they can undo it, in browser settings. */
  | 'denied'
  /** iOS in a browser tab: no push until the app is on the Home Screen. */
  | 'needs-home-screen'
  /** No service worker, no Push API, or no key configured. Nothing to offer. */
  | 'unavailable';

/**
 * What this device can actually do, asked rather than assumed.
 *
 * The `needs-home-screen` case is the one worth spelling out, because it is
 * Apple's and there is no way around it: on an iPhone, a site running in a
 * Safari tab has no Push API at all. Added to the Home Screen, the same site
 * has one. Detecting it is why `standalone` is checked — the alternative is
 * offering a switch that silently does nothing, which is how somebody comes to
 * believe they are being notified when they are not.
 */
export function usePushSupport() {
  return useQuery({
    queryKey: ['push', 'support'] as const,
    queryFn: async (): Promise<PushSupport> => {
      if (VAPID_PUBLIC_KEY === '') return 'unavailable';
      if (!('serviceWorker' in navigator)) return 'unavailable';

      // Read before branching. Narrowing on `in` would leave `window` typed as
      // never inside the block, which is TypeScript being right about a lie:
      // the absence of one property says nothing about the rest of it.
      const hasPushApi = 'PushManager' in window;
      if (!hasPushApi) {
        const iOS = /iP(hone|ad|od)/.test(navigator.userAgent);
        const installed = window.matchMedia('(display-mode: standalone)').matches;
        return iOS && !installed ? 'needs-home-screen' : 'unavailable';
      }

      if (Notification.permission === 'denied') return 'denied';

      const registration = await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      return existing ? 'on' : 'off';
    },
    // Cheap, local, and changes when the person changes it in browser settings
    // behind our back. Not worth caching for long.
    staleTime: 5_000,
    retry: false,
  });
}

/**
 * Subscribe this device, and record where to reach it.
 *
 * Deliberately not queued for offline. Every other write in this app is
 * (`lib/offline/keys.ts`), and this one must not be: a push endpoint is issued
 * by the browser's push service, which requires the network anyway, and an
 * endpoint saved from a session hours ago may already have been rotated. There
 * is nothing to gain and a stale endpoint to lose.
 */
export function useEnablePush(profileId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (): Promise<void> => {
      if (!profileId) throw new Error('Not signed in.');

      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        throw new Error('Notifications are blocked for this app in your browser settings.');
      }

      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        // Required by every browser: a push that cannot be shown is not
        // allowed to arrive silently.
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });

      const json = subscription.toJSON();
      const { error } = await supabase()
        .from('push_subscriptions')
        .upsert(
          {
            profile_id: profileId,
            endpoint: subscription.endpoint,
            p256dh: json.keys?.p256dh ?? '',
            auth: json.keys?.auth ?? '',
            user_agent: navigator.userAgent,
          },
          // The endpoint is the key, not the person: re-subscribing the same
          // browser replaces its row rather than adding a second one.
          { onConflict: 'endpoint' },
        );

      if (error) throw error;
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['push', 'support'] });
    },
  });
}

/**
 * Stop this device ringing.
 *
 * Both halves, in this order: unsubscribe from the browser's push service,
 * then delete the row. Doing only the second leaves the endpoint live, so the
 * phone keeps receiving pushes the app can no longer account for; doing only
 * the first leaves a dead endpoint the sender keeps trying.
 */
export function useDisablePush() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (): Promise<void> => {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (!subscription) return;

      await subscription.unsubscribe();

      const { error } = await supabase()
        .from('push_subscriptions')
        .delete()
        .eq('endpoint', subscription.endpoint);

      if (error) throw error;
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['push', 'support'] });
    },
  });
}

/**
 * The VAPID key as the Push API wants it.
 *
 * It is published as url-safe base64 and `applicationServerKey` takes bytes.
 * Every web-push tutorial contains this function; it is here rather than in a
 * dependency because it is nine lines and a dependency for nine lines is how
 * `node_modules` gets to be the size it is.
 */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, '+')
    .replace(/_/g, '/');

  const raw = atob(padded);
  // Built over an explicit ArrayBuffer so the type is Uint8Array<ArrayBuffer>:
  // applicationServerKey will not take one that might be backed by a
  // SharedArrayBuffer, and the bare constructor leaves that open.
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
