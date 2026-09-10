import type { NextRequest } from 'next/server';
import { updateSession } from '@/lib/supabase/middleware';

/*
 * `proxy`, not `middleware`. Next 16 renamed the convention to make the
 * network boundary explicit, and the old name is deprecated.
 *
 * The rename is the whole change: the matcher below, the exclusion list and
 * `updateSession` are untouched. Worth knowing that `proxy` runs on the
 * NODEJS runtime and cannot be configured to edge — this never asked for
 * edge, so nothing is lost, but a future change that wants it would have to
 * go back to `middleware`.
 */
export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Every route except static assets and the icons. Listed as an exclusion
     * rather than an inclusion on purpose: a new screen added in a later phase
     * is guarded by default, and forgetting to add it here cannot expose it.
     *
     * `offline` is excluded because the service worker precaches it at install
     * and serves it when there is no network. Guarded, what gets cached is
     * whatever the guard returned - which for a signed-out request is a
     * redirect to /login - so the page shown when the phone loses signal would
     * depend on when the worker happened to install. It holds no data: it says
     * there is no connection, and that queued writes are safe on the phone.
     */
    '/((?!_next/static|_next/image|favicon.ico|icons/|manifest.webmanifest|sw.js|offline|.*\\.(?:svg|png|jpg|jpeg|gif|webp|woff2?)$).*)',
  ],
};
