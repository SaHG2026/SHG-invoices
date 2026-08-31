'use client';

import { useEffect } from 'react';

/**
 * Registers the service worker, and nothing else.
 *
 * Renders no markup. It is a component rather than a call in a layout because
 * registration has to happen in the browser after hydration, and a component
 * with an effect is the honest way to say that in this codebase.
 *
 * ---------------------------------------------------------------------------
 * Registered after load, deliberately
 *
 * A service worker installing during startup competes with the very requests
 * it exists to make faster — on the one screen with a fifteen-second target,
 * measured on a phone on shop wifi. Waiting for `load` costs nothing: the
 * worker controls the *next* navigation either way, never this one.
 *
 * And it is skipped entirely in development. A worker caching the shell across
 * a hot reload produces the worst class of bug there is — the one where the
 * code on screen is not the code on disk.
 * ---------------------------------------------------------------------------
 */
export function ServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (!('serviceWorker' in navigator)) return;

    const register = () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        /*
         * Swallowed on purpose.
         *
         * Registration fails in a private window, under some enterprise
         * policies, and on any browser that has decided it does not want one.
         * Every one of those is a browser the app still works perfectly well
         * in — the queue is IndexedDB and the data is the network. Losing the
         * offline shell is not worth a message that would only ever appear at
         * a moment when nothing is actually wrong.
         */
      });
    };

    if (document.readyState === 'complete') register();
    else {
      window.addEventListener('load', register);
      return () => window.removeEventListener('load', register);
    }
  }, []);

  return null;
}
