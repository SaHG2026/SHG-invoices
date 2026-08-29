import { createBrowserClient } from '@supabase/ssr';

/**
 * The one Supabase client the app uses.
 *
 * Architecture §1: every read and write goes through here, in the browser,
 * carrying the signed-in person's own JWT. There is no server-side data
 * fetching and no service-role key anywhere in this codebase — which is what
 * makes `auth.uid()` reliably the real person inside the audit trigger and
 * every RLS policy (notes §2).
 *
 * The session lives in cookies rather than localStorage so `middleware.ts`
 * can see it and guard routes before a page renders.
 */

let client: ReturnType<typeof createBrowserClient> | null = null;

export function supabase() {
  if (client) return client;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error(
      'Supabase is not configured. NEXT_PUBLIC_SUPABASE_URL and ' +
        'NEXT_PUBLIC_SUPABASE_ANON_KEY must be set in .env.local.',
    );
  }

  client = createBrowserClient(url, key);
  return client;
}
