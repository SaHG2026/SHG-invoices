// deno-lint-ignore-file no-explicit-any

/**
 * Signs and sends push notifications. That is the whole job.
 *
 * =============================================================================
 * The decision that shapes this file: it has no database access at all.
 *
 * The obvious design is the one every tutorial shows — the function takes an
 * invoice id, connects to Supabase with the service-role key, reads
 * `push_targets`, and sends. **That key cannot exist in this project.**
 * HANDOFF §4.1: not in the app, not on Vercel, not in a script. It bypasses
 * RLS and makes `auth.uid()` return null, which silently destroys the
 * attribution on every invoice. The rule is absolute precisely so that no
 * future feature has to re-argue it, and "but this one only reads" is exactly
 * the argument that would end it.
 *
 * So the direction is reversed. **Postgres decides who to tell** — it already
 * holds that rule, in the `push_targets` and `push_targets_payment` views — and
 * hands this function a finished list of endpoints. This function knows how to
 * sign a web-push message and nothing else. It cannot read an invoice, cannot
 * see a supplier, and cannot be tricked into either.
 *
 * What it does hold is the VAPID private key, which is the one secret that
 * genuinely cannot live in the database: signing is a thing only the sender can
 * do. It is an Edge Function secret and never enters the app bundle.
 * =============================================================================
 *
 * -----------------------------------------------------------------------------
 * Nothing that can throw happens at module scope, and that is deliberate.
 *
 * The first version imported `web-push` and called `setVapidDetails` at the top
 * of the file. Both are perfectly reasonable and both run before the request
 * handler is installed — so when one of them failed on deploy, *every* request
 * returned `WORKER_ERROR` with no detail, including a GET that should never
 * have reached any of this code. A five hundred that says nothing is the worst
 * possible answer for a thing that only runs on somebody else's infrastructure.
 *
 * So the import is dynamic, it happens inside the request, and its failure is
 * reported rather than fatal. `GET` with the shared secret answers what is
 * actually configured and whether the library loads at all, which is a check
 * that can be run from anywhere without sending anybody a notification.
 * -----------------------------------------------------------------------------
 *
 * Deploy:
 *   supabase functions deploy notify-push --no-verify-jwt
 */

const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC_KEY') ?? '';
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY') ?? '';
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? '';
const NOTIFY_SECRET = Deno.env.get('NOTIFY_SECRET') ?? '';

interface Target {
  endpoint: string;
  p256dh: string;
  auth: string;
}

interface NotifyRequest {
  title: string;
  body: string;
  url?: string;
  tag?: string;
  targets: Target[];
}

/**
 * Loaded once, on first use, and remembered — including the failure.
 *
 * `web-push` is a Node library running under Deno's compatibility layer, which
 * is the part of this most likely to break on a runtime upgrade. Holding the
 * error rather than throwing it is what lets the health check below say so in
 * a sentence instead of leaving somebody reading deployment logs.
 */
let webpushModule: any = null;
let webpushError: string | null = null;

async function loadWebPush(): Promise<any> {
  if (webpushModule || webpushError) return webpushModule;
  try {
    const mod = await import('npm:web-push@3.6.7');
    webpushModule = mod.default ?? mod;
  } catch (error) {
    webpushError = error instanceof Error ? error.message : String(error);
  }
  return webpushModule;
}

function timingSafeEqual(given: string | null, expected: string): boolean {
  if (given === null || expected === '' || given.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < expected.length; i += 1) {
    difference |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return difference === 0;
}

Deno.serve(async (request: Request) => {
  /*
   * Deployed with --no-verify-jwt, because the caller is a database trigger
   * rather than a signed-in person — so this header is the whole of the
   * authentication and it is not optional. Compared in constant time: the
   * endpoint is public, and a timing oracle on a shared secret is free to
   * prevent and tedious to explain afterwards.
   */
  const authorised = timingSafeEqual(request.headers.get('x-shg-secret'), NOTIFY_SECRET);

  /*
   * The health check. Booleans only — never a value, and never a partial one.
   *
   * Behind the secret because "which of these four things is missing" is a
   * useful sentence to an attacker as well as to us. **Except when the secret
   * itself is unset**, which is the one state where the check is most needed
   * and would otherwise be unreachable: an unconfigured function refuses every
   * request identically, so there is no way to tell "wrong secret" from "no
   * secret" from outside.
   *
   * That exception costs nothing. A function with no keys cannot send anything
   * to anybody, and all it will admit is which environment variable names are
   * empty — which is already public, in db/push/README.md.
   */
  if (request.method === 'GET') {
    if (!authorised && NOTIFY_SECRET !== '') return new Response('Forbidden', { status: 403 });

    await loadWebPush();
    return Response.json({
      status: 'up',
      library: webpushError === null ? 'loaded' : `failed: ${webpushError}`,
      configured: {
        VAPID_PUBLIC_KEY: VAPID_PUBLIC !== '',
        VAPID_PRIVATE_KEY: VAPID_PRIVATE !== '',
        VAPID_SUBJECT: VAPID_SUBJECT !== '',
        NOTIFY_SECRET: NOTIFY_SECRET !== '',
      },
    });
  }

  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!authorised) return new Response('Forbidden', { status: 403 });

  let payload: NotifyRequest;
  try {
    payload = await request.json();
  } catch {
    return new Response('Bad request', { status: 400 });
  }

  const targets = Array.isArray(payload.targets) ? payload.targets : [];
  if (targets.length === 0) return Response.json({ sent: 0, expired: [] });

  const webpush = await loadWebPush();
  if (!webpush) {
    return Response.json({ error: `web-push did not load: ${webpushError}` }, { status: 500 });
  }

  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
  } catch (error) {
    // Almost always a malformed key or a subject that is not a mailto:/https:
    // url. Said plainly here rather than left as a stack trace in a log.
    return Response.json(
      { error: `VAPID details rejected: ${error instanceof Error ? error.message : error}` },
      { status: 500 },
    );
  }

  const notification = JSON.stringify({
    title: payload.title,
    body: payload.body,
    url: payload.url ?? '/',
    tag: payload.tag ?? 'shg',
  });

  /*
   * Sent in parallel and settled, never raced.
   *
   * One dead endpoint must not stop the other three phones being told, and
   * `Promise.all` would do exactly that. Push is best-effort by nature
   * (ARCHITECTURE §8.1) and the app is built so that nothing depends on
   * delivery — the bell holds the same information either way.
   */
  const results = await Promise.allSettled(
    targets.map((target) =>
      webpush.sendNotification(
        { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
        notification,
        { TTL: 60 * 60 * 12 },
      ),
    ),
  );

  /*
   * 404 and 410 mean the browser has thrown the subscription away — the app was
   * uninstalled, or the endpoint was rotated. Those rows are dead and reported
   * back so they can be cleaned up; every other failure is transient and the
   * row is left alone.
   */
  const expired: string[] = [];
  const failed: string[] = [];
  let sent = 0;

  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      sent += 1;
      return;
    }
    const status = (result.reason as any)?.statusCode;
    if (status === 404 || status === 410) expired.push(targets[index].endpoint);
    else failed.push(String((result.reason as any)?.message ?? status ?? 'unknown'));
  });

  return Response.json({ sent, expired, failed });
});
