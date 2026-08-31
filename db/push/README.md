# Turning push on

**Steps 1–3 are done.** The keypair is generated, the public half is set in
Vercel, and CATCH_UP_006 has been run. What is left is steps 4 and 5, which
need a Supabase login — the one credential that does not exist on my side.

The two secret values for step 4 were handed over separately and are
deliberately not in this repo. If you no longer have them, generate a fresh
keypair with `npx web-push generate-vapid-keys` and update
`NEXT_PUBLIC_VAPID_PUBLIC_KEY` in Vercel to match.

Until then the app behaves exactly as it does now: the switch in Settings works,
devices subscribe, and nothing is ever sent. Nothing is broken in the meantime,
because the in-app bell was always the real channel and push was always a nudge
on top of it (`ARCHITECTURE.md` §8.1).

Do these in order. Steps 2–5 are one sitting, about twenty minutes.

---

## 1. `CATCH_UP_006.sql` — already sent

Adds `notify_on_payment`, the two audience views, and the locks on
`push_subscriptions`. Safe on its own: it changes no invoice and sends nothing.

## 2. Generate a VAPID key pair

A keypair identifies this app to Apple's, Google's and Mozilla's push services.
On any machine with Node:

```bash
npx web-push generate-vapid-keys
```

It prints a public key and a private key. **The private key never goes in the
repo, in Vercel, or in a message.** It is pasted into step 4 and nowhere else.

## 3. Put the public key in the app

The public half ships in every bundle — that is what it is for. In Vercel, add
an environment variable to the project:

```
NEXT_PUBLIC_VAPID_PUBLIC_KEY = <the public key from step 2>
```

Then redeploy. Without it, the Settings switch stays hidden rather than offering
something that cannot work.

## 4. Deploy the Edge Function

From the repo, signed in with the Supabase CLI:

```bash
supabase functions deploy notify-push --no-verify-jwt
```

Then set its secrets. `NOTIFY_SECRET` is any long random string — it is what
proves a request came from our own database and not from someone who found the
function's url:

```bash
supabase secrets set VAPID_PUBLIC_KEY=<public>
supabase secrets set VAPID_PRIVATE_KEY=<private>
supabase secrets set VAPID_SUBJECT=mailto:sagarmathaholdings2026@gmail.com
supabase secrets set NOTIFY_SECRET=<a long random string>
```

`--no-verify-jwt` is deliberate and safe here: the caller is a database trigger,
not a signed-in person, so there is no JWT to check. `NOTIFY_SECRET` is what
stands in its place.

## 5. `notify_trigger.sql`

Replace the two `PASTE_` values near the top of the file with the function's
url and the same `NOTIFY_SECRET` from step 4, then paste the whole file into the
SQL editor and run it. One tab, one go.

**Do not reach for `alter database postgres set app.notify_url = ...`.** It is
the obvious way to hold those two values and it fails on a hosted project with
`42501: permission denied to set parameter` DASH the SQL editor connects as
`postgres`, which is not a superuser on Supabase, and setting a database-level
parameter needs one. That is why the file keeps them in a table with RLS on and
no policy instead. Learned the hard way; do not re-derive it.

---

## Checking it

Add an invoice from one phone with another phone's switch turned on. The second
phone should get "New invoice — Bidfood — $5,220".

If nothing arrives, in this order:

1. **Is the receiving phone an iPhone that is not on the Home Screen?** Then it
   will never arrive, and that is Apple's rule, not a fault. Settings says so on
   that phone rather than showing a switch.
2. `select * from net._http_response order by created desc limit 5;` — this is
   pg_net's own log. A 403 means the secret does not match between step 4 and
   step 5. A 404 means the url is wrong.
3. `select count(*) from push_subscriptions;` — zero means no device has
   actually subscribed, whatever the switch appeared to say.

## What can be changed later without a deploy

- **Who hears about payments.** `update profiles set notify_on_payment = true
  where display_name = '…'`. It is deliberately not something anybody can turn
  on for themselves.
- **Turning push off entirely.** `drop trigger invoice_push on invoices;` The
  app carries on exactly as before.
