import type { NextRequest } from 'next/server';
import { updateSession } from '@/lib/supabase/middleware';

export async function middleware(request: NextRequest) {
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
