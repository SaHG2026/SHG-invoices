import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Route guarding, and only route guarding.
 *
 * Architecture §1: the server never fetches invoice data. This exists to do
 * two jobs and nothing else — refresh the auth cookie so a session does not
 * expire while somebody is mid-week, and send anyone without one to /login.
 *
 * Notes §2 applies as much here as anywhere: this is not the security
 * boundary. If this file were deleted, RLS would still refuse every request
 * from an unauthenticated client. This just means people see a login screen
 * rather than an empty app.
 */

/** Reachable without a session. Everything else requires one. */
const PUBLIC_PATHS = ['/login'];

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // getUser, not getSession. getSession reads the cookie and trusts it;
  // getUser verifies the token with Supabase. A cookie is something the
  // browser hands us, and we do not take the browser's word for who it is.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    // Remember where they were headed, so signing in lands them there rather
    // than dumping them on the dashboard.
    if (pathname !== '/') url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }

  if (user && pathname === '/login') {
    const url = request.nextUrl.clone();
    url.pathname = '/';
    url.search = '';
    return NextResponse.redirect(url);
  }

  return response;
}
