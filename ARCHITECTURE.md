# Sagarmatha Payments — Architecture & Workflow

Companion to `sagarmatha-payments-spec.md` (what to build) and `CLAUDE-CODE-NOTES.md` (where the bugs will be).
This document is the third leg: **how it is put together, and in what order.**

> **This file is an archive, not a briefing. Do not read it end to end.**
> Start with `HANDOFF.md` — it carries everything needed to work, and its §1
> has an index saying which section here answers which question. Come back for
> the reasoning behind one decision, and grep for that section.
>
> Sections are append-only and dated by their number. Nothing here is edited
> when it is superseded; a later section says so and says why. That is what
> makes it worth keeping — the record of what was believed at the time is how
> you tell a decision from an accident.

Everything here is a decision, not an option. Where I have deviated from the spec or chosen between
two defensible paths, it is marked **[decision]** with the reasoning.

---

## 0. The shape of the thing, in one paragraph

A single Next.js app, deployed to Vercel, that is a **thin shell around a client-side data layer
talking directly to Supabase with the signed-in user's JWT.** Postgres holds the rules; RLS enforces
them; the browser holds one TanStack Query cache; the UI is a pure function of that cache. There is
no server-side data fetching, no service-role key in the running app, and no second cache. That one
constraint eliminates most of §1 and all of §2 of the notes by construction.

---

## 1. Rendering model — [decision] client-first, not server-first

Next.js 15 App Router pushes you toward Server Components and server-side data fetching. **We are not
doing that for any invoice data.** Reasons, in order of weight:

1. **`auth.uid()` must work.** The audit trigger, the RLS policies and `mark_invoices_paid` all depend
   on `auth.uid()` returning the real person. The moment data fetching moves server-side, the
   temptation to reach for the service-role key appears, and `auth.uid()` returns null — the exact
   trap named in notes §2. If the app never holds the service-role key at runtime, the trap cannot be
   sprung.
2. **One cache, not two.** Next's fetch cache plus TanStack Query's cache is two sources of truth for
   the same rows. Notes §1.4 (optimistic update reverted by a late refetch) is what happens when two
   caches disagree. We have one.
3. **Optimistic writes and the offline queue live in the browser anyway.** Splitting reads to the
   server and writes to the client leaves the optimistic update with nothing coherent to update.
4. **Speed of entry.** The add-invoice sheet must not wait on a server round-trip to render.

What the server does, and nothing more:

| Server-side thing | Job |
|---|---|
| `middleware.ts` | Refresh the Supabase auth cookie, redirect unauthenticated requests to `/login`. Route guarding only — never data. |
| `app/layout.tsx` | Fonts, CSS tokens, manifest link. |
| `app/(app)/layout.tsx` | Static shell (header, nav, sheet host). No data. |
| `/login` | The only route that posts credentials. |

Session transport is **cookies**, via `@supabase/ssr`'s `createBrowserClient`, so middleware can see
the session. No `localStorage` session.

**Anti-pattern to watch for:** `router.refresh()`. It re-runs the server layout and remounts the tree.
Called while the add-invoice sheet is open it reproduces notes §1.1 exactly. Banned outside `/login`
and sign-out.

---

## 2. The most important data decision — [decision] the unpaid set is client-resident

There are four businesses. The unpaid invoice set will be somewhere between 30 and a few hundred rows.
It is small.

Therefore: **one query fetches every unpaid invoice (joined to supplier and business). Home, Pending,
the payment-run grouping, the business filter, all four sorts and the sticky footer total are all
derived — synchronously, client-side — from that single array.**

This is a correctness measure, not an optimisation. Notes §3 says the sticky total must reflect the
current filter, and that a total from a separate query is a trust-destroying bug. If the total and the
list are both `useMemo` over the same array, they *cannot* disagree. There is no code path where they
diverge.

```
useUnpaidInvoices()            ->  Invoice[]   (one query, one cache entry)
   |- selectByBusiness(rows, businessId)
   |- bucketByUrgency(rows, today)      -> { overdue, today, thisWeek, later }
   |- groupIntoRuns(rows)               -> PaymentRun[]   (supplier_id + due_date)
   |- sortBy(rows, 'due'|'supplier'|'amount'|'added')
   \- sumCents(rows)                    -> the sticky total
```

All five are pure functions in `lib/derive/`. All five are unit-testable without a database, which is
what makes the notes §6 test list cheap to actually write.

**History is the exception.** Paid and void invoices grow without bound, so History is a separate,
server-filtered, paginated query with its own search. It never feeds a total that has to agree with a
list on another screen.

---

## 3. Time — one module, one hook, no exceptions

Notes §1.2 is the bug most likely to be believed rather than noticed. The defence is that there is
exactly one way to obtain "today" in this codebase.

```ts
// lib/date.ts
export const TZ = 'Australia/Sydney';
export function sydneyToday(now?: Date): string;   // 'YYYY-MM-DD'
export function formatDay(d: string): string;      // 'Fri 11 Sep'
export function formatDateTime(ts: string): string; // '11 Sep, 8:30am', rendered in Sydney
export function daysBetween(a: string, b: string): number;
```

**[decision] `date-fns` is not used, and has been removed.** Spec §4 lists it in the stack. Every job
it would have done here is done better without it:

- *Date arithmetic.* `date-fns` parses `'2026-08-28'` into a `Date` at **local** midnight, which
  reintroduces exactly the timezone this module exists to keep out. `lib/date.ts` anchors to UTC
  instead, so "add 7 days" is 7 × 86,400,000 ms with no daylight-saving discontinuity and no
  dependence on where the machine is.
- *Formatting.* Handled by an explicit month/weekday table — see below.

Nothing else needed it, so it is one fewer dependency rather than one that sits unused. If a later
phase genuinely wants it, adding it back is one command.

**[decision] Month and weekday names are a hard-coded table, not `Intl`.** Found while building
Phase 1: Node's ICU renders `en-AU` September as **"Sept"** and inserts a comma after the weekday —
`'Fri, 11 Sept'` where spec §8 requires `'Fri 11 Sep'`. That output is not stable across Node versions
or across browsers, so a phone and a laptop can disagree about the same invoice. `Intl` is still used,
but only ever to ask for *numbers* in a given timezone. Numbers are locale-stable; names are not.

Rules, enforced by lint rule and by review:

- `new Date()` appears in `lib/date.ts` and nowhere else in application code.
- `toISOString()` is banned outright. It is the exact mechanism of the previous app's week bug.
- `due_date` / `invoice_date` are Postgres `date` and TypeScript `string` (`'YYYY-MM-DD'`). They are
  **never** parsed into a `Date`. Comparing two `'YYYY-MM-DD'` strings lexicographically is correct
  and timezone-proof; that is how urgency bucketing works.
- `paid_at` / `created_at` are `timestamptz`, formatted for display in Sydney, never compared to a date.
- `useSydneyToday()` returns today's date string and schedules one timer to Sydney midnight, so a phone
  left open overnight re-buckets instead of lying.
- Postgres never computes urgency. The one place the database knows about Sydney is `sydney_today()`,
  used solely to stamp the internal ref — a label, not a comparison.

---

## 4. Money — one parser, one formatter

```ts
// lib/money.ts
export function parseAmountToCents(input: string): number | null;  // null = reject, never coerce
export function formatCents(cents: number): string;                // Intl, en-AU, AUD
export function sumCents(rows: { amount_cents: number }[]): number; // integers only
```

`parseAmountToCents` strips `$`, spaces and thousands separators, rejects anything that is not a clean
decimal with at most two places, and produces integer cents by string manipulation — not
`Math.round(parseFloat(x) * 100)`, which drifts. Round-trip tested against `"5,220.00"`, `"0.05"`,
`"1000000"`, `"5.005"`, `"abc"`, `""` (notes §6).

Nothing in `components/` is permitted to call `.toFixed()`.

---

## 5. Database

### 5.1 Migrations

Plain SQL, applied with the Supabase CLI, checked into the repo:

```
db/migrations/
  001_enums_and_tables.sql
  002_indexes.sql
  003_rls.sql
  004_internal_ref.sql
  005_audit_trigger.sql
  006_rpc_payments.sql
db/seed/
  001_businesses.sql
  002_profiles.sql        # run after the three auth users exist
```

Types are generated from the live schema (`supabase gen types typescript`) into `lib/db-types.ts`.
That is type safety, not an ORM — it satisfies the §4 constraint.

Schema is exactly spec §5, plus the two additions below.

### 5.2 Internal ref — [decision] counter table + BEFORE INSERT trigger

Notes §2 requires that two simultaneous inserts cannot produce the same ref. `select max()` then insert
loses that race. An advisory lock works but adds a lock to reason about. The race-free form that needs
neither is an upsert against a counter table, resolved in one statement under Postgres' own row lock:

```sql
create table invoice_ref_counters (
  business_id uuid not null references businesses(id),
  day         date not null,
  n           int  not null,
  primary key (business_id, day)
);

-- inside a BEFORE INSERT trigger on invoices:
insert into invoice_ref_counters (business_id, day, n)
values (new.business_id, v_day, 1)
on conflict (business_id, day)
  do update set n = invoice_ref_counters.n + 1
returning n into v_n;

new.internal_ref := v_code || '-' || to_char(v_day, 'YYMMDD') || '-' || lpad(v_n::text, 2, '0');
```

`v_day` is `(now() at time zone 'Australia/Sydney')::date` — the day it was *logged*, matching the
spec's wording ("third invoice logged for Hurstville on 28 Aug"), not the invoice date.

**Known and accepted consequence:** an offline retry that hits `on conflict (id) do nothing` (§7) still
fires the BEFORE INSERT trigger and burns a counter value, so ref sequences can contain gaps. Refs are
identifiers, not a count — gaps are harmless and far preferable to any scheme that risks a collision.
Recorded here so it is not later "fixed" into a race.

### 5.3 Audit trigger

`after insert or update on invoices`, writing a diff of changed fields into `activity_log.detail`.
Actor resolution:

```sql
coalesce(auth.uid(), nullif(current_setting('app.actor_id', true), '')::uuid)
```

`auth.uid()` covers every real user write. The `app.actor_id` fallback exists only so seed and
migration scripts can attribute themselves; the application never sets it. The `not null` constraint on
`actor_id` stays — notes §2 is explicit that relaxing it loses attribution permanently.

### 5.4 Payment RPCs

```sql
create function mark_invoices_paid(p_ids uuid[], p_ref text)
returns setof invoices
language sql
security invoker            -- RLS and auth.uid() both still apply
as $BODY$
  update invoices
     set status = 'paid', paid_at = now(), paid_by = auth.uid(),
         payment_ref = nullif(trim(p_ref), ''), updated_at = now()
   where id = any(p_ids) and status = 'unpaid'
  returning *;
$BODY$;
```

One statement, one transaction — notes §1.6, and it covers both a single tick and a whole payment run,
so there is only one code path to get right. It returns only the rows it actually flipped, so if
someone else ticked one off two seconds earlier the client can say so honestly instead of silently
disagreeing with the server.

`security invoker`, not `definer` — the function must not become a hole around RLS.

Siblings on the same pattern: `unmark_invoice_paid(p_id)` and `void_invoice(p_id, p_reason)`.

### 5.5 RLS

As spec §5. Every table gets `enable row level security` and the `member_all` policy, plus the
`profiles (id) where active` index from notes §2.

**Phase 1 exit test:** an anonymous `supabase-js` client and a wrong-JWT client each get zero rows and a
failed insert on every table. Written as a script so it can be re-run after any policy change, not a
one-off click-through.

---

## 6. The form guard — [decision] one global, not one per component

Notes §1.1 shipped three times because each fix was local. So the fix is a single global, wired into
the QueryClient defaults where no future screen can forget it.

```ts
// lib/form-guard.ts
let openForms = 0;
export const formGuard = {
  isBlocked: () => openForms > 0,
  acquire: () => { openForms++; return () => { openForms--; }; },
};
// useFormGuard() acquires on mount, releases on unmount.
```

```ts
new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: () => !formGuard.isBlocked(),
      refetchOnReconnect:   () => !formGuard.isBlocked(),
      staleTime: 30_000,
    },
  },
});
```

Every sheet, modal and inline edit calls `useFormGuard()` in its root component. One line, and it
becomes impossible to have an open form and a live focus-refetch at the same time, regardless of which
query happens to be on screen. Form state itself lives in `react-hook-form`, with `defaultValues` set
once at mount and never re-derived from query data on render.

Verification is a Playwright test, not a memo: open sheet, type, fire `visibilitychange`, wait, assert
the field still holds the value.

---

## 7. Writes, optimism and the offline queue

All writes go through mutation factories in `lib/queries/`. The house pattern:

```
onMutate:   await queryClient.cancelQueries(key)     // non-negotiable, notes §1.4
            snapshot = getQueryData(key)
            setQueryData(key, next)
onError:    restore snapshot + a toast that names the cause
onSettled:  await the mutation fully, then invalidateQueries(key)
```

`staleTime` on the unpaid query is 30s, never 0 (notes §1.4).

**Create and edit share one payload builder.** `buildInvoicePayload(form)` is called by both paths; the
create path additionally supplies a client-generated `id`. There is no `if (isNew)` branch that writes
in one arm and not the other — notes §1.3.

**Idempotency.** The client generates the invoice `id` with `crypto.randomUUID()` *before* sending, and
the insert is `.upsert(row, { onConflict: 'id', ignoreDuplicates: true })`, i.e. `on conflict do
nothing`. A retried write from the queue is a no-op, not a duplicate (notes §1.5).

**The queue** is TanStack Query's own paused-mutation mechanism persisted to IndexedDB
(`persistQueryClient` plus `resumePausedMutations` on reconnect) — not a hand-rolled queue, and
crucially **not the service worker**. The SW makes the app installable and serves the shell offline; it
touches no writes at all. Only mutations are persisted to disk; reads are not, because an hours-stale
total is worse than an honest empty state (notes §1.5).

UI honesty: a queued write reads "Saved — will send when you're back online", and a pill in the header
shows the pending count. A queued write never gets a plain success toast.

---

## 8. Auth and the PIN — the security posture, stated plainly

The spec says the PIN "unlocks a session, it is not the security boundary". Implemented literally:

- Email + password produces a Supabase session in a cookie set by `@supabase/ssr`. No sign-up route
  exists; the three users are created by hand.
- Supabase Auth configured to a 30-day inactivity window.
- The PIN is a **local UI lock**: a per-device salted hash in `localStorage` (PBKDF2-SHA256, 150k
  iterations), with throttling — five wrong attempts deletes the stored PIN and forces a full
  email-and-password sign-in. Deleting rather than timing out, because a timeout is skipped by
  clearing site data, and the password is the thing that actually establishes who somebody is.
- "Unlocked" lives in `sessionStorage`, so it survives switching apps and backgrounding but not
  closing the app. That is spec §7.1's intent: the PIN on every open, the password every thirty days.

**[decision] No PIN outside a secure context.** `crypto.subtle` exists only on https or localhost, so
over a plain `http://192.168.x.x` address it is undefined. Rather than fall back to a weaker hash —
which would still look and feel like a lock, and so be trusted like one — the app skips the PIN
entirely there and says so in a banner. The session is still real and RLS is still doing the actual
protecting. The practical consequence is that **testing the PIN on a phone requires the deployed
https URL**, not the local network address.

**The uncomfortable part, up front:** under this design somebody holding an unlocked phone can reach the
data without knowing the PIN, because the session cookie is present either way. Making the PIN real
means encrypting the refresh token with a key derived from it — which means middleware can no longer
read the session, so route guarding moves client-side, and a forgotten PIN forces a full re-login. That
is a genuine trade and the spec has already chosen the fast side of it deliberately. I am building what
the spec says. Noting it so the choice stays conscious, and marking it the first thing to revisit if
these phones ever leave the shops.

---

## 8.1 Roles, the owner's view, and notifications

Added after Phase 1 started, at the client's request. Recorded here because it touches the schema.

**`role` is not a permission.** Mani and Rabindra are `owner`; Milan and Sujan are `member`. All four
have identical access to every invoice — spec §2 and §3.5 are unchanged, and no RLS policy anywhere
mentions `role`. It exists so the app knows whose screen gets the extra section. Migration 005 carries
a comment saying that if `role` ever starts deciding what somebody can *do*, it has to move into a
policy, because the UI is never the enforcement layer (notes §2).

Mani and Rabindra get the **same** treatment deliberately, so the owner's view can be tuned against a
live account without touching Mani's.

**The owner's treatment** is a light accent and an activity overview on Home — what the team did
today, who logged what. Designed in Phase 4, alongside the screen it lives on. Explicitly not a second
layout: spec §9's direction is specific, and two visual designs is two things to keep in step forever.

**The bell is for everyone.** A header bell showing unread activity, read from `activity_log`, which
already exists and is already written by the audit trigger. Every person gets it; it is not an owner
feature.

**Notification preference** is `profiles.notify_on_new_invoice`, on by default for Mani and Rabindra.
Each person can change their own, and *only* their own, and only that one field. Two mechanisms in
migration 007 do that, because they do different jobs:

- the RLS policy `self_update` decides **which row** you may touch — yours
- the column grant `grant update (notify_on_new_invoice)` decides **which field** you may set

RLS cannot restrict columns. Without the grant, a person could rename themselves, change their accent,
or promote themselves to owner.

### Push — [decision] Phase 7, with the in-app feed as the real channel

Client chose phone push over in-app-only and over email. Building it, in Phase 7, because it genuinely
cannot come earlier: a push subscription requires a service worker, and the service worker is what
Phase 7 installs.

The shape:

```
invoice inserted
   -> Supabase database webhook
   -> Edge Function (Deno)
   -> reads push_targets  (active people who asked to be told, minus the author)
   -> web-push, signed with the VAPID private key
   -> the phone's push service
   -> service worker shows "Sujan added an invoice — $5,220, Bidfood"
```

`push_subscriptions` and the `push_targets` view ship in migration 006 now, empty. Not speculation:
the schema is being pasted in by hand, and one extra round trip costs more than an unused table does.
The VAPID private key lives as an Edge Function secret and never enters the app bundle — same rule as
the service-role key.

**Two uncomfortable parts, stated now rather than in Phase 7.**

1. **On an iPhone, push only works if Mani adds the app to his Home Screen first.** Not a setting, not
   something I can work around — Apple requires it. If he leaves it as a browser tab, the notification
   silently does not arrive. Android has no such restriction.
2. **Push is never guaranteed delivery.** The phone can be off, the endpoint can expire, the OS can
   drop it. Nobody's push implementation is reliable, and one that people come to trust for money is
   worse than none.

So the in-app feed is the source of truth and push is a nudge on top of it. That is why the bell is
built in Phase 5 regardless of push: if a notification never arrives, the information is still there
the next time the app is opened, and it is still correct.

---

## 9. Constants

`lib/constants.ts` is the only place these exist. Anything appearing in both a Zod schema and a UI hint
imports the same symbol (notes §5).

```ts
export const WEEK_HORIZON_DAYS = 7;      // the "next 7 days" bucket AND the copy
export const DUE_PRESETS = [7, 14, 30];  // the pills AND the date maths
export const DEFAULT_TERMS_DAYS = 14;    // fallback when a supplier has none
export const DUPE_LOOKBACK_DAYS = 180;   // duplicate-warning window
export const SESSION_DAYS = 30;
export const PIN_LENGTH = 6;
export const PIN_MAX_ATTEMPTS = 5;
export const MIN_TOUCH_PX = 44;
export const ROW_HEIGHT_PX = 56;
```

---

## 10. Directory layout

```
app/
  layout.tsx                    fonts, tokens, providers
  login/page.tsx
  unlock/page.tsx
  (app)/
    layout.tsx                  shell + business segmented control + sheet host
    page.tsx                    Home — The Week
    pending/page.tsx
    history/page.tsx
    suppliers/page.tsx
    suppliers/[id]/page.tsx
    invoices/[id]/page.tsx
  manifest.ts
middleware.ts
lib/
  constants.ts  money.ts  date.ts  form-guard.ts
  supabase/{browser.ts, middleware.ts}
  db-types.ts                   generated
  queries/{keys.ts, invoices.ts, suppliers.ts, activity.ts}
  derive/{urgency.ts, runs.ts, sort.ts, totals.ts}
  offline/persist.ts
components/
  ui/{Sheet, Pill, Chip, Row, Money, DateLabel, Spine, Toast, Empty}
  invoice/{AddInvoiceSheet, InvoiceRow, PaymentRunRow, DuplicateWarning, ActivityStream}
db/{migrations, seed}/
test/{fixtures, unit, e2e}/
```

Roughly thirty files of application code. That is the whole app, and it is why the spec §4 "do not add"
list is right — every one of those libraries costs more than the surface it would abstract.

---

## 11. Styling

Tailwind v4, CSS-first. The §9 palette and type scale go into a single `@theme` block in
`app/globals.css` as design tokens (`--color-ink`, `--color-gold`, `--radius: 4px`, `--row-h: 56px`).
There is no `tailwind.config.js` holding a parallel copy of the same values.

Fonts via `next/font/google` (Archivo, IBM Plex Sans, IBM Plex Mono), self-hosted at build time and
exposed as `--font-display`, `--font-body`, `--font-mono`. `tabular-nums` is applied by a `.money` /
`.date` utility, not sprinkled per component.

**The due spine** gets its own component with an explicit brief: a 3px absolutely positioned rule,
segmented per urgency bucket, a tick and date label at each date change, today marked with a
`position: sticky` filled square. It is the one piece of this UI worth building twice to get right.

---

## 12. Testing — small, and aimed at the known bugs

Vitest and Testing Library for the fast layer; Playwright for the three interaction bugs unit tests
cannot reach.

| Test | Catches |
|---|---|
| `bucketByUrgency` at 09:00 and 23:00 Sydney, whole suite run under both `TZ=UTC` and `TZ=Australia/Sydney` | notes §1.2 — the invoice-week bug |
| Money round-trip table | notes §3 |
| Render every screen against a 200-invoice fixture, assert no `undefined`, `NaN` or `[object Object]` | notes §6, spec §9 quality floor |
| Create, edit the amount, save, refetch, assert it persisted | notes §1.3 |
| Concurrent inserts for the same business and day produce two distinct refs | notes §2 |
| `sumCents(filtered)` equals the rendered total, across every filter combination | notes §3 |
| Playwright: open sheet, type, background, return, value intact | notes §1.1 |
| Playwright: mark paid offline, reconnect, exactly one row changed | notes §1.5 |
| Playwright: 360px viewport with keyboard open, Save button reachable | notes §4 |

The fixture generator lives in `test/fixtures/` and also seeds a dev database, so the 200-row
performance pass and the render tests run against the same data.

---

## 13. Environments

| | |
|---|---|
| Local | `npm run dev` against the live Supabase project. One project, not two — three users on a free tier does not justify a staging database. |
| Preview | Vercel preview deploy per branch, same Supabase project. |
| Production | Vercel production. |
| Secrets | `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` only. **The service-role key is never added to Vercel.** If it is not there it cannot be used, and §1's guarantee holds by construction. |

Because there is one database, migrations are additive and reviewed before they run. Anything
destructive needs explicit sign-off.

---

## 14. Workflow

### How the phases run

Phases are spec §10, unchanged. For each one:

1. I build it.
2. I stop.
3. I report: **what changed, what needs deploying, what you should check on your phone.** Plain
   language, cause not jargon, uncomfortable part first (notes §7).
4. You test on a real phone and tell me what is off.
5. I fix, then we move on. No running ahead.

### What I need from you, and when

| Needed by | What | Why |
|---|---|---|
| Before Phase 1 | A Supabase project (free tier), and its URL, anon key and database password | I cannot create an account in your name. Once it exists I apply every migration myself. |
| Before Phase 1 finishes | The three email addresses for Mani, Milan and Sujan | Auth users must exist before `profiles` can be seeded — `profiles.id` references `auth.users(id)`. |
| Before Phase 2 | A Vercel account connected to the repo | So you can test on a phone from Phase 2 onward, not only at the end. |
| Before Phase 3 | The supplier list, with `default_terms_days` where known | Spec §12 — that field is what makes the add-invoice flow fast. Names alone will do to start; terms can be filled in per supplier later. |

### Phase gates — what "done" means

| Phase | Done when |
|---|---|
| 1 Foundation | Schema applied; RLS proven by script to block an anonymous client; two concurrent inserts produce distinct refs; token file and type scale render on a test page. **You review the schema and tokens before I continue.** |
| 2 Auth | Login works on your phone; PIN unlock works; session survives; every route redirects when signed out. |
| 3 Add invoice | Cold open to saved invoice under 15s on a real phone, timed not estimated. Sheet survives backgrounding. Duplicate warning fires. Offline save queues honestly. This phase gets re-polished until the timing is real. |
| 4 Dashboard + pending | Greeting reads correctly at four times of day. Dashboard lists Overall plus the four businesses, each with its own total. Selecting one scopes every screen below it. The `+` is reachable from all of them. Spine renders. Filtered total provably equals the filtered list. 200 rows scroll smoothly on the phone. See §16. |
| 5 Payment + detail | A whole run ticks in one transaction; killing the connection mid-tick leaves all-or-nothing. Un-tick and void log correctly. Detail stream reads chronologically. Header bell shows unread activity for everyone. |
| 6 Supplier, history, admin | Search finds an invoice by any of the four identifiers; "everything Sujan ticked off in July" in two taps. |
| 7 PWA + hardening | Installs to a home screen; loads offline; error boundaries; empty states; mobile QA on the actual phones. Push notification on invoice insert, tested end to end on Mani's actual phone with the app installed — see §8.1 for why that last condition is not optional. |
| 8 Deli Delights sales | Customers, sales invoices and receipts as their own ledger — see §17. Starts only after v1 has been in daily use for a month, so it is built from how the shops actually work rather than from a guess. |

### Version control

Git initialised at Phase 1, one branch per phase (`phase-1-foundation` and so on), merged after your
sign-off. Every phase is revertible as a unit, and the Vercel preview URL for a branch is what you test
before it becomes production.

---

## 15. Decisions taken, and what is still open

### Resolved

**Supabase project — client-provided.** He has an account and will create the project and hand over the
credentials. What is needed: project URL, `anon` key, and either the database password or the project
ref so migrations can be applied with the CLI. The service-role key is deliberately *not* requested; per
§1 and §13 it must never enter this codebase or Vercel.

**CSV export stays in v2.** Spec §3.4 leaves this movable and it was put to me to decide.

An earlier draft of this document said the export would be "awkward to bolt on later". That was wrong
and is corrected here. CSV export is read-only: no table, no column, no new state. Every property that
makes the other §11 items expensive to defer — partial payments needing a state machine, photos needing
Storage and an upload path, recurring invoices needing a scheduler — is absent. It costs roughly the
same in six months as it does in Phase 6.

With the cost of waiting near zero, the deciding factor is that nobody has asked for it. Building
unrequested features is the thing spec §11 exists to prevent.

The trigger to reconsider: if the bookkeeper requests the same data twice, it gets built, and at that
point it is one file. Phase 6 will keep History's filter parameters as a plain reusable object so the
export can run the same query without a page limit — that costs nothing now and is the only
accommodation made for it.

**Raised again during Phase 3, as "an excel style file".** Still not confirmed, and the client's own
reason for holding is the right one: nobody knows what format the bookkeeper actually wants. Worth
knowing when it is decided, because the two answers differ a lot in cost:

| | |
|---|---|
| **CSV** | Opens in Excel, opens in anything. No dependency, roughly an hour, and every accounting package on earth imports it. |
| **True `.xlsx`** | Needed only if the bookkeeper wants formatting, formulas, or multiple tabs. Requires a spreadsheet library — the first dependency added purely for output — and about half a day. |

Default to CSV unless the bookkeeper specifically asks for a formatted workbook. The question to put to
them is not "CSV or Excel" — they will say Excel, because that is the program they open — but **"what do
you do with the file when you get it?"** If the answer is "import it", CSV wins on every count.

**Status:** the client is asking the bookkeeper that question. Nothing is built until the answer comes
back, and the answer decides which of the two rows above applies.

---

## 18. Supplier payment terms — deferred to Phase 6, deliberately

`suppliers.default_terms_days` exists and works: choosing a supplier fills in the due date from their
own terms, counted from the invoice date (§4 of `lib/invoice-form.ts` carries the reasoning).

What does not exist yet is any screen to *set* it. That is the supplier admin screen in Phase 6.

The client was offered a terms field on the inline "add a new supplier" flow to close the gap early,
and chose to keep the phase order instead. So until Phase 6, suppliers created from the sheet carry no
terms and fall back to `DEFAULT_TERMS_DAYS`. Due dates remain editable on every invoice, so nothing is
blocked — it is a convenience that arrives later, and Phase 6 should include a pass over the suppliers
created in the meantime.

### Still open

1. **Spec §3 assumptions 1, 2, 3 and 5** — separate totals per business, suppliers shared across
   businesses, GST-inclusive amounts with no split, no approval workflow. [proceeding on: all yes, as
   written in the spec]
2. **Invoice photos.** Spec §11 ranks this highest after v1 and notes it may want pulling into Phase 3.
   [proceeding on: out of v1, and nothing at all is being put in place for it]

   An earlier draft of this document said the nullable column and the Storage bucket would go in at
   Phase 1 "so adding it later is a UI job rather than a migration". Reversed on reflection, for two
   reasons. Notes §8 says plainly *do not build any §11 item early, including invoice photos, however
   tempting* — and a column added in anticipation is a small version of building it early. More to the
   point, the justification did not survive scrutiny: adding the column later is
   `alter table invoices add column photo_path text`, which is one line and carries no risk. Nothing
   is bought by doing it now.

---

## 16. Information architecture — revised after the Phase 1 review

The spec put the business filter on a segmented control pinned to the bottom of Home
(`All · GMH · GMP · MJR · DDL`). On a phone that reads as a filter on one list, and the client asked
for a clearer division after seeing it. Revised structure:

```
Dashboard
  greeting — "Good morning, Sujan"
  overall total owing

  ┌ Overall ─────────────────────────┐    every business combined
  ├ GroceryMate Hurstville ──────────┤
  ├ GroceryMate Parramatta ──────────┤    each with its own outstanding
  ├ Majheri Restaurant ──────────────┤    total and count
  └ Deli Delights ───────────────────┘
```

Selecting **Overall** or any one business opens the same five capabilities, scoped to that selection:

| | |
|---|---|
| Pending payments | Sortable by earliest due, biggest amount, supplier name. Running total of whatever is filtered. |
| Mark paid | Toggle, then the payer's chip is permanent on that invoice. |
| Add invoice | Number, amount, due date, invoice date defaulting to today and editable, supplier quick-select. |
| History | Everything paid or voided, searchable, filterable by who did it. |
| Suppliers | Add and edit. |

**[decision] The `+` button stays global.** It sits on the dashboard and on every screen below it, and
it pre-selects the last business used. Adding a level of navigation is the right call for reading the
ledger, but the spec's first metric is fifteen seconds from cold open to a saved invoice, and making
someone walk into a business first would spend three of those seconds on navigation. Reading is
hierarchical; writing is not.

**[decision] Nothing about this changes the data layer.** Architecture §2 already loads every unpaid
invoice into one client-side array, and per-business views are a filter over it — the same filter that
already backs the segmented control, applied at a different level of the navigation. The totals on the
dashboard and the totals inside each business are computed from that one array, so they cannot
disagree with each other.

### The greeting

Time-of-day, in Sydney, from the same `lib/date.ts` that everything else uses — never the phone's
clock, which may be set to anything.

| Sydney time | Greeting |
|---|---|
| 05:00–11:59 | Good morning, Sujan |
| 12:00–16:59 | Afternoon, Sujan |
| 17:00–21:59 | Evening, Sujan |
| 22:00–04:59 | Late night, Sujan? |

Spec §8 still applies: sentence case, no exclamation marks, no emoji. The greeting is warmth, not
noise, and it is the one place in the app allowed any.

### Notification rules, consolidated

The rule generalises to: **tell the people who asked to be told, never about their own actions.**

| Event | Who hears about it |
|---|---|
| Invoice added | Anyone with notifications on, except whoever added it |
| Invoice marked paid | **Mani only** — revised, see §26 |
| Everything else | Nobody — it is in the history, which is always readable |

**The second row was revised by the client and is no longer symmetric with the
first.** An invoice arriving is news to whoever is going to pay it; an invoice
being paid is news to whoever is watching the money, which is one person. The
rest of the team can see every payment in History and in the bell — this
governs only what a phone interrupts somebody for.

That breaks the generalisation this section was built on, so §26 sets out how
it is to be implemented in Phase 7 **without a branch that names Mani** — the
thing this paragraph originally existed to prevent.

History is unconditional and independent of notifications: every payment always records when and by
whom, and the audit trigger writes it regardless of anybody's settings.

---

## 17. Deli Delights — [decision] a second ledger, not a flag

Deli Delights is a packaged food company. It buys from suppliers like the other three, **and it sells
to customers**, and it needs to know who owes it money and whether they have paid.

That is a different ledger, not a variation on this one. The honest picture:

|  | Supplier invoices (built) | Customer invoices (new) |
|---|---|---|
| Direction | Money out | Money in |
| Counterparty | Supplier | Customer |
| Overdue means | **Our** problem — pay it | **Their** problem — chase it |
| The action | Mark paid | Record a receipt, send a reminder |
| The headline question | What leaves the account this week | Who owes us, and for how long |

### Why not one table with a direction flag

It would look tidier and it would be wrong. Every list, every total and the whole due spine would need
to know which direction it was showing, and the one screen the spec cares most about — "what leaves
the account this week" — would have to filter money *in* back out of itself on every render. The
design's clarity comes from that screen answering exactly one question. A direction flag puts a
condition inside every answer.

### What it will be instead

Its own tables — `customers`, `sales_invoices`, `receipts` — reusing the parts that are genuinely
generic: the reference generator, the audit trigger, the money and date modules, the payment-run
grouping. Roughly a phase of work.

### Where it goes: Phase 8 — **superseded, see §28.3**

> The two tables below were built early, at the client's request (§25.2). The third,
> `receipts`, he has since ruled out: "this app wont be storing payment methods or
> details. its more of a super advanced shared notebook." **Phase 8 no longer exists.**
> What survives here, and the reason this section stays, is the argument against one
> table with a direction flag — which is unaffected and still binding.

After v1 is in daily use, and here is the reason rather than the excuse. Chasing a customer is a
different job from paying a supplier — it involves reminders, part payments and a relationship — and
none of us knows yet which of those Deli Delights actually needs. Building it before the payables app
has been used for a month means guessing at all of it, and spec §11's discipline exists precisely for
this case.

Nothing about the current schema blocks it, and nothing needs adding now.


---

## 19. Where the build has got to

Written for whoever picks this up next, including a later session of me.
**Kept current — §§20–27 are the changes made after the original six phases,
§29 is Phase 7, and this section describes the app as it stands today. §28 is the
one section describing what has been decided and not yet built.**

Phases 1–7 built. 1–6 were signed off; §§20–27 are the client-driven
revisions made between 6 and 7, and §29 is Phase 7 itself — the offline write
queue, the service worker, error boundaries, the 200-row pass and push.

**One part of Phase 7 is built and not yet on: push sends nothing until the
four steps in `db/push/README.md` are done, and those need credentials that
deliberately do not exist on this side.** §29.6.

§28 is the other section describing work decided and not built: the clean slate
before go-live, and taking Rabindra out of the profile list.

Live at **https://shg-invoices.vercel.app** · repo `SaHG2026/SHG-invoices`,
branch `tidy-up-before-phase-7` · 532 tests, run under `TZ=UTC`,
`Australia/Sydney` and `America/Los_Angeles` before every commit.

### What exists

| Route | What it is |
|---|---|
| `/login` | Email and password. No sign-up route exists. |
| `/` | Dashboard (§21): greeting, Overdue and Next 7 days, Coming up, per-business totals, a full-width `+`. |
| `/b/[scope]` | The Week for `all` or a business code — overdue, today, next 7 days, later, with payment runs. |
| `/b/[scope]/pending` | Three sorts (§24.6), search, overdue-only, supplier filter, sticky filtered total. |
| `/b/[scope]/history` | Paid and voided, searchable, filtered by payer. |
| `/invoices/[id]` | One invoice: facts, actions, and the merged notes/activity stream. |
| `/suppliers`, `/suppliers/[id]` | List, add, edit, deactivate; terms, contact, six-month spend. |
| `/customers`, `/customers/[id]` | §22, §25.2. Add and edit; what each owes; record an invoice sent and mark it received. |
| `/settings` | §20.4. Who you are, the notification switch, the device PIN, sign out. |
| `/specimen` | Design tokens, rendered from the test fixture. Delete when it stops being useful. |

### The shape of it now, in one paragraph

A side menu (§20.1) reaches everything from everywhere. Two ledgers that never
touch: `invoices` is money out and every owed figure derives from it;
`sales_invoices` is money in and every receivable figure derives from that. The
`+` is global, pre-selects the business you are standing in, and asks which
direction only inside Deli Delights — the one business with both. Invoices
ticked off stay on screen, struck through, until the app is closed (§23).

### Migrations applied by hand, in order

`001`–`007` at the start, then `CATCH_UP_001`–`003` (accents), `CATCH_UP_004`
(customers), `CATCH_UP_005` (sales invoices). `db/migrations/` is the source of
truth for a fresh install; the `CATCH_UP` files are what was actually sent to
the client to paste in.

### Deploying

Vercel CLI, not GitHub — the client's Vercel account has no GitHub connection, and
auto-deploy was never set up. Every release is three commands:

```
npx vercel deploy --prod --yes
npx vercel alias set <the-new-deployment>.vercel.app shg-invoices.vercel.app
```

The alias step matters: without it the stable URL still points at the previous build.

### Database

Applied by hand through the Supabase SQL editor — the client runs the file, there is no
migration CLI in the loop. `db/migrations/` is the source of truth; `db/CATCH_UP_*.sql` are
the deltas already applied on top. **`CATCH_UP_003.sql` may still be outstanding** (accents
as slot names); the app tolerates either.

### Still owed to the client

**Gates on handing it over — §28, decided and not yet built:**

1. **The clean slate.** Every supplier, invoice, note, activity row, customer and sales
   invoice in the database is test data and comes out before day one, counters included.
   One SQL file, run once, outside the app. §28.1.
2. **Rabindra stops being one of the names** — visible to nobody, notified about nothing,
   access unchanged. **Not `active = false`**, which is the membership test itself. §28.2.
3. **Deli Delights' logo**, promised before launch. Rabindra's photograph is no longer
   wanted. §22 has where they go and why the filename must be lower-case.

**After that:**

4. **Supplier payment terms.** Suppliers created from the add-invoice sheet have none. The
   suppliers list counts them and the supplier page sets them. The clean slate takes
   today's with it; the gap remains for the real ones.
5. **Export by date range** — named by the client at handover, and the next piece of
   work after a month of use. "From this date to this date export in excel or csv etc."
   Still waiting on the question §17 asked: what happens to the file when it arrives.
   That answer decides between an hour of CSV and half a day of `.xlsx`. §33.2.
6. **Whether a customer can pay half an invoice.** The one question §28.3 leaves open.
   `sales_invoices.status` is binary today, and on a part payment both of its values are
   untrue.

**Closed:** Deli Delights receivables as §17 scoped it. The client's ruling is that
`customers` and `sales_invoices` are the whole job — §28.3.

**Database state:** `node db/verify_catchups.mjs` confirmed on 31 Aug 2026 that every table,
view and function the CATCH_UP files add is present. `db/verify_catchups.sql` is the
read-only companion for what the anon key cannot see — indexes, grants, row contents.

### Bugs already found and fixed, so they are not re-introduced

Each of these shipped, was caught on a real phone, and now has a test standing over it.

| What went wrong | Why | Where the test is |
|---|---|---|
| Dates rendered `Fri, 11 Sept` and differed between devices | Locale data is not stable across runtimes | `date.test.ts` |
| References would collide at 100/business/day | `lpad` truncates rather than only padding | `db/verify_refs.sql`, 150 rows |
| PIN confirmation silently skipped | Completion fired from a state effect, replayed by a parent re-render | `pinpad.test.tsx` |
| Gate stuck on the setup screen | Three booleans describing eight states when four exist | `unlock-gate.test.tsx` |
| App stopped locking after a sign-out | Two halves of one fact owned by two files | `pin-storage.test.ts` |
| Terms counted from today, not the invoice date | Late-arriving invoices silently got extra days to pay | `invoice-form.test.ts` |
| Opening an invoice inside a run collapsed the run | Run and child shared one expansion value | `mark-paid.test.tsx` |
| Ticking appeared to do nothing, so people tapped again | Only the unpaid list was invalidated; the row vanished without saying what happened | `invoice-row.test.tsx` |
| Ticking a run appeared to erase two invoices | A run and its children shared one expansion value | `mark-paid.test.tsx`, §23.1 |
| An offline save said nothing at all, and a refused one said "Saved" | A paused mutation never settles, so the catch written for offline could not be reached — and two branches were describing three outcomes | `offline-queue.test.ts`, §29.2 |

The pattern worth carrying forward: **six of the ten were shape problems, not logic
problems.** The fix each time was to make the broken state unrepresentable rather than to
correct the branch that produced it.

The tenth is the one found without a phone. It was shipped, it had a test over it, and the
test asserted the wrong branch — so it passed for four phases. What found it was writing
down what the three outcomes actually were.

### How the client works

Notes §7 is accurate and worth re-reading. He tests on a real phone, describes symptoms
precisely, and is right about his own product more often than the spec is. Twice now he has
asked for something the spec forbade and been correct both times — the row tick, and
removing reference numbers from the UI. Lead with the uncomfortable part, say what changed
and what to check, and stop at the end of each phase.

---

## 20. Navigation, branding and the customer list — after the Phase 6 review

Added at the client's request, between Phase 6 and Phase 7. Three changes, one
of which touches the schema.

### 20.1 Navigation moves into a side menu

§16 put the business choice in the URL and gave each screen a card of links to
the rest of what a scope offers. That held while there were three destinations.
There are now six, the card had been copy-pasted onto a second screen, and
Customers made a seventh — which is the point at which "every screen carries
its own list of links" starts producing destinations reachable from one screen
and not another.

So there is one drawer, in `AppChrome`, on every screen:

```
  Mani  ·  Sagarmatha Holdings
  ─────────────────────────────
  Invoices                    ▾      -> /            (the dashboard)
      GroceryMate Hurstville  12     -> /b/gmh
      GroceryMate Parramatta   9     -> /b/gmp
      Majheri Restaurant       7     -> /b/mjr
      Deli Delights            3     -> /b/ddl
  Suppliers                          -> /suppliers
  Customers                          -> /customers
  Paid history                       -> /b/all/history
  Settings                           -> /settings
```

**[decision] Invoices points at the dashboard, not at `/b/all`.** The dashboard
is what the app opens to and where the greeting and the group total live; the
businesses beneath it are the shortcut past it. Pointing the row at `/b/all`
would have made the dashboard reachable only by the back arrow.

**[decision] The counts are unpaid invoices, derived from the one client-side
array** (§2), not a second query. A menu that said 12 beside a business whose
page then showed 9 is notes §3's trust-destroying disagreement arriving from a
new direction. Same array, same answer, by construction.

**[decision] The menu is mounted only while it is open.** Partly so the queries
behind the counts do not run on screens nobody has opened it from — but mainly
because a permanently-mounted drawer puts every business name and every
destination into the DOM of every screen, where a screen reader finds them
mixed in with the page's own content and cannot tell which is which.

`lib/nav.ts` holds the sections and the "which row am I on" rule as pure
functions, tested at every URL the app has. Two things there are load-bearing
and were both got wrong first:

- **History is matched before Invoices.** Paid history lives at
  `/b/all/history`, *inside* the invoice URL space. Checked in menu order,
  every history page lights up Invoices instead. Nobody reports that; they just
  stop trusting the highlight.
- **Only the most specific row is `aria-current="page"`.** Inside a business,
  both Invoices and that business stay visually highlighted — the child is
  where you are, the parent is what it belongs to — but two elements announcing
  themselves as "the page" is a contradiction read out loud. Caught by a test
  that counted them, not by looking.

The per-scope card survives on The Week with two entries — pending and history
for *that* business. Those are scoped; Suppliers was not, and moved.

### 20.2 Branding

The header is the app tile plus **SHG Invoices**, replacing the bare `SHG`
wordmark. `metadata.title` follows it.

**Business logos have a slot, and the slot is filled by a lettered tile until
artwork arrives.** `components/ui/BusinessMark.tsx` renders the code — GMH, GMP,
MJR, DDL — in the neutral token pair, deliberately *not* one of the four person
accents, which mean "who did this" and are the only colour-as-identity device
the app has (spec §9).

**[decision] `lib/logos.ts` is a hand-edited table, not a runtime probe.** The
tempting version points an `<img>` at `/logos/gmh.png` and falls back on a 404.
That costs a failed request per business every time the menu opens and shows a
visible flash of the broken state on a slow connection. Same reasoning as the
month-name table in §3: an explicit list is duller and right on every device.
Adding a logo is one file and one line.

**Uncomfortable part:** `manifest.short_name` went from `SHG Pay` to `SHG`, and
`appleWebApp.title` with it, because both platforms truncate the home-screen
label around eleven characters and `SHG Invoices` would have been eaten by an
ellipsis. **An already-installed app keeps whatever label it was added with** —
only a reinstall picks up the new one. Nothing else about the install changes.

### 20.3 Customers — the first table of the §17 ledger

§17 said Deli Delights' customer side is a second ledger and put it in Phase 8,
after a month of daily use, so it is built from how the shops actually work
rather than from a guess. That reasoning is unchanged and is why what landed
here is the customer *record* and nothing else: `db/migrations/008_customers.sql`,
a list, a detail page with contact fields and a deactivate switch.

The client's condition was one sentence: **the number must not affect owed or
pending.** It cannot, and not because anybody remembered to filter it out —
**a customer row has no amount on it.** There is no column a total could pick
up, no foreign key from anything in the payables ledger, and every owed and
pending figure in the app is still derived solely from `useUnpaidInvoices`.
That is the same move as §2 and §6: make the broken state unrepresentable
rather than correct the branch that would produce it. `customers.test.tsx`
asserts it from four directions, including "no dollar sign renders anywhere on
either customer screen", so a later balance column added to make the page look
more useful fails a test instead of quietly moving the headline number.

`sales_invoices` and `receipts` remain Phase 8, with their own totals. Nothing
here presumes their shape.

**Needs running before this ships:** `db/migrations/008_customers.sql`, in the
Supabase SQL editor. Until it is, `/customers` shows an error rather than an
empty list — the table genuinely is not there.

### 20.4 Settings

The menu needed somewhere to send Settings, and the three things hiding behind
a tap on the header chip — who you are, the design tokens, signing out — were
already a settings screen wearing a dropdown. The chip is now a link to it.

It also closes a gap that has been open since §8.1: `notify_on_new_invoice` is
the one field a person may change about themselves, enforced by an RLS policy
(which row) plus a column grant (which field), and **no screen had ever offered
them the switch.** Now one does.

Changing the PIN calls `clearAllLockState()` and then a full navigation, never
`clearPin()` alone. The PIN and the "already unlocked" flag are two halves of
one fact; the last time they had two owners, signing back in walked straight
past the lock (§19's bug table, `pin-storage.test.ts`).

### 20.5 What is next, and what this deliberately left alone

The home screen in the client's mockup — OVERDUE / NEXT 7 DAYS stat cards, a
"Coming up" list with due pills, a full-width **+ New invoice** — is **not in
this change**, by agreement. Two reasons, in order of weight:

1. The drawer changes the header on every screen; the home screen redesign
   changes the one screen Mani reads every morning. Landing both together means
   that when something is off on his phone, nobody knows which one did it.
2. The drawer is what *makes* the redesign possible. Once navigation lives in
   the menu, the dashboard is free to stop being a list of links and become the
   view in the mockup. Doing it the other way round builds the dashboard twice.

Tests: 394, up from 333, still under all three timezones.

---

## 21. The home screen — the second half of the §20 tidy-up

The dashboard rebuilt to the client's own mockup. §20.5 said why it was held
back a step; this is it landing.

### 21.1 Two figures, not one

It used to lead with everything outstanding, then a list of links to each
business. That answers "how much is there", which is not the question spec §1
puts second: **Mani opens this on Monday morning and needs to know, within
three seconds, what is already late and what leaves the account this week.**
One combined total answers neither — it adds money that is a problem now to
money that is not yet anybody's problem.

So the headline is `Overdue` and `Next 7 days`, side by side, and the list
beneath is the actual invoices in due order rather than a menu.

**[decision] `next7` includes today.** "Next 7 days" is read as a window
starting now, and an invoice due this morning belongs in what leaves the
account this week. The Week screen still separates today from the rest,
because there the sections are the point.

**[decision] Only Overdue is coloured.** Two red cards side by side are two
alarms, and an alarm that is always on stops being read.

`summariseUrgency` is a pure function over the one unpaid array, built from
`bucketByUrgency`, so the two cards cannot overlap, cannot lose an invoice
between them, and cannot disagree with the list underneath. All three are
asserted — the useful one being that the two figures plus Later equal the
whole, since the cards sit next to each other and will be added up by eye.

### 21.2 Coming up

Payment runs as cards, capped at six, then a link saying how many there are in
total. A summary that quietly stops is worse than one that hands over.

Sorting happens **before** grouping. `groupIntoRuns` always returns runs in due
order, which is right for the default and wrong for the other three sorts —
sorting the invoices and ranking the groups by where their first invoice lands
means "biggest amount" genuinely puts the biggest run first.

Tapping goes where the invoice can be acted on: the record for a single
invoice, that business's week for a run, where the whole run ticks in one
transaction. **Deliberately no tick on the card.** The dashboard is what you
read to decide what to do, and a one-tap irreversible-feeling control on a
summary you are scrolling past is how the wrong thing gets ticked.

### 21.3 The `+` becomes a bar

`AppChrome` grew `add: 'floating' | 'bar'`. The dashboard is the only screen
using `bar`; everything else keeps the 56px corner button, and no screen ever
has both — two controls doing one job, one overlapping the other, is worse than
either.

**It is pinned, not placed at the end of the page.** In the mockup it follows a
list of four; on a real Monday it follows a list of thirty, and a button that
has scrolled out of sight is a button that is not reachable. That is three
seconds off the fifteen-second target, on the screen the app opens to.

### 21.4 Two things kept that the mockup does not show

Both are signed-off behaviour, and dropping something during a visual pass is
not a visual decision. Either can go in one line if the client says so.

- **The greeting**, made small, and now the page's `h1`. §16 calls it "the one
  place in the app allowed any [warmth]" and the Phase 4 gate names it. It is
  the heading rather than a `<p>` above one because a screen whose first
  heading is "Coming up" has no `h1` at all, which is a real problem for anyone
  moving through the page by headings.
- **The business rows, with their totals.** The side menu lists the businesses
  with counts, and "what does Hurstville owe" is a different question from "how
  many are outstanding there". The Phase 4 gate asks for a total per business.

### 21.5 A bug found by measuring, not by looking

The headline figure is set in the 28px display size, in a half-width card. On a
360px phone — the width notes §4 says to test at — that card leaves about 132px
for the number, which holds nine or ten characters. `$18,347.88` is ten.

**The first six-figure overdue total would have run off the edge of the card.**
Measured rather than guessed: `$118,347.88` came out at 153px inside a 147px
box at 390px, and 360px is narrower still. The fixture's own group total is
already $220,420, so this was not a distant hypothetical.

The figure now sizes itself as `min(var(--text-h1), Ncqw)`, where N comes from
the character count of the longer of the two totals — so both cards stay the
same size as each other, the ordinary case is unchanged at 28px, and nothing
overflows at any width. Verified at 360px up to `$12,345,678.90`.

**The general point, which is §19's pattern again:** this was invisible in a
screenshot and obvious in a `getBoundingClientRect`. `HANDOFF.md` §5 says not to
debug from browser-pane screenshots and to measure instead. That advice found a
real bug the first time it was followed.

### 21.6 Looking at the app without a session

`test/preview-dashboard.test.tsx` renders the real components against the real
fixture and writes the markup out with the built stylesheet, so the screens can
be looked at without signing in. Skipped unless `PREVIEW_OUT` is set:

```
npm run build
cp .next/static/css/*.css /tmp/shg/app.css
cp -r public/icons /tmp/shg/
PREVIEW_OUT=/tmp/shg/dashboard.html PREVIEW_CSS=/tmp/shg/app.css \
  npx vitest run test/preview-dashboard.test.tsx
python -m http.server 8899 --directory /tmp/shg
```

It writes two pages — the dashboard and the menu open — because the drawer and
the New invoice bar are `position: fixed` and cover anything sharing a page
with them. Fonts fall back to system faces; nothing else differs.

Tests: 413, up from 395, under all three timezones.


---

## 22. Faces and marks

§20.2 built the slot for a business logo and filled it with letters, and said
adding artwork would be one line. It was. This is that line, plus the same
treatment for people.

### 22.1 One registry, hand-edited

`lib/logos.ts` holds both tables. Neither probes for a file.

The tempting version points an `<img>` at a conventional path and falls back
when it 404s. That works, and it costs a failed request per person per screen
plus a visible flash of the broken state on a slow connection — which a phone
on shop wifi is exactly where you would see. Same reasoning as the month-name
table in §3: an explicit list is duller and right on every device.

**A file that is not registered simply does not appear.** Milan's photograph
has not been supplied, so his line is commented out and his chip shows initials
— the behaviour every chip had before this. Nothing degrades to a broken image,
because nothing points at a file that is not there. `person-chip.test.tsx`
asserts that every registered path resolves to a real file, since a typo there
would put a broken-image icon in the header of every screen and no other test
would notice.

**[decision] People are keyed by `display_name`, not by a `profiles.avatar_url`
column.** Four photographs that change roughly never do not justify a migration,
a round trip through the Supabase editor, and a nullable column on the table
every attribution chip reads. §15's reasoning against a speculative photo column
applies to a real one too when a static file does the job. The key is the name
rather than the id because a UUID in a hand-edited table is unreadable.

### 22.2 What the chips do now

`PersonChip` renders the photograph where there is one and initials where there
is not. Spec §9's device is unchanged — still the same 24px square in the same
place — and the person accent stays as the image's background colour, so a
photo that has not loaded yet still shows the colour people already associate
with that person rather than an empty hole.

**`alt` is the person's name, not empty.** The initials it replaces were real
text and were announced; on an invoice row the chip is the only thing saying
who logged it. Where the name is already announced — the header link carries
its own `aria-label` — that label wins and the alt is never reached.

The photograph appears everywhere the chip does, not only on the profile icon:
the header, the menu, the unlock screen, and every attribution chip in every
list. One person looking different in different places is the drift §16 and
`InvoiceRow` both exist to prevent.

### 22.3 Which mark goes where

| | |
|---|---|
| GMH, GMP | `grocery-mate.png` — one brand, two shops; the name beside it is what tells them apart |
| MJR | `majheri.png`, cropped to the badge |
| DDL | the letters **DD** |

**[decision] Deli Delights gets letters, not a borrowed mark.** Three identical
green circles out of four would make the menu less readable, not more, and the
client's stated goal was that these be recognisable. When Deli Delights has its
own artwork it is one line.

**[decision] Marks are cropped to the artwork and not padded to square.**
`BusinessMark` already uses `object-contain`, so CSS letterboxes a wide mark in
the square slot. Baking the padding into the file would only make it bigger and
fix the aspect ratio in the wrong place. Majheri is 96×44 as a result; the
"NEPALESE DELICACY" line under the badge was cropped off because it is
illegible at 28px and only makes the badge itself smaller.

Everything is 96px on the long edge — three times the 28px it renders at, which
covers a 3x phone screen — and every file is under 13KB.

Tests: 427, up from 413, under all three timezones.


---

## 23. The tick that erased two invoices, and a motion pass

### 23.1 The bug — a ninth for §19's table

**Reported as:** "if there is two pending ones with same invoice number,
ticking one off is erasing both."

**The database was never wrong.** `mark_invoices_paid` is `where id = any(p_ids)`
and the client sends one id. Every layer between them keys on `invoice.id`.
Nothing was ever paid that should not have been.

**What actually happened.** Two invoices from one supplier sharing a due date
collapse into a payment run (spec §6). Tick one, the refetch drops it, and the
run falls to a single invoice — at which point `PaymentRunRow` stops rendering
an expanded group and returns a plain `InvoiceRow` instead. The remaining
invoice is re-drawn somewhere else in the list under a different shape. So both
child rows leave the screen at once, one of them for no reason the person can
see.

**Which makes it the sixth of nine that was a shape problem, not a logic one.**
The row was not wrong about the data; it was wrong about what had happened. And
the fix is not a correction to a branch — it is removing the moment where a
list re-draws itself out from under the person who just tapped it.

### 23.2 The fix, which the client had already asked for

> "once paid, its eloping immediately, keep the strikethrough until the session
> is over. and have an undo toggle too."

`lib/recently-paid.ts` holds the invoices ticked off this session, in memory,
and `useUnpaidInvoices` folds them back into what the server returns. The run
stays a run of two with one struck through. Nothing moves that you did not move.

**In memory, not localStorage.** "Until the session is over" is the ask, and a
struck-through row surviving a reload would be a paid invoice sitting in a list
of unpaid ones with no way to explain itself. Sign-out clears it, alongside the
device lock — the next person should not see what the last one paid.

**Remembered only after the database confirms, and only the rows it actually
flipped.** `mark_invoices_paid` returns exactly what it changed, so a row never
sits there struck through on the strength of a call that failed.

**[decision] The paid rows now live in the array every total is computed from,
so every total says out loud that it excludes them.** `onlyUnpaid` in
`lib/derive/select.ts` is called by all three summaries; `groupIntoRuns` sums a
run's unpaid invoices only; the week's section totals filter. That is a real
new risk — notes §3's disagreement between a total and its list, arriving from
a new direction — so `recently-paid.test.ts` asserts the invariant directly:
adding a paid row to the array leaves every figure identical.

**Undo on the row itself**, not only in the toast, which is gone in five
seconds. Spec §6 forbids un-ticking from a list as "too easy to fat-finger",
and this does not reopen that: it appears only on a row *you* ticked, minutes
ago, on this device, and it is gone when the app closes. Undoing your own last
action is a different act from reaching into the ledger and reversing somebody
else's. Both the toast and the row call one `undo`, so they cannot drift.

**"Mark all N paid" now offers only what is still owed.** The RPC would ignore
the rest — its WHERE clause has `status = 'unpaid'` — but offering it is the
interface lying about what the button does.

### 23.3 Motion

The client asked for "the normal transition on apple devices", and the honest
diagnosis was that **the app was not animating most of this at all.** The
drawer had a 120ms fade and a 2px nudge, which is right for a list row and
wrong for a whole surface: at that distance the eye reads a jump. Route changes
had nothing. A tap toggled `active:bg-pressed` with no transition, so every
press was a step function.

One vocabulary, in `app/globals.css`:

| | |
|---|---|
| `--ease-ios` | `cubic-bezier(0.32, 0.72, 0, 1)` — leaves fast, arrives slowly, no bounce. Most of what makes those feel smooth is the deceleration, not the duration. |
| `--dur-panel` 320ms | Drawer and sheet, each travelling its own full width or height |
| `--dur-fade` 180ms | A screen arriving |
| 140ms | Every press state |

**[decision] Screens fade 4px rather than sliding.** A full push on every tap
becomes tiring on something used forty times a day, and it delays the thing you
opened the screen to read. The `<main>` is keyed on the pathname, because
without the key React reuses the element across routes and an animation that
has already run never runs again.

**The add-invoice sheet.** `visualViewport` reports the keyboard's arrival in
one step, so the sheet teleported upward the instant a field was focused. The
lift is now a 250ms transition on the same curve — the sheet gets out of the
way rather than jumping. The sheet itself slides up from the bottom instead of
appearing.

### 23.4 Pills

**[decision] `--radius-full: 999px`, on buttons only.** Spec §9 says 4px and
every other radius token still resolves to it, so cards, rows and inputs cannot
drift — this is one named value used deliberately on controls, which is a
different thing from `rounded-lg` being available everywhere and quietly
spreading. It also reads correctly: 4px surfaces are things you look at, pills
are things you press.

### 23.5 Smaller things in the same pass

- **Customers is reachable from Deli Delights**, where somebody actually goes
  looking for it. Only there — showing it under the other three would imply
  they have customers too (§17). It stays in the side menu as well.
- **Business logos in the add-invoice picker**, in front of each code.
- **The photograph labelled Mani was Milan.** Corrected; Mani's chip is back to
  initials until his own file arrives.

Tests: 437, up from 427, under all three timezones.


---

## 24. Second round of phone feedback

### 24.1 "The checked off one is still disappearing if all are checked off"

§23 kept paid rows on screen, and then the week gated its sections on
`summary.invoice_count`, which counts only what is still **owed**. So paying
the last invoice replaced the whole screen with "No invoices outstanding here"
— taking the row that had just been ticked, and its Undo, with it. Half a fix
is its own bug.

The sections now gate on whether there is anything to *draw*, which is not the
same question as whether anything is owed. The header still says "Nothing
outstanding", because that part was true.

### 24.2 "Even when paid, there's still label of pending invoices on the menu"

Same root. The unpaid query now carries this session's ticked-off invoices, and
the drawer counted the array as it arrived. It counts `onlyUnpaid` now.

Both are the cost of §23's decision to put paid rows into the shared array, and
both were found by a person rather than by a test. The lesson is already
written into `onlyUnpaid`: every reader of that array has to say out loud
whether it wants what is on screen or what is owed. There is no default that is
right for both.

### 24.3 The add-invoice sheet — one bad measurement

**Reported as:** "jumps in like crazy. Clips off the title where you select the
business. And can't even scroll down."

All three from one line:

```
const hidden = window.innerHeight - viewport.height - viewport.offsetTop;
```

That difference is the keyboard — **and also the mobile browser's collapsing
URL bar**, which is 60-100px and moves while you scroll. So the sheet was
lifting off the bottom with no keyboard present, capping its own height to
match, and losing its top edge off the screen. On a desktop browser, where
there is no collapsing chrome, it was invisible.

Two changes:

- **A keyboard is at least 150px.** Nothing smaller is treated as one. No phone
  keyboard is under it; no browser chrome is over it.
- **The sheet is sized from `visualViewport.height`, not `100dvh`.** `dvh` does
  not shrink when the keyboard opens on iOS, so a sheet capped against it and
  then lifted had its top pushed off the screen. Measured against what is
  actually visible, the sheet cannot be taller than the space it is in.

Verified by measurement rather than by eye: with a 320px keyboard the panel
sits at top 24, bottom 500 in an 820px viewport — entirely above the keyboard,
title visible, scrolling to the end.

The sheet now changes **height** rather than travelling. Growing and shrinking
from the top edge reads as making room; lifting the whole panel reads as being
shoved.

### 24.4 Undo gets a word

It was a green tick, with "tap the tick to undo" in 12px grey underneath. That
asks somebody to read an instruction to discover a control. There is now an
**Undo** button on the row; the tick stays as a status light and does nothing.

### 24.5 The `+` follows where you are

`businessIdForPath` reads the business out of the URL and the sheet prefers it
over the last-used one. Standing in Majheri and adding an invoice to Hurstville
because that is where you were yesterday was a mistake the interface invited.
Order of preference: what you just tapped, where you are standing, what you
used last, the first business.

### 24.6 Words

| Was | Now |
|---|---|
| Businesses | Invoices overview |
| All pending, sorted and filtered | Pending |
| History - what has been paid | History |
| Due date, Supplier, Amount, Recently added | Upcoming, Highest amount, By supplier |

**"Recently added" is gone rather than renamed.** The other three name a
question somebody asks; entry order answers one nobody does - the only reason
to want it is to find something you have just typed, which is what search is
for. `SortKey` keeps `'added'`, because the type describes what `sortInvoices`
can do, not what this screen offers.

### 24.7 "Still no option to add customer!!!"

The field was there from the first build, and the client reported its absence
twice. **Twice is not a discoverability quibble, it is the answer.** It was a
bare input with placeholder text, directly above a real search box - so it read
as a second search box, and a placeholder disappears the moment you type.

It is now a titled panel, "Add a customer", with a labelled `+ Add` button. The
`customers` table was verified present and RLS-protected before anything was
changed, so this was never a broken page.

Tests: 452, up from 446, under all three timezones.


---

## 25. Receivables, and the sheet that would not sit still

### 25.1 The sheet, third attempt — two animations racing

Reported twice, and the second report named it exactly: "springs with so much
force and then bounces a couple times". Three movements, not one:

1. the entrance slide,
2. the height correcting itself after the first measurement landed,
3. the height correcting itself again when the keyboard opened — because the
   supplier field carried `autoFocus`, so the keyboard arrived *during* the
   entrance.

§24 fixed the measurement and left the race. Three changes:

- **`autoFocus` is gone from the supplier field.** It existed to save a tap
  against the fifteen-second target, and the comment defending it was right
  about iOS suppressing programmatic focus outside a gesture. It was still
  wrong overall: two animations racing is not a tuning problem, it is one
  animation too many. It is also the only behaviour that is the same on both
  platforms — Android resizes the layout viewport for a keyboard and iOS draws
  it on top, so "open the keyboard mid-entrance" means two different things and
  neither is calm. **This costs one tap; say if that is the wrong trade.**
- **The viewport is measured in `useLayoutEffect`,** before the first paint, so
  the sheet's first frame is already the right height. Measured after paint it
  rendered at a fallback height and then transitioned to the real one.
- **Height changes are only transitioned once the entrance has finished.**
  While the panel is still travelling a resize is invisible, so it is applied
  instantly; after it has landed it eases. `ENTRANCE_MS` must match the
  `sheet-in` keyframe, which is why it is a named constant beside it.

The panel duration came down from 320ms to 260ms with it.

### 25.2 Money in — `sales_invoices`

§17 put this in Phase 8, after a month of daily use, so it would be built from
how the shops actually work rather than from a guess. The client asked for it
now, having used the app: he wants to record an invoice sent to a customer with
its number, dates and amount, and to see what is outstanding per customer. That
is the guess resolved, which is what the deferral was for.

**A second table, exactly as §17 said.** `sales_invoices`, its own
`sales_status` enum, its own query keys, its own type, its own derive module.
No function in the app takes both kinds. The client's condition — receivables
must never move what the group owes — therefore holds by construction rather
than by care, and `receivables.test.ts` asserts it from both directions,
including that a sales invoice forced through `summarise` with a cast
contributes zero rather than inflating the headline.

**[decision] `outstanding` / `received`, never `unpaid` / `paid`.** You do not
pay an invoice you issued. A shared word is how two directions end up sharing a
code path, and a separate enum means a query cannot compare one kind to the
other even by accident.

**[decision] No receipts table yet.** §17 sketched `sales_invoices` *and*
`receipts`, which is right when part-payments matter. Nobody has asked for a
part-payment, so an invoice is outstanding or it is received, exactly like the
payables side. Adding receipts later is additive; guessing at their shape now
is the thing §17's deferral existed to avoid.

**[decision] The audit trigger does not cover this table.** It is written
against `invoices` and reads `internal_ref`. Attribution is still on every row
— `created_by`, `received_by` — which is the part notes §2 insists on.
Extending the trigger is a separate change with its own migration, and doing it
badly would put a `security definer` function on a new table for no gain today.

**[decision] The `+` asks which direction, and only inside Deli Delights.** It
is the only business that sells. Everywhere else the answer is "a supplier
invoice", and a question with one right answer is not a question — it is three
extra taps a day on the app's most repeated action.

### 25.3 Header

The notification glyph was `&#9737;` — U+2609, "sun" — standing in for a bell.
Drawn now, along with a home icon: on a deep screen the header shows a back
link instead of the wordmark, so home used to be two taps through the menu.

### 25.4 Not done

**The green palette.** The client raised it and then said "maybe we try this
here on lab once the above stuffs are taken care of", so it is deliberately not
in this change. It is also the cheapest thing on the list: every colour in the
app is a token in one `:root` block in `app/globals.css`, so a repaint is that
block and nothing else. Worth doing as its own change, where it can be looked
at and reverted in one commit.

Tests: 464, up from 452, under all three timezones.


---

## 26. Copy, and who hears about a payment

### 26.1 The writing was explaining itself

> "Remove descriptive texts, it feels like hand holding."

Fair, and worth naming precisely rather than just cutting. Almost every line
removed was justifying a decision to the reader:

| Removed | Why it was there | Why it went |
|---|---|---|
| "Never about your own — you already know. Everything shows in the bell either way…" | Explaining §8.1's design | Nobody reads a settings screen to learn its philosophy |
| "Who Deli Delights sells to. Nothing here counts toward what the group owes…" | Reassuring about §17's two ledgers | The heading says Customers and the figure says "Owed to us" |
| "Money out — something we have to pay" / "Money in — something they owe us" | Disambiguating the `+` | "From a supplier" and "To a customer" already do |
| "The PIN is asked for every time the app opens. Your password about every 30 days." | Explaining §8's session model | True, and not a thing anybody needs at the moment they change a PIN |

**The pattern in all four: they were written for somebody meeting the screen
for the first time, and read by somebody using it for the fortieth.** Comments
in this codebase carry the reasoning precisely so the interface does not have
to. That is where these sentences belong, and where they now are.

What deliberately stayed: anything that tells you what to *do* when something
is wrong — "Run CATCH_UP_004.sql in Supabase" is not hand-holding, it is the
only way to fix that screen. Those were shortened, not removed.

### 26.2 Only Mani hears about a payment

> "no one except Mani should get notification of bills being paid, even if they
> enable this option. Although they can check in history and confirm"

§16 had these two events symmetric — anyone who asked, minus the actor — and
the client is right that they are not the same event. An invoice arriving is
news to whoever will have to pay it. An invoice being *paid* is news to whoever
is watching the money, which is one person.

**Nothing changed in running code, because push does not exist yet.** Phase 7
builds it. What changed is the copy, which was promising something the app will
not do: the switch now says "Notify me when a new invoice is added", because
that is all it will ever govern.

**[decision] When Phase 7 arrives, this must not be `if (person.name ===
'Mani')`.** §16's original paragraph exists precisely to prevent a branch that
names somebody, and the client's rule does not require one. The mechanism:

```
profiles.notify_on_payment  boolean not null default false
```

- Set true for Mani, false for everybody else. **Not** in the `self_update`
  column grant, so it is not a preference somebody can turn on for themselves —
  which is what "even if they enable this option" asks for.
- `push_targets` gains a second view, or a column, and the Edge Function picks
  the right audience per event type.
- If the client later wants Rabindra on it too, that is one `update` and no
  deploy.

The rule stays general — *tell the people marked for this event, never about
their own actions* — and the fact that exactly one person is marked stays data.
That is the same move as `role` in §8.1: a fact about a row, not a branch in the
code.

**Unchanged, and worth restating:** History is unconditional. Every payment
records when and by whom regardless of anybody's notification settings, and the
audit trigger writes it whether or not anyone is listening. Turning
notifications off never turns information off — it only decides what a phone
interrupts you for.

Tests: 464, under all three timezones.


---

## 27. The green repaint, and native screen transitions

### 27.1 Colour

The client asked for the app to take Grocery Mate's green. Every value below
was measured, which is the entire reason `app/globals.css` is the only file
allowed to contain a hex.

**The logo green cannot be the button green.** The mark is `#039147`; white
text on it is **4.08:1**, under the 4.5:1 floor. Same hue deepened to
`#046a38` gives **6.72:1**. `--brand-mark` keeps the original for artwork,
where nothing sits on top of it.

| Token | Was | Now | Why |
|---|---|---|---|
| `--brand` | `#082F55` | `#04351E` | Auth screens, splash, browser chrome |
| `--page` | `#d2e3f4` | `#dcece1` | Ink 14.6:1, muted 6.9:1 on it |
| `--action` | `#1b4f8f` | `#046a38` | 6.72:1 on white |
| `--paid` | `#15803d` | `#0f766e` | See below |
| `--person-3` | `#0e7490` | `#3538cd` | Teal now means "paid" |

**[decision] Paid moved from green to teal.** It had to. §9's palette note says
paid is "deliberately NOT the action colour", and that constraint was satisfied
for free while the action tone was navy. With a green action, a green "Mark all
paid" button and a green "Save invoice" button are the same button. Teal is
what this file already named as the alternative for exactly this case — the
original author wrote the contingency down and it came true.

**[decision] The urgency ramp is untouched.** Red, amber, blue, grey. That
sequence is *meaning*, not branding: it is the one thing on screen that has to
be read correctly at a glance, on a bad phone, in bad light, and its contrast
is already verified. The week blue in fact separates better now that the action
colour is no longer navy.

**[decision] Three shadows became tokens.** `--shadow-lift`, `--shadow-sheet`,
`--shadow-dialog`. They were `rgba(8,47,85,…)` literals inside three
components — navy shadows that a repaint would have silently missed, in a
codebase whose one palette rule is that colour lives in a single file. Found by
grepping for the old navy rather than by looking at the screen.

**Reverting is one block.** The previous palette is kept verbatim as a comment
directly beneath the new one. Paste it over and the app is navy again.

### 27.2 Screens push and pop

§21 gave every route the same 4px fade, reasoning that a full slide on every
tap becomes tiring. Half right — the tiring part is sliding when nothing moved
in the hierarchy.

`navDirection` in `lib/nav.ts` compares URL depth: `/` is 0, `/b/gmh` is 2,
`/b/gmh/pending` is 3. Deeper is a push and the screen arrives from the right;
shallower is a pop and it comes from the left; **the same depth is neither**,
and keeps the plain fade — Suppliers and Customers are peers, and sliding
between them would say one sits inside the other.

**[decision] A heuristic, deliberately.** Next's router does not report which
direction a navigation went. The cost of guessing wrong is a screen sliding the
wrong way for 260ms, which does not justify maintaining a navigation-history
stack. Five tests pin the cases that matter.

**[decision] 24px of travel, not a screen width.** The app renders the new
screen over the old one rather than carrying both, so a full-width slide shows
an empty edge where the outgoing screen should be. 24px on a long decelerating
curve reads as the same gesture without the hole.

The previous path is a `useRef`, not state: it must not itself cause a render,
and it is read during the render that follows the change — which is exactly the
render whose animation depends on it.

Tests: 469, under all three timezones.

---

## 28. Going live — the clean slate, and who counts as one of the four

Decided with the client on 31 Aug 2026, before Phase 7 was authorised. None of
it is built yet. All of it is a gate on handing the app to the three of them.

### 28.1 The ledger starts empty

Everything in the database today is test data. Suppliers with invented names,
invoices with invented amounts, the activity log recording all of it. They open
the app on day one and it must look like a notebook nobody has written in.

What comes out: `invoices`, `invoice_notes`, `activity_log`, `suppliers`,
`sales_invoices`, `customers`, and the rows in `invoice_ref_counters`.
What stays: the four `businesses`, and the `profiles`.

**The counters matter more than they look.** They are what makes the first real
invoice `GMH-260901-01`. Leave them and the first thing the client ever logs is
numbered in the nineties, which is a small thing that says loudly that he is
using somebody's test rig.

**[decision] It is one SQL file, run once, before anybody signs in — not a
feature.** §4 rule 5 says nothing is ever deleted, and that rule is load-bearing:
it is why a mistaken tap can never lose an invoice, and why history is always
answerable. A reset is the one moment where deleting is right, and the way to
have both is for it to exist **outside the app entirely**. No screen, no button,
no admin mode. If a delete path existed in the interface, rule 5 would be a
convention rather than a fact, and conventions get worn away by the next
feature that finds them inconvenient.

So: `db/CATCH_UP_00N_RESET.sql`, sent like every other one, and unlike every
other one it is **not** safe to run twice by accident on a live ledger — it is
safe, it just destroys a month of work the second time. It must therefore say
at the top, in the first three lines, exactly what it removes and that it is
meant to be run once. That warning is the feature.

### 28.2 Rabindra is not one of the names

> "my name should not be visible in the profiles. Obviously as the builder and
> maintenance, I always have the access, but I am not the part of an active
> management so I dont want all the notifications and stuffs. In the profiles
> only three names will be seen."

Two facts about the same person that the schema currently cannot tell apart:
**he may use the app**, and **he is not one of the people running it**. Today
one column carries both, and it carries them wrongly.

**The trap, named first.** The obvious move is `active = false`, and it is
wrong. `is_member()` in migration 007 is `exists (select 1 from profiles where
id = auth.uid() and p.active)` — that column *is* the membership test. Setting
it false does not hide him, it locks him out of the app he maintains, and it
does so silently: every screen simply returns nothing.

**[decision] A third value on `role`: `'member'`, `'owner'`, `'builder'`.**
`role` already exists for exactly this kind of fact — §8.1 wrote it to decide
what a screen shows and stated that it is deliberately absent from every RLS
policy. Extending it keeps that promise. One value, one row, one `update` to
reverse, and no policy anywhere learns about it. It is the same move as §26.2's
`notify_on_payment`: a fact about a row, never a branch that names somebody.

What reads it:

- **The unlock picker and any list of the people** render a new selector —
  active, and `role <> 'builder'`. Three faces, three names.
- **`push_targets` excludes builders in SQL**, so it holds regardless of what
  the app remembers to filter, and regardless of his own switch. That is what
  "I dont want all the notifications" has to mean to survive a refactor.
- **`is_member()` is untouched.** Access is unchanged.

**What `useProfiles()` must keep doing: returning him.** It is the lookup the
attribution chips resolve names through, and a chip that cannot name whoever
touched a row is a worse bug than a name appearing where it should not. The
data keeps everybody; the two screens that present *the people* filter. Those
are different questions and they get different selectors.

The cost, stated: he loses the six-digit quick unlock, because the picker is
what it is chosen from. He signs in with email and password. For the person who
deploys the thing, that is the right side of the trade.

### 28.3 Receivables: Phase 8 is closed

> "if we are talking about the customers, then its already added and so is the
> entry methods. other than that, I dont think there is anything else to track.
> This app wont be storing payment methods or details. its more of a super
> advanced shared notebook."

He is right, and §17 is now out of date rather than wrong. It scoped three
tables — `customers`, `sales_invoices`, `receipts` — and reasoned that nobody
yet knew which of reminders, part payments and relationship-chasing Deli
Delights actually needed. §25.2 then built the first two at his request. What
§17 still projected was the third, and the answer to its own open question is
now in: **none of them.** Who owes us, how much, since when, and a tick when it
lands. That is the whole job.

`receipts` was only ever needed to record a payment as an event with its own
detail — method, reference, part amount. A notebook does not do that, and this
is a notebook. **Phase 8 as written in §17 does not exist.** §17 stays in this
document because its *reasoning* is still what stops anybody merging the two
ledgers into one table with a direction flag, and that reasoning is unaffected.

**Part payments — [decision] notes carry them, on both sides.** Asked, and
answered: *"there is a feature to add notes as well, and with dates being
editable, if its followed up properly it will be good."*

`sales_invoices.status` stays binary, and so does the payables side. A customer
who pays half gets a note saying so and a due date moved to when the rest is
expected. The invoice stays outstanding for its full amount until it is
actually settled, which is the conservative direction: it over-states what is
owed rather than under-stating it, and the number a person is chasing is never
smaller than the truth.

The alternative was `amount_received_cents` with the status derived from it, and
the reason not to build it is not effort — it is that a partial-payment column
is the first plank of an accounts package. It brings a remaining-balance figure
on every row, then a receipts history, then reconciliation, and each one is
reasonable given the last. §28.3's ruling is that this is a notebook. A note and
a date are what a notebook has.

**What this costs, so it is not a surprise later:** a half-paid invoice reads as
fully outstanding on every total until somebody opens it. The information is
never lost — it is in the note and the activity stream — but it is not in the
headline figure. If Deli Delights starts taking deposits routinely rather than
occasionally, that is the signal to revisit, and revisiting means the column,
not a workaround.

### 28.4 Push is a capability, not a rollout

> "they will add a homescreen icon, and enable the push if they think its
> needed, if not its their call. I just want the app to be capable of doing so
> when needed."

This settles the uncomfortable part in §8.1 rather than removing it. iOS still
gives no push until the app is on the Home Screen, and push is still not
guaranteed delivery — but neither is now a thing to warn the client about
before building, because he has already decided the switch is theirs to find.

What it changes about Phase 7: build the subscription path, the Edge Function
and the switch, verify it end to end on one device, and stop. **No onboarding
prompt, no "enable notifications" interstitial, no badge nagging somebody to
install to the Home Screen.** The in-app bell remains the channel that always
works (§8.1), which is precisely what makes it safe for push to be optional.

---

## 29. Phase 7 — the app off the network, and push

Authorised 31 Aug 2026. Everything below is built, typechecks, and passes 506
tests under all three timezones. **Push is the exception and it is stated
plainly in §29.6: the app half is done and nothing will actually be sent until
four steps only the client can do are done.**

### 29.1 The offline write queue

`networkMode: 'offlineFirst'` was set in Phase 1, so an offline write already
paused instead of failing. What Phase 7 adds is the half that makes that
survive the app being closed: the paused mutations are persisted to IndexedDB
and resumed when the phone comes back.

`lib/offline/` is the whole of it — `keys.ts`, `persister.ts`, `register.ts`,
`submit.ts`, `pending.ts` — and `app/providers.tsx` wires it in.

**[decision] Every write is registered by key, not declared in its hook.** This
is the one structural change and it touches all seven query modules. A restored
write comes back as a key plus its variables and nothing else; the function it
was going to run died with the session that made it. TanStack finds it again by
looking the key up in `setMutationDefaults`, which is why each module now
exports a `register*Mutations(queryClient)` and its hook is one line:
`useMutation({ mutationKey: mk.x })`.

The consequence to keep in mind when adding a write: **anything the mutation
needs must be in the variables.** `useAddNote(invoiceId)` closed over the
invoice id, which works perfectly until the write is resumed two days later
with no component holding it. It now takes the id in its variables, and that is
the rule for every future write.

**[decision] The implementations stay in `lib/queries/*`; only the list lives
in `lib/offline/register.ts`.** One file holding all eleven mutation functions
would put the offline story in one place and separate each write from the query
keys it invalidates, the types it uses, and the reasoning written beside it.
Every one of those is a stronger relationship than "is also queueable".

**Client-generated ids, everywhere a row is created.** Invoices and sales
invoices already did it (notes §1.5). Notes, suppliers and customers now do
too, and it buys two different things:

- **Replay safety.** Every create is `upsert(..., { ignoreDuplicates: true })`
  on that id, so a write that arrives twice does nothing the second time.
- **The entry flow no longer waits for the database.** This is the bigger one.
  Adding a supplier from inside the sheet used to `await` an id from the
  server; offline that await never returns, because the write is paused rather
  than refused — so the fifteen-second flow stopped dead at exactly the place
  it is most likely to be used, a supplier's dock with no signal. The sheet now
  decides the id, selects the supplier immediately, and both writes queue in
  order behind each other.

**What is persisted, and what is refused.** Only mutations, only paused ones,
and only ones with a registered function. Reads are never persisted — notes
§1.5, and it is the decision most likely to be reversed by somebody trying to
make the app open faster offline. It must not be: an hours-stale total that
looks current is the trust-destroying failure the bug notes name. The offline
page says the network is gone rather than showing Tuesday's figures.

A paused mutation whose key is not in `mk` is **dropped rather than stored**,
because a stored write with no function fails on resume, after the session that
made it has gone, where nobody can be told. `test/unit/offline-queue.test.ts`
asserts that every key in `mk` has a function registered and that
`QUEUEABLE_KEYS` and `mk` have not drifted apart.

Seven days, then the queue is discarded — `maxAge` in `persister.ts`. A write
made on Friday at a dock and resumed on Monday is what this is for; one made
three weeks ago and replayed now is an invoice nobody remembers entering, which
has almost certainly been entered again by hand in the meantime.

### 29.2 A bug found while building it — and it was already shipped

The add-invoice sheet had this, and it reads correctly:

```ts
try   { await createInvoice.mutateAsync(...); toast('Saved · REF') }
catch { toast('Saved — will send when you’re back online.') }
```

It is wrong twice.

**A paused mutation never settles.** Offline, the write is not attempted and
not rejected — it waits. So `await` does not throw, it hangs, and the catch
written to handle being offline is the one branch being offline can never
reach. The sheet closed and said nothing at all.

**And the catch lied about everything else.** A write refused by RLS, a
malformed payload, a supplier that no longer exists — every one of them landed
in a catch that says "Saved". In a payments ledger, saying "saved" when nothing
was saved is the worst sentence this app can produce.

The test standing over it asserted the *rejected* case showed the queued
message, so it passed, and it could never have caught this.

`lib/offline/submit.ts` replaces the try/catch with three outcomes — `saved`,
`queued`, `failed` — and checks for being offline *before* starting rather than
after failing, because once a mutation is paused there is nothing to await.
Four screens use it.

**This is a tenth for §19's table, and it is the same shape as the other five:
a value that could hold states which should not exist.** Two branches
describing three outcomes. The fix was not a better catch; it was making the
third state representable.

### 29.3 The service worker

`public/sw.js`, registered after `load` and skipped entirely in development —
a worker caching the shell across a hot reload produces the worst class of bug
there is, where the code on screen is not the code on disk.

Two guards in `fetch`, and both are absolute:

- **GET only.** A POST, PATCH or DELETE passes through untouched. This is the
  line that stops the worker becoming a second write queue. Two queues that can
  both send the same invoice is how an invoice gets entered twice, and
  Background Sync makes that exact mistake easy and appealing.
- **Our own origin only.** Every Supabase request — reads, writes, the token
  refresh — is none of the worker's business. Caching a signed-in read would
  serve one person's invoices to whoever opens the app next on that phone.

Static assets are cache-first, because Next fingerprints them and a cached copy
cannot be stale. Navigations are network-first with `/offline` as the fallback
— deliberately not the last dashboard we happen to have, for the reason in
§29.1. `/offline` is excluded from the middleware matcher so that what gets
precached is the page and not a redirect to `/login`.

### 29.4 Error boundaries

Three files, none of which existed: `app/(app)/error.tsx` for the signed-in
screens, `app/global-error.tsx` for a failure in the root layout itself, and
`app/not-found.tsx`. Before them, a thrown render error took the whole app to a
blank white page.

Each says the same thing first, because it is the first question somebody in a
shop actually has: **nothing has been lost.** Then a way to retry, then a way
out. None of them shows `error.message` — in a production React build it is a
digest like "Minified React error #418", which tells the person nothing and
reads as if the app is blaming them. It goes to the console.

`global-error.tsx` is the second documented exception to rule 3, alongside
`app/manifest.ts`, and HANDOFF §4.3 now names both. It replaces the document at the moment the root
layout has failed, which is exactly when the stylesheet cannot be relied on,
and a boundary that renders white-on-white is not a boundary.

### 29.5 The 200-row pass

`test/unit/scale.test.ts`, against the seeded 200-invoice fixture. It found one
thing and confirmed another.

**Found:** `summariseByBusiness` called `onlyUnpaid(rows)` inside its map over
businesses, so the work grew with businesses × invoices — four businesses and
two hundred rows is eight hundred passes to do two hundred rows of filtering.
Hoisted. Not slow enough for anybody to have noticed, which is the point of
looking.

**Confirmed:** everything else is linear, and the invariant that matters holds
at scale — every total is the sum of exactly the rows shown, under a business
filter, under a search, per bucket and per payment run. At forty rows an
off-by-one in a total is invisible. At two hundred it is not.

The timing budgets in that file are loose on purpose. They catch an accidental
O(n²) and they say nothing about milliseconds on a phone; that number comes
from a phone.

**Empty states were already done.** Spec §10 lists them in this phase, and an
audit found every screen that can be empty already says so in its own words —
`HistoryList` even distinguishes "nothing matches your filter" from "nothing
has been paid yet". Nothing was owed and nothing was added.

### 29.6 Push — built, and not yet on

The shape, unchanged from §8.1: an invoice event fires a database trigger, the
trigger decides who to tell, and an Edge Function signs and sends.

**[decision] The Edge Function has no database access at all.** The obvious
design — the function reads `push_targets` itself with the service-role key —
is the one every tutorial shows and it is forbidden here. HANDOFF §4.1: no
service-role key, anywhere. The rule is absolute precisely so no future feature
has to re-argue it, and "but this one only reads" is exactly the argument that
would end it.

So the direction is reversed. Postgres already holds the rule about who hears
what, in the two views from `CATCH_UP_006.sql`, and `notify_push()` sends the
finished list of endpoints to the function. The function holds the VAPID
private key — the one secret that genuinely cannot live in the database,
because signing is a thing only the sender can do — and knows nothing else. It
cannot read an invoice even if something asks it to.

**Only Mani hears about a payment**, as `profiles.notify_on_payment`, true for
one row and outside the `self_update` column grant so nobody can turn it on for
themselves. §26.2 said this must never be `if (person.name === 'Mani')` and it
is not: the one place his name appears is an `UPDATE` in a migration, setting
data. Both target views also exclude `role = 'builder'`, which is the mechanism
§28.2 chose for keeping Rabindra out of every notification — no builders exist
yet, and putting it in the view now makes that change one `UPDATE` later
instead of another file to run.

**No prompting, ever.** §28.4: build the capability and stop. There is no
onboarding prompt, no "enable notifications" interstitial, no badge suggesting
anybody install to the Home Screen. The switch is in Settings and somebody who
never opens Settings never hears about it. That is the intended outcome.

Settings now shows what the device can actually do rather than a switch that
might silently do nothing: on an iPhone in a Safari tab it says to add the app
to the Home Screen first, because Apple gives no Push API until then; where
permission has been denied it says only browser settings can undo that, because
the app cannot.

**One thing found while switching it on, worth not re-deriving.** The address
and the shared secret were going to live in database settings
(`alter database postgres set app.notify_url = ...`), which is the obvious
place for them and which fails on a hosted Supabase project: `42501:
permission denied to set parameter`. The SQL editor connects as `postgres`,
which is not a superuser there. They live in an `app_config` table instead,
with RLS on and **no policy at all** — a combination that denies everyone,
leaving only the table's owner and the SECURITY DEFINER function that reads it.
Supabase Vault would encrypt it at rest and is the tidier answer; it is one
more extension to depend on, and what is stored only lets its holder send a
notification.

**What is left, and it is not mine to do** — `db/push/README.md` has the five
steps. Generating the VAPID keypair, putting the public half in Vercel,
deploying the Edge Function with its secrets, and running `notify_trigger.sql`
all need credentials that deliberately do not exist on my side. Until they are
done the switch works, devices subscribe, and nothing is sent. Nothing is
broken in the meantime, because the bell was always the real channel and push
was always a nudge on top of it.

### 29.7 One rule made true again

HANDOFF §4.2 says `new Date()` appears in `lib/date.ts` and nowhere else, and
`toISOString()` is banned outright. Three files were calling both directly, for
optimistic `created_at` timestamps — harmless in themselves, and enough to make
the rule untrue, which means the next person reading those lines would
reasonably conclude it was advisory.

`nowTimestamp()` in `lib/date.ts` is now the one sanctioned use, and it says in
its own comment what it is not: an instant, never a calendar date. Taking the
first ten characters of it is the exact bug notes §3 is about.

Tests: 506, up from 469, under `UTC`, `Australia/Sydney` and
`America/Los_Angeles`.

---

## 30. The builder, and pictures that change without a deployment

Two things the client asked for in one message, on 31 Aug 2026, after Phase 7
was built and before it was deployed. Both are §28 work brought forward, and
the second is new.

### 30.1 Rabindra becomes the builder

> "Designate me as a builder and then so I wont be shown in their feed as a
> user."

§28.2 decided the mechanism and `CATCH_UP_007.sql` does it: `role` gains a
third value, `'builder'`, and his row gets it. Nothing about his access
changes, because no RLS policy reads `role` — migration 005 says so, and says
that if it ever starts deciding what somebody can read or write, that belongs
in a policy instead.

**[decision] `useTeam()` beside `useProfiles()`, not instead of it.** The two
answer different questions and conflating them is the way to get this wrong:

- `useProfiles()` is a **lookup**. It resolves a name and a face against
  whoever touched a row, and it must keep returning everybody. Filter it and
  any invoice he ever touched renders an unnamed chip.
- `useTeam()` is a **list of people**, rendered as choices, and it excludes
  builders.

One caller changed: the payer filter on History. That is the only place in the
app that enumerates people as choices — which is worth recording, because §28.2
predicted this would also cost him the six-digit quick unlock. **It does not.**
There is no profile picker: the unlock screen reads `useCurrentProfile()`, so
it shows whoever signed in and knows nothing about the list. §28.2 was wrong
about that cost and this paragraph is the correction.

The fixture now has him as a builder with both notification flags false, which
is what the database says after `CATCH_UP_007.sql`. `CATCH_UP_006`'s two push
views already excluded the role, so he is not a notification target by two
independent mechanisms.

### 30.2 Pictures, changed from the app

> "Grant me a permission to edit and change the pictures/icons from my end that
> way I wont have to call up on you each time they have any updates on logo."

`lib/logos.ts` is a hand-edited table of files in the repo. Its own comment
argued for that — four pictures that change roughly never do not need a
migration — and it was right about the pictures and wrong about the people.
Every new logo was a message to whoever had the repo, plus a deployment.

A Supabase Storage bucket, `brand`, now sits in front of that registry.
`/brand` lists every business and every person with Add, Replace and Remove.

**[decision] Three levels, not two.** An uploaded picture wins over the bundled
file, which wins over the letters or initials. Dropping the middle level would
be simpler and would mean a removed upload takes GroceryMate back to a grey
tile rather than back to the logo that shipped.

**[decision] Deterministic paths, and no table.** A business's logo is always
`businesses/<code>` and a person's is `people/<name>`, lower-cased, no
extension. Replacing one is an upsert to the same path, so the bucket cannot
accumulate orphans and there is no second table to fall out of step with what
is actually stored. The public url carries `?v=<modified time>` because
Supabase's CDN caches on the url and the url does not otherwise change when the
file behind it does — without it, an upload appears to have silently failed.

**[decision] A React context, not a hook in the leaf components.**
`BusinessMark` and `PersonChip` are rendered dozens of times per screen and in
most of the component tests. A query hook inside them would make every one of
those tests need a QueryClient to draw a 24px square, and would couple the
smallest components in the app to the data layer. The context's default is an
empty map, so a chip with no provider above it falls back to exactly what it
drew before — which is also what happens on a phone before the bucket has
loaded, and before `CATCH_UP_007.sql` has been run at all.

**Who may change one: the builder, and nobody else.** Enforced by a storage
policy on `storage.objects` and mirrored in the screen so that no button is
offered that would be refused. This shipped as `owner or builder` and was
corrected within the hour — §30.3 has the client's reasoning and mine.

**What this deliberately cannot do: the app's own icon.** The Home Screen tile
and the browser-tab icon are read by the phone before the app has loaded, so
they are part of the build and a new one is still a deployment. The screen says
so in a sentence rather than offering a control that quietly does nothing.

**Not queued for offline**, unlike every write in `lib/offline/keys.ts`. A
queued upload means holding an image in IndexedDB for up to a week and
replaying it against a path that may have been changed twice since. Changing a
logo is a deliberate act done sitting down; "try again when you have signal" is
an honest answer for it.

Tests: 522, under all three timezones.

### 30.3 The correction: Mani is a user, not an editor

`CATCH_UP_007.sql` let the owner change pictures as well as the builder. That
was my call, on the reasoning that the point of the feature was nobody having
to wait on one person. The client corrected it:

> "mani doesnt get to do any editing stuffs. the three users are only users
> with mani having slight higher authority. the builder is basically a shadow
> operator and its not in the system."

He is right, and it is the sharper reading of what `role` has always meant
here. **Mani's authority is over the money.** He is the one told when a bill is
paid (§26.2), and the one whose screen carries the owner's overview (§8.1). It
was never authority over the app itself, and a logo is part of the app rather
than part of the ledger. Widening it to `owner` quietly turned a fact about the
ledger into a permission over the product, which is the thing migration 005's
comment warns against in the other direction.

`CATCH_UP_008.sql` replaces `is_brand_editor()` with `role = 'builder'` alone.
The four storage policies call it by name, so replacing the function is the
whole change — nothing needs re-granting.

**"Not in the system" also reached the pictures screen.** It listed all four
people, which would have offered a slot for a photograph of somebody who has
asked not to appear. It now renders `useTeam()`, the same three names as the
payer filter.

So the shape, stated once: **three users, one of whom hears about payments; one
builder, who is not a user and is the only editor.**

### 30.4 A wifi symbol, and the chip that made room for it

> "include a wifi like symbol on the header bar to signify if they are online
> or offline. you can remove the profile picture thing from the top right
> corner."

**[decision] The indicator is always visible**, which reverses what Phase 7
shipped a week earlier. `QueuedWrites` rendered nothing when there was signal
and nothing queued, on the notes §6 reasoning that an interface should not
narrate a state that is simply normal.

That reasoning is right in general and wrong here. **A symbol that appears only
when something is wrong is a symbol nobody has ever seen before the moment
something is wrong.** On a dock with one bar the question is not "is something
broken" but "did that save", and an indicator that is normally absent cannot
answer it: there is no way to tell *fine* from *not rendered*. Always-on, the
arcs simply go quiet, and the answer is in the same place every time.

Offline is the same three arcs with a stroke through them rather than a
different icon, so the two states read as one thing changing. A queued count
sits beside it when there is one, and wins the accessible label — "2 waiting"
already implies there is no signal, and it is the half that says something
about somebody's invoices rather than about their phone.

**The profile chip is gone from the header**, which is what makes room. Nothing
became unreachable: the drawer opens with the same chip, the same name and the
same link to Settings, and the menu button is on every screen. `AppChrome` no
longer reads `useCurrentProfile()` at all.

Tests: 525, under all three timezones.

---

## 31. The third motion pass, and the slate

### 31.1 "Still abrupt" — the two earlier passes were fixing the wrong thing

§23.3 tuned the curve. §27.2 gave push and pop their directions. Both were
about how the arriving screen moved, and the client's report after each was
some version of the same sentence: *"still abrupt... doesn't give that premium
feel."*

**Nothing animates out.** React unmounts the old screen and mounts the new one
in the same commit, so the outgoing content disappears in a single frame. A
transition has two halves and every pass so far had described only the arrival.
With the arriving screen starting at `opacity: 0`, what a person actually sees
is:

```
content  ->  empty background  ->  a ghost fading up  ->  content
```

The flash of nothing in the middle is the whole of the abruptness, and no
easing curve was ever going to fix it — the eye was reading a gap, not a curve.

**[decision] A push and a pop no longer fade.** They are pure translation: the
new screen is fully opaque from its first frame and slides into place over the
page ground. There is never a moment with nothing on it. 28px over 300ms on the
iOS curve, up from 24px over 260ms — once the fade is gone the movement is the
only thing to see, and 260ms read as fast-then-stop.

The sideways move keeps a fade, and that is not an inconsistency: nothing moved
in the hierarchy, so there is no direction to travel in, and a cross-dissolve
is the honest way to say "this replaced that". It fades from 0.4 rather than
from 0, for the same reason as above.

**The alternative, and why not.** Genuinely animating the outgoing screen means
holding both in the tree for the length of the transition — either the View
Transitions API, which is experimental in this Next version, or carrying the
previous children in state. Both are real changes to how every screen mounts,
for a second half nobody sees once the gap is closed. If the client says it
again after this, that is the next thing to try and it should be tried
properly, not approximated.

**Not verified on a phone.** This was reasoned from the code and confirmed in
the browser only as far as the computed values — 300ms, the right curve, no
opacity in the keyframes. Whether it *feels* right is his call and always was.

### 31.2 The slate

`CATCH_UP_009_RESET.sql`, written to §28.1 and run once before the app is
handed over. Every invoice, note, activity row, supplier, customer and sales
invoice goes; the businesses, the profiles and every policy, view and function
stay. The reference counters go too, so the first real invoice is
`GMH-YYMMDD-01` rather than something in the nineties.

Push subscriptions are cleared as well. They are registrations rather than
data — each one a browser that asked to be notified — and the three of them
should switch notifications on deliberately, on their own phones, rather than
inheriting what was left over from testing.

`delete` throughout rather than `truncate`. Truncate would need `cascade`,
which follows foreign keys into tables this file has not named, and a reset
that removes something nobody listed is the exact surprise it exists to avoid.

**No notification is sent and no history is written by it**: the audit trigger
and the push trigger both fire on insert and update only, so a delete passes
them silently.

Tests: 525, under all three timezones.

---

## 32. Signing out no longer takes somebody's work with it

The one audit finding fixed rather than accepted. §31 and the audit both name
it; this is what was done.

**What was wrong.** `queryClient.clear()` empties the cache in memory and does
not touch the copy of the write queue on disk. So signing out left the queue
behind, which is wrong in both directions at once: a queued invoice could be
**lost** — the person was told "will send when you're back online" and nobody
was going to send it — or **sent later by whoever signed in next**, since the
queue is restored on the next load regardless of who that is. Attribution would
have survived either way, because the author is baked into the payload. The
promise would not have.

**Two halves, and they belong in different places.**

`clearOfflineQueue()` and `clearShellCache()` in `lib/offline/persister.ts` are
the mechanical half: sign-out now clears both stores, awaited before the
navigation that kills the page. Both swallow their own errors, because failing
to sign out over a housekeeping error leaves somebody signed in, which is the
worse of the two states.

The Settings screen is the honest half. **[decision] It refuses to sign out
quietly while anything is waiting.** With an empty queue it is the plain
sign-out it always was; with something queued it names the count and says
plainly that signing out loses it.

**The dialog is live, and that is the point of it.** The count comes from the
queue itself, so if the wifi returns while the question is on screen the queue
drains, the count reaches zero and the dialog closes itself. Pressing sign-out
with signal also kicks `resumePausedMutations()` first — the queue usually
empties in the time it takes to read the question. A question that answers
itself is better than one somebody has to think about, and the ones left over
are the ones that genuinely needed asking.

**What was deliberately not done: blocking sign-out.** Somebody handing a phone
over, or signing out because they have to, must always be able to. The app's
job is to make sure they know what it costs, not to decide for them.

Seven tests, and they are about the sentence rather than the mechanism: that
nothing is asked when nothing is waiting, that the loss is stated in words, that
"Wait" leaves them signed in, and that the app tries to send before it asks.

Tests: 532, under all three timezones.

---

## 33. Handover — what was accepted, and what is next

Written at the end of the session that shipped Phase 7. The app is live, the
ledger is empty, and the three of them can start.

### 33.1 What was accepted rather than fixed, and why

A full pre-release audit ran against the live system before handover: the
anonymous-access attack script against every table and RPC, an attempted
anonymous upload and delete against the storage bucket, every policy, grant,
constraint and trigger read, all 36 commits searched for secrets, `npm audit`,
a clean build and the suite under three timezones. Eleven findings, no
criticals.

**One was fixed** — §32, signing out discarding unsent work. It was the only
finding that was a defect rather than a risk: the app saying something untrue.

**The rest the client accepted, and the reasoning is his, recorded because
somebody will otherwise read them as things that were missed.** The reframing
that decides all of them:

> "this is meant to be just an advanced interactive notes. They have better
> means to track record of things. Rather than scribble it somewhere or put in
> note and then consolidate, its more of a reminder app about 'oh its already
> due tomorrow?'"

That changes the risk arithmetic completely, and it is the right frame. A
reminder layer over records that live elsewhere is not a system of record, and
the findings should be read against that:

| Finding | Accepted because |
|---|---|
| No confirmed backup plan | The records exist elsewhere. Losing this database costs the reminders, not the accounts. |
| Deletion possible outside the app | The app offers no delete path and never will, and only the client reaches Supabase. Deleting via a crafted request needs skill and intent none of the three has. |
| `paid_by` forgeable by a direct request | Same reasoning, and the activity log takes its actor from the session, so the truth survives regardless. |
| Staff photographs at public, guessable urls | Four headshots of people who run shops. Asked explicitly; answered explicitly. |
| No bucket-level size or type limit | Only the builder can upload at all. |
| `postcss` advisories via Next 15 | Build-time only, no runtime exposure, and no fix exists short of Next 16. Revisit at a quiet moment. |

**The one correction worth keeping.** The client's reasoning was "as long as it
can't be deleted from the app, it's fine, as I am the only one who can access
Supabase." The first half is true and stays true. The second is not quite: a
signed-in member could in principle delete through a crafted API request
without touching Supabase. The decision stands and is sound; the premise was
half right, and the next person should know which half.

### 33.2 The next piece of work

Not bugs, and not soon — **after a month of real use**, which is the same
discipline spec §11 applies to everything else on that list.

**Export by date range.** In his words: *"from this date to this date export in
excel or csv etc."* That is more specific than §17 had it, and it settles the
question §17 left open. The shape it implies:

- A date range, not "everything" — which means the export is a *report*, taken
  for a period, rather than a backup of the ledger.
- Almost certainly the history screen's own filters, extended: it already
  scopes by business, payer, search and void, and an export that disagreed with
  the screen it was launched from would be the "one array, one total" rule
  broken at the last step.
- CSV is an hour and needs no dependency. A real `.xlsx` is half a day and is
  the first dependency added purely for output — spec §4 rules out libraries
  that cost more than they save, and this one is genuinely borderline.

**The question to ask him before building either:** what happens to the file
when it arrives. §17 has been waiting on that answer since Phase 6 and it is
still the thing that decides between the two. If it is opened, read and
deleted, CSV is right. If it is kept, formatted, and handed to somebody, it is
worth the half day.

### 33.3 Where everything sits

- **Live:** https://shg-invoices.vercel.app, deployed from `main`.
- **Repo:** `SaHG2026/SHG-invoices`. `main` now holds everything;
  `phase-1-foundation` and `tidy-up-before-phase-7` are history.
- **Database:** migrations `001`–`009` plus `CATCH_UP_001`–`009` all applied.
  The ledger is empty by design — `CATCH_UP_009_RESET.sql` was run at handover.
- **Push:** live. Edge Function deployed, secrets set, trigger installed.
- **Tests:** 532 at handover; 572 after §34. All under `UTC`,
  `Australia/Sydney` and `America/Los_Angeles`.


---

## 34. Venue staff accounts — the day `role` became a permission

GroceryMate Parramatta and Hurstville get a login each. The client's reason, in
his words: *"the idea is to reduce management work load by enabling staffs to
add invoice, the management will just review"*.

That sentence settles more of the design than it looks. It rules out read-only —
which was my recommendation and was wrong on the premise — and it makes the
venue chip load-bearing rather than decorative, because "who entered this" is
the whole of what reviewing means here.

### 34.1 What migration 005 was waiting for

Migration 005 has carried this comment since Phase 1:

> `role` is NOT a permission... If `role` ever starts deciding what somebody can
> read or write, that belongs in a policy — and this comment is the warning that
> no such policy has been written.

`CATCH_UP_010` is that policy, taken deliberately rather than drifted into. From
here `role` decides access for exactly one value — `staff` — and `member`,
`owner` and `builder` remain what they always were: facts about what a screen
shows, identical in access.

### 34.2 The door, not nine locks

Nine policies across 007, 008, 009 and CATCH_UP_007 say `is_member()`, and each
means "one of the four". The obvious move is to add `and business_id = ...` to
the ones that matter, which is nine chances to miss one, and a missed one is a
leak nobody sees.

So **`is_member()` changed meaning instead** — from "has an active profile" to
"is one of the people who run the businesses". Every existing policy then
excludes staff without being edited, and so does any policy written in a later
phase by somebody who never reads this section, because they will write
`is_member()` like all the others. Staff access is added one object at a time
below it. The default is no.

For the current four it is provably a no-op: all of them are `member`, `owner`
or `builder`, and §7 of the file proves it in the same paste rather than
asserting it.

### 34.3 Why payment status needed a view

Two mechanisms cannot withhold a column per-person, and both are worth knowing
so nobody tries them later:

- **RLS cannot restrict columns.** It decides which rows, full stop.
- **A column-level `GRANT` can**, but it applies to the `authenticated` role,
  which is every signed-in person. Hiding `status` that way hides it from Mani.

So `staff_invoices` is a view with those columns simply absent, and the base
table stays shut. **The view's `WHERE` is the entire boundary** — a view runs
with its owner's rights and reads `invoices` in full — which is why it is the
one thing in the file marked as such, and why `verify_rls.mjs` has to be run as
a real staff account rather than clicked at.

**And the view returns every invoice, paid or not.** That is the requirement,
not laziness: if it held only unpaid ones, a row disappearing from a shop's list
would *be* the payment notification. Absence leaks exactly the fact being
withheld. Nothing on the venue screen may change when money moves.

### 34.4 The consequence nobody would have predicted

"What does this venue owe" **is** the payment status, computed. Any figure
separating settled from unsettled hands over the withheld fact in a form harder
to spot than a badge.

So the venue screen has no liability total, no urgency, and no overdue
treatment — `lib/derive/urgency.ts` exists and is deliberately not used there.
The only figures are records of what was *entered*: a count and a sum per month,
both of which move when somebody logs an invoice and never when somebody pays
one. That property is what makes them safe, and `test/unit/venue.test.tsx`
asserts it by checking the totals equal the whole month.

Which is why this is a screen of its own rather than the dashboard filtered. The
dashboard answers "what leaves the account this week". This answers "was that
delivery logged, and for how much". Reusing the first would put an overdue badge
on invoices paid a fortnight ago.

### 34.5 Three blocklists that would have admitted the new role

`push_targets`, `push_targets_payment` and `useTeam()` all filtered
`role <> 'builder'`, written when builder was the only role to keep out. **A
blocklist admits every role invented after it.** On the day these accounts
existed, two notification audiences would have included the shops, and the
profile picker would have listed GroceryMate Parramatta as one of the people who
run the businesses.

Nobody would have written that bug. It would simply have happened. All three are
now allowlists, and the predicate lives in `lib/staff.ts` as a named function so
it is findable and fails closed for whatever the sixth role turns out to be.

This is §19's pattern again at a different scale: the fix makes the broken state
unrepresentable rather than correcting the branch that produced it.

### 34.6 What was duplicated on purpose

`AddVenueInvoiceSheet` is a copy of `AddInvoiceSheet`, and `VenueChrome` a copy
of the shell. That is deliberate, and it is the client's constraint applied
literally — *"lets not publish anything, if it affects the useability of the
current version"*.

`AddInvoiceSheet` is the screen spec §1's fifteen seconds is measured through. A
role branch inside it would put the app's one measured feature at regression
risk to serve two accounts, and every later change to the entry path would have
to be reasoned about in two audiences at once. Duplication is the cheaper
mistake.

**What is not duplicated is anything that decides what gets written.**
`invoiceFormSchema` and `buildInvoicePayload` are imported, because notes §1.3
is about precisely this: the previous app had two paths that built a record, one
of them wrong, and it looked like it saved.

Three things genuinely differ, each forced rather than chosen:

1. **No business picker.** A venue has one venue and the database enforces it —
   the insert `with check` (hardened in CATCH_UP_012) requires the row to be
   the caller's own venue, unpaid, and attributed to the caller. Offering a
   choice the insert would refuse is the interface promising what it cannot do.
2. **A different duplicate lookup.** `find_duplicate_invoices` returns
   `setof invoices` — status and `paid_at` included — so a venue must never
   reach it. `find_duplicate_invoices_staff` returns five safe columns.
   Without it the choice was leaking payment status or removing spec §6's
   protection from the accounts most likely to need it: one login, two shifts,
   no activity feed to check.
3. **The toast cannot name the reference.** A venue has no SELECT policy on
   `invoices`, so its insert must not `.select()` the row back — PostgREST
   answers a select it cannot satisfy with an empty result rather than an error,
   which would look like it worked. Its own mutation key exists for that reason,
   not for tidiness.

### 34.7 What was accepted

- **Supplier names are visible across all four businesses.** The type-ahead is
  how the fifteen seconds works and it needs the list. A name carries no amount.
  INSERT is granted, UPDATE is not: one shop renaming a supplier the group
  depends on is a change nobody could trace.
- **Attribution is permanently the venue.** `created_by` and every
  `activity_log.actor_id` says GMP, not which shift. Spec §5's "attributable to
  a person forever" is partly given up for these two accounts, knowingly, and
  **it is not recoverable later** — switching to per-person logins in six months
  leaves everything before then as GMP.
- **No void.** A wrong entry that survives the window below is voided by one of
  the four.

### 34.8 Five minutes to fix a typo

Asked for after the first build: *"allow them to edit an invoice if its within 5
minutes of recording it. in case they mess it."*

My earlier answer was that no edit was possible without leaking payment status,
and that was right about `status` and wrong about the conclusion. **A clock
leaks nothing.** "Editable until it is paid" makes the rule deciding what a shop
may do the same fact a shop may not know. "Editable for five minutes" is a
rule they can see coming and which says nothing about money.

`staff_update` still carries `status = 'unpaid'`, and it is not there to hide
anything — it is there so an invoice already paid cannot have its amount changed
underneath the payment. The residue is: somebody paid within five minutes of a
shop entering it. Vanishingly rare, and the app says the same sentence for that
refusal as for every other one.

Four conditions on `using`, the same four minus the clock on `with check`.
Leaving `with check` off is how a "fix a typo" policy quietly becomes "mark your
own invoice paid", because RLS lets an update write any column the role may
write and only `with check` constrains the result.

**And a trigger, because RLS cannot say "this column may not change."**
`created_at` is what the five minutes is measured from, and nothing in the
policy stops it being *set* — a crafted update could write `created_at = now()`
on every edit and keep one invoice editable forever. `pin_invoice_facts` forces
`created_at` and `internal_ref` back to their old values on every update. That
is the right rule for everybody: when a row was created, and what its reference
is, are facts about it, not fields.

The app side: `stillCorrectable` decides whether Edit is *offered*, `useNow`
ticks so it disappears when the window closes, and the same sheet handles both
paths through one `buildInvoicePayload` — notes §1.3 is quoted in that file
twice because two write paths, one of them wrong, is the exact bug it describes.
A queued correction is told plainly that it may not apply: the window is
measured by the database, so an edit made in a dead spot and sent twenty minutes
later is refused, correctly.

### 34.9 Two people adding at the same time

Asked at the same time, and the answer is that it was already handled — this
section exists so nobody re-derives it.

- **The invoice id** is a client-generated UUID (notes §1.5), so two phones
  cannot collide, and a replayed offline write conflicts on the primary key
  instead of duplicating.
- **The reference** comes from `set_internal_ref`, whose counter bump is a
  single `insert ... on conflict do update ... returning n`. One statement, so
  the row lock is held for its whole duration. CATCH_UP_002 proved it with 50
  concurrent inserts producing 50 distinct references, and added a unique index
  on `internal_ref` as the backstop for whatever the next mistake is.
- **The caches are separate.** Each phone has its own optimistic entry and its
  own refetch; neither can overwrite the other's.
- **The one real contention** is two people creating the *same new supplier* in
  the same moment. `suppliers_name_ci` is a unique index on active names, so one
  insert wins and the other gets `23505` — already handled, already named:
  "There is already a supplier called Bidfood."

Two people entering *different* invoices is not a case the system has to handle
specially. It is the ordinary one.

### 34.10 Changing your own password

Asked for separately, and it applies to everybody, not only the shops. The
client's assumption was that he would still be able to see them; **he cannot**.
Supabase stores a bcrypt hash and no screen or API reveals a password. He can
set a new one from the dashboard, which makes him the reset desk — fine at six
accounts.

The part that mattered: `supabase.auth.updateUser({ password })` needs only a
live session and never asks what the old password was. Combined with §8's own
admission that an unlocked phone reaches the data, that is account takeover for
the price of picking up a phone. So the form re-authenticates with
`signInWithPassword` first. Supabase's own `reauthenticate()` is unusable here —
it emails a nonce, and two of the six accounts are shops with no mailbox.

Two deliberate omissions: it does not sign out other devices, because the other
device is the next shift and may be holding unsent invoices (§32); and it does
not touch the PIN, because the PIN locks a phone and the password establishes
who you are, and the last time two facts like that shared an owner, signing back
in walked straight past the lock.

### 34.11 Where it stands

- **Live and in use.** Deployed to production, `main` pushed, both venue
  accounts (GMP, GMH) created, the test account deactivated. `/venue` was
  confirmed on the deployed site: no session redirects to `/login?next=/venue`,
  the route serves, the guard holds.
- **Database:** `CATCH_UP_010`, `011` and `012` all run.
- **App:** `/venue`, `VenueChrome`, `AddVenueInvoiceSheet`, `VenueGate`,
  the venue chip, `PasswordChange`.
- **Tests:** 579, up from 532, under all three timezones. `tsc` and
  `next build` clean.
- **Verified against the live database.** `db/verify_staff.mjs` signs in as a
  real staff account and proves the boundary rather than asserting it: the view
  returns no payment columns (inspected on a real row, not assumed), every
  fenced table is refused, and the insert policy — not a foreign key — refuses a
  paid-injection and a forged `created_by` with `42501`.

  Two things that verification found, each its own catch-up:
    * **CATCH_UP_011** — `find_duplicate_invoices_staff` was callable by the
      anon key (revoked from `anon` but not from `public`, which is where the
      default grant lives). Not a leak — it returns nothing to an anonymous
      caller — but a missing lock on a door bolted from the other side.
    * **CATCH_UP_012** — the insert policy checked only the venue, so a crafted
      request could enter an invoice already marked paid, or forge who entered
      it. Closed by adding `created_by = auth.uid()` and `status = 'unpaid'` to
      the `with check`. Found by running the verification, not by reading it —
      two of the checks had been passing for the wrong reason.

  Both are run. The one residual gap in the proof: "cannot file against another
  venue" is caught by the ref trigger (`P0001`) before the policy is reached,
  so it is not isolated to the policy — the write is refused, just by a
  different mechanism. Getting `42501` there would need another venue's id,
  which a staff account cannot read. The outcome holds regardless.
- **Preview:** `test/preview-venue.test.tsx` renders the venue screen and its
  sheet to standalone HTML without a session, the same way §21.6 works. It is
  the only way to see these screens until the accounts exist.

### 34.12 The one open thread — a touch slower on a phone

Reported at the very end of the session, and deliberately **not acted on**: the
client was going to watch the pattern before any change, because the write
paths carry the offline-queue correctness (§4 rule 4, notes §1.4–1.6) and a
blind edit there is how that gets undone. Recorded so the next session starts
from the diagnosis rather than from scratch.

Measured, so the next person does not re-measure: the database is fast —
~45ms per round trip warm, with a single ~500ms cold-start on the first hit
after the connection has dropped. So this is network round-trips on the phone,
not the server, and not the venue work (which never touched the members' write
paths). Two post-deploy contributors are transient and self-clearing: the
cold-start, and the service worker re-caching the shell once after any deploy.

The mechanism, per path:

- **Mark paid** is already optimistic — `useMarkPaid.onMutate` strikes the row
  through before any network, so the tick itself is instant; only the
  confirmation toast waits a round trip. If the *strike* is what lags, that is
  a real regression to chase. If only the toast lags, it is inherent.
- **New invoice** closes the sheet and shows the optimistic row instantly —
  UNLESS an invoice number was typed, in which case `collectWarnings` runs the
  duplicate-check RPC *before* `onClose`, one blocking round trip with
  "Saving…" on screen. Spec §6 wants that warning before the commit, so making
  it non-blocking is a design change, not a perf tweak — do not do it silently.

The three observations that localise it are in HANDOFF's "Open thread". The
likely safe fixes, depending on which it is: warm the Supabase connection on
app open (helps only the cold-start, first-action case), or leave it (inherent
mobile latency). Do not reach for the write paths without the client's report
of which pattern it actually follows.

---

## 35. Round A — the figures became controls

Three items from the first round of real usage feedback. All three are app-only:
no migration, no policy, no write path touched, which is what made them safe to
run while the "feels slower on a phone" report (§34.12) was still outstanding.

### 35.1 The two headline figures did nothing when tapped

Reported as *"touch interactive for overdue or pending bills. Right now there
is no touch interaction"*, and the report is exactly right. `StatCard` was a
`<div>`. It sat above a list where every row expands, ticks off and opens — so
a card that did nothing did not read as a figure, it read as broken.

Both are `<Link>`s now, to the pending list already filtered to their own
window. Three things about that are decisions rather than mechanics.

**They link at zero too.** "Nothing late" opens a list saying nothing matches.
A control that is sometimes not a control teaches that the card is unreliable;
a dead end you can see the bottom of answers the question you asked.

**The window is in the URL, and the pills do not put it back.** §16's rule is
that a place you navigate to lives in the URL and a control you adjust does
not, and both halves apply here: arriving from a card is navigation, so
`/b/all/pending?due=overdue` is real, shareable, and Back returns to the
dashboard. Tapping a pill afterwards is adjusting a control on the screen you
are standing on — making that a `router.replace` would put a server round trip
in the middle of a filter and make Back step through pill states.

**The route unwraps it, not the screen.** `useSearchParams` in a client
component forces a Suspense boundary around the whole list, and worse, it
breaks the split HANDOFF §5 names: a thin `page.tsx` that awaits the route's
promises and a screen that takes plain values is what makes every screen here
testable by passing it a literal. The due window arrives the same way the scope
always has.

### 35.2 `overdueOnly` became `due`, and that is the point

The old filter was a boolean. A second boolean for the week would have been two
flags describing four states when three are real — and §19's account of this
build is that five of the eight bugs found on a phone were values able to hold
a state that should not exist. `DueWindow` is `'all' | 'overdue' | 'next7'`, so
"overdue and next 7 days at once" is unrepresentable rather than merely
unreachable.

**The window is computed by `urgencyOf`, not by a comparison that agrees with
it.** `summariseUrgency` buckets the two cards with `urgencyOf`; the filter
calls the same function. Two implementations that agreed on the day they were
written would eventually disagree about a boundary day, and the list would be
the one believed. `test/unit/select.test.ts` asserts the card total equals the
total of the list its own link opens, in both directions, over the 200-row
fixture — and verified in a browser at 360px: the Overdue card reads
$18,347.88 across 5 invoices, and `?due=overdue` shows 5 rows summing to
$18,347.88.

### 35.3 Edit and Remove existed and could not be found

Reported as *"Edit/Remove Supplier Options"*, which read as a request for
something missing. Both were already there: Edit was a 14px word inside a panel
four scrolls down, and Remove was a checkbox labelled **Active** inside the
form that Edit opened. Neither is a control anybody finds while looking for
one.

They are two buttons under the supplier's name now, and the same two under a
customer's. Nothing new can be done; it can be seen. The Details panel lost its
own Edit control rather than keeping a second one — two of them is two things
to keep in step, and the buried one was the one nobody found.

**Remove still writes `active = false`, and now says so before it happens.**
Rule 5 is not softened: every invoice references the supplier forever and a
hole in that is unrecoverable. What changed is that the word matches the intent
and the consequence is stated in a `ConfirmDialog` — "it stops appearing when
anybody adds an invoice", "nothing is deleted, and you can put it back from
here" — rather than being knowledge you had to already have about a checkbox.
A removed supplier's page offers **Restore** in the same slot.

### 35.4 A supplier's total between two dates

Asked for as *"an option within suppliers to check total pending between two
time periods"*. Two dates, a basis toggle, two figures and the invoices they
are made of.

**Two figures, not one.** Still pending and already paid, side by side. The
question asked was about money still to go; a single total that quietly mixed
it with money already gone would answer neither.

**The basis is a visible choice.** "What falls due in October" and "what they
billed us in October" are different questions with different answers, so due
date and invoice date are both offered and which one is showing is written on
the screen. Defaults to due date, because that is the question the rest of the
app is built around.

**It asks the database rather than filtering the array the page already has.**
`useSupplierInvoices` stops at 300 rows — generous for a page, silently wrong
for a question about 2024. A total over a truncated array is notes §3's
trust-destroying bug arrived at by arithmetic instead of by a second query, and
it would look right.

**And it asks for one row more than it will show.** If that row comes back the
range is wider than `SUPPLIER_RANGE_MAX`, and the panel says so instead of
reporting a figure it knows is short. A refused answer gets narrowed; a short
one gets written down.

The figures and the list under them come from the one array, verified in the
browser: the panel's pending figure equals the sum of the rows rendered beneath
it, no horizontal overflow, every control at the 44px floor.

This is also the first half of §33.2's export, and deliberately not the whole
of it. What a range answers on screen is worth having before deciding what a
file should contain.

### 35.5 Where it stands

- **Tests: 606**, up from 579, under `UTC`, `Australia/Sydney` and
  `America/Los_Angeles`. `tsc` and `next build` clean.
- **`test/preview-supplier.test.tsx`** joins the two existing previews. The
  supplier page is the densest screen in the app now and there was no way to
  look at it without a session and a real supplier.
- **Not deployed.** Every release is the client's to run (HANDOFF §3).

---

## 36. Round B — a shop's invoice waits to be let in

The client's instruction, in his words: *"whenever gmh or gmp adds an invoice,
then it has to be approved by one of the managements before it shows in the
pending or overdue"*.

Three more things ride along, because each database file is a round trip
through a person and all four belong to the same change: a venue can no longer
create a supplier, every entry sheet gets a note, and a sales invoice gets one
too. `CATCH_UP_013.sql` is the whole of it in one paste.

### 36.1 Approval is two columns, not a fourth status

`status` is unpaid/paid/void and it means **where the money is**. Review is a
different fact about the same row. One enum holding both has twelve
combinations where four are real, and §19's account of this build is that five
of the eight bugs found on a phone were values able to hold a state that should
not exist.

So `approved_at` and `approved_by`, and two constraints that make the nonsense
unwritable rather than merely unwritten:

- `approval_fields_consistent` — both or neither, the same shape
  `paid_fields_consistent` has had since migration 001
- `paid_needs_approval` — nothing unreviewed can be paid

The second is a **constraint and not a check inside `mark_invoices_paid`**,
because a constraint cannot be gone around. A check in the RPC is correct until
the day somebody writes a second way to mark something paid.

### 36.2 Who arrives approved is a trigger's decision

`stamp_approval` overwrites whatever the client sent, in both directions: an
invoice from one of the four is approved even if the app forgets to say so, and
one from a shop is not approved even if the app insists. Same reasoning as
`set_internal_ref` — if the client can send it, the client can send it wrong,
and a venue able to pre-approve its own entry would make the feature
decorative.

**The hole a policy could not close, and the trigger that already existed for
it.** `staff_update` lets a venue change its own invoice for five minutes, and
RLS lets an update write any column the role may write — so a crafted
correction could approve itself. `pin_invoice_facts` gained two lines. That
trigger exists because nothing stopped `created_at` being reset to keep the
five-minute window open forever (§34.8); it is the same class of problem and
the same answer. Two independent mechanisms now stop a venue approving its own
work — that trigger, and the fact that `RETURNING` applies SELECT policies,
which staff have none of.

### 36.3 The rule lives in one function, and the function was renamed

`onlyUnpaid` became **`onlyOwed`**, and the rename is the point. It now filters
on two conditions — unpaid, and approved — and a function called `onlyUnpaid`
that also checks approval is a function whose name is a lie. The next person
needing "just the unpaid ones" would have written their own filter rather than
reading this one.

**And `approved_at is not null` is in the query, not in a filter over the
result.** `useUnpaidInvoices` is what every owed figure in the app is made of;
filtering there means an invoice waiting for review cannot reach a total by any
route, including one somebody writes next year having never read this section.

The review queue is its own query over the other half, and it is the same
architecture §2 exception History already is: it feeds a count and a total that
no other screen has to agree with. Two disjoint queries, `status = unpaid`
split by whether `approved_at` is null — so no invoice can be in both.

### 36.4 The failure mode, and the card that exists because of it

This feature's failure is not a broken screen. It is an invoice a shop entered,
nobody reviewed, and which therefore appears in **no total anywhere** — money
the group owes that the app has quietly stopped mentioning. Every exclusion
above is deliberate and every one of them is a way that invisibility could
become permanent.

So the Review card sits on Home **above** the two figures it is missing from,
and it is present at zero saying "Nothing to review". A card that disappears
when empty is one nobody notices is missing when it should be there, and what
it would be hiding is somebody's invoice. The drawer's badge is the opposite —
drawn only when there is something, because a badge showing 0 is a badge people
learn to stop reading.

`test/unit/review.test.tsx` asserts the exclusion over the derive layer rather
than over a screen: the group total, both dashboard cards and every
per-business total are unchanged by adding four waiting invoices to the array.

### 36.5 Rejecting is voiding, and it needs nothing new

`void_invoice(p_id, p_reason)` already existed and already demanded a reason. A
rejected entry is a wrong entry, which is what void means, and rule 5 holds —
the row stays with the reason on it forever.

**The cost, accepted rather than missed:** `staff_invoices` excludes voided
rows, so a rejected invoice disappears from the shop's list with no explanation
the app will give. Somebody has to tell them or they will enter it again.
Showing them means editing the view whose `WHERE` is the entire venue boundary,
and §34's decision was to leave that alone. Reversible later without redoing
anything else.

### 36.6 The log learns the word

Without a named action, approving would have logged **nothing at all**: the
audit trigger records an update as `edited` with a diff of the fields it
tracks, `approved_at` is not one of them, the diff comes out empty and the
trigger returns early. The one action people will want to look up — who let
this in — would have been the only one leaving no trace.

Checked before `edited` and only in the null-to-set direction. Approval is not
reversible anywhere in the app or in these functions, and if that ever changes
it needs its own word rather than quietly reading as an approval.

### 36.7 A shop picks a supplier; it does not make one

*"Not allow staffs to create a new supplier... however if there genuinely is a
new supplier then they can at least leave a note."*

One dropped policy is the whole enforcement. What replaces the Add control is
**one placeholder row**, `Supplier not listed`, flagged by a column rather than
matched by name — a name is a string somebody can edit, and renaming that row
must not quietly turn it into an ordinary supplier four businesses start filing
against.

**Why a placeholder rather than "pick the closest real one".** A wrong
attribution is far harder to find later than a missing one. Nobody goes looking
for an invoice sitting under Bidfood.

Two consequences, both deliberate:

- **The note becomes required**, and it is the one blocking check in a sheet
  whose every other check is a warning. Spec §6 is emphatic that warnings never
  block — this is not a warning. An invoice against the placeholder with
  nothing written down is a record saying it arrived from nobody, and the shop
  is the only place that knowledge exists. This is the moment it is in the room.
- **It cannot be approved as it stands.** The review card opens a supplier
  picker instead, and Approve stays disabled. `Approve all` counts only the
  ones that are ready and says so.

`includePlaceholder` defaults to **off** everywhere and is true in exactly one
place, the venue sheet. The two mistakes are not symmetrical: a shop that
cannot see it is stuck for a minute; a member who files against it loses an
invoice in plain sight.

### 36.8 A note on every entry

`invoice_notes` has existed since migration 001 — table, index, RLS, hooks, an
offline key, and a `note` field in `invoiceFormSchema` since Phase 1. It was
never wired to the entry sheets. So most of this was connecting what was there.

**It costs the fifteen seconds nothing.** The note is a second queued write
sent *after* the invoice and awaited by nothing; the sheet is already closed.
Second because `invoice_notes.invoice_id` is a foreign key — a note sent first
has nothing to point at — and it queues behind the invoice offline, the same
ordering the supplier-then-invoice path has relied on since Phase 7. If the
invoice was refused, no note is sent: one failed write chasing another, and the
toast has already told the truth about the thing that matters.

**Staff may read only their own notes.** Deliberately not "every note on their
venue's invoices". Notes are free text written by people talking about money,
and one of them will eventually say "paid this on Friday". The whole venue
boundary exists to keep that sentence away from a shop; a notes policy is not
the place to hand it back.

A sales invoice gets a `note` **column**, not a second notes table. A payables
invoice is something several people discuss over a fortnight; a sales invoice
is a document you issue once.

### 36.9 What the browser found that the assertions did not

Both worth recording, because both were invisible to the DOM checks that passed
first.

The venue heading read **"GroceryMate Hu…"** beside a full-width "Approve all
2" at 360px — the one thing on the row that has to be read, losing to the
button. `min-w-0` was doing exactly what it was told. Fixed by shortening the
button's wording and dropping the heading to body size: it is a group label
above a list, not the heading of the page, and display size was costing 40px to
say something the name already says.

And the card's meta line ran off the end, taking the **due date** with it — the
field somebody reviewing is actually checking. Split into two lines, which then
left "Dated … · entered …" truncating mid-word, so the invoice date came off
the card entirely. It is on the full record. Review asks "is this real, who is
it from, and when is it out of the account", and the note, the due date and the
entry time answer all three.

### 36.10 Where it stands

- **Tests: 639**, up from 606, under all three timezones. `tsc` and
  `next build` clean.
- **`CATCH_UP_013.sql` has not been run.** Everything above is inert until it
  is: the columns do not exist, so the app's `approved_at` filters return
  nothing and the unpaid list would come back empty. **The file and the deploy
  go together, database first.**
- **`db/verify_staff.mjs` has not been re-run** and must be, after the file is
  applied. The `staff_invoices` view is untouched, but the staff surface
  changed three other ways: the supplier insert policy is dropped, two note
  policies are added, and `pin_invoice_facts` gained two lines.
- **`test/preview-review.test.tsx`** joins the previews. This screen cannot
  otherwise be seen until a shop has entered something nobody has approved,
  which is a state that exists only in production and only briefly.

---

## 37. Round C — a reminder at a time you choose

*"I would love to have an option to send the managements an alert at a time of
their choosing, as a reminder to check today's invoices."*

Separate from per-invoice push, and it does not replace it —
`notify_on_new_invoice` already exists per person in Settings, so anybody who
wants to stop hearing about every addition can turn that off with or without
this.

### 37.1 The uncomfortable part, which is not a bug

**This sends nothing to anybody until somebody turns push on for their own
phone.** `db/diagnose_push.sql` established that the whole chain is correctly
configured and that exactly one device is subscribed — Rabindra's — and the
builder is out of both notification audiences by design (§28.2). So the
per-invoice push has never had anybody to tell, and that is the decision
working, not a fault.

A reminder is different in one way that helps: it is addressed to **one person**
rather than to an audience, so `notify_push_one` does reach the builder and can
be tested end to end today. For Mani, Milan and Sujan the switch in Settings is
still what has to happen, and §28.4's decision is that the app never asks.
Somebody has to tell them it is there.

### 37.2 Null is off, and there is no second flag

`profiles.reminder_time` alone decides both when and whether. A time plus an
`enabled` boolean is two values describing three states when two are real, and
the pair can disagree — "on, at null o'clock" is a state somebody eventually
writes a branch for. §19's pattern at its smallest scale.

`reminder_last_sent_on` sits beside it and is a different kind of thing: it is
the job's bookkeeping, and it is what makes a cron running every ten minutes
send one reminder rather than eighty. It is deliberately **not** in the column
grant and not on the `Profile` type — a person who could clear it could make
the reminder send again.

`reminder_time` **is** in the grant, alongside `notify_on_new_invoice`, and both
are named in one statement. `grant update (a)` then `grant update (b)` is
additive, but two statements a year apart is how somebody concludes the second
replaced the first and tidies it away.

### 37.3 `TimeStr`, and why it is a string

A time of day is a **wall clock, not an instant**. Half past eight in Sydney is
half past eight regardless of what machine is asking, which is exactly what a
`Date` takes away — and takes away silently, on a value nobody thinks to test
at 23:00. So `TimeStr` is `'HH:MM'`, compared as a string, never parsed, the
same shape `DateStr` has had since §3.

`formatTime` does the 12-hour conversion by arithmetic rather than reaching for
`Intl`, because `Intl` would need a `Date` to format and building one from
`'HH:MM'` means choosing a date — the operation §3 bans outright. Its tests run
under all three timezones like everything else, which is the point: if it ever
reaches for a `Date`, one of the three fails.

Seconds are deliberately absent. Postgres `time` accepts them and the app never
produces or reads them; a value with seconds is one somebody put in by hand.

### 37.4 One person, not an audience

`notify_push` picks its targets from a view and excludes the actor, which is
right for "somebody added an invoice" and wrong for every part of this — a
reminder has no actor and exactly one recipient. Bending the audience views
into that shape would give the codebase a view that is sometimes an audience
and sometimes a person.

So `notify_push_one` reads `push_subscriptions` directly, and per-person
targeting is true by construction rather than by a `WHERE` clause somebody
could widen.

### 37.5 It sends every day, whether or not anything happened

A reminder that appears only when there is news is an **alert**, which is a
different thing and not what was asked for. "Nothing logged today" is
information: it is how you find out a shop forgot, which is the one case a
notification about new invoices can never tell you about.

The body carries the three figures the dashboard answers, in the order they
matter at the end of a day — what came in, what is waiting on you, what is
already late:

> **Today's invoices** — 4 logged today · 2 to review · 5 overdue

### 37.6 Staff are excluded by an allowlist, again

The loop selects `role in ('member', 'owner', 'builder')`. Written that way for
the reason CATCH_UP_010 §6 gives in full: three blocklists spelled
`role <> 'builder'` would each have silently admitted the venue accounts on the
day they were created. Nobody would have written that bug; it would simply have
happened.

The builder **is** included, and that is not an inconsistency with §28.2. He is
out of the two audiences, which are about being told what other people did. A
reminder is a personal alarm somebody set for themselves.

Two independent mechanisms keep it away from the shops: that allowlist, and the
fact that Settings hides the whole Notifications section from a venue account.
Neither relies on the other.

### 37.7 Every ten minutes

Finer than the minute the app offers would buy nothing; being up to ten minutes
late on a reminder to check the day's invoices costs nothing that six times the
scans would recover. The three counts are computed once per run rather than once
per person — four people is four identical scans otherwise.

`pg_cron` has to be enabled in the dashboard, and the schedule is the **last**
section of the file for that reason: everything above it applies first, so an
unenabled extension costs a second run rather than the whole paste.

### 37.8 Where it stands

- **Tests: 651**, up from 639, under all three timezones. `tsc` and
  `next build` clean.
- **`CATCH_UP_014.sql` has not been run**, and needs `pg_cron` enabled first.
  Unlike 013 it is safe in either order with the deploy: the app only ever
  reads and writes `reminder_time`, so before the file the field simply fails
  to save, and after the file with no deploy nothing has set a time.
- **§7 of the file** sets a time, clears the stamp and calls the function by
  hand, so it can be proven without waiting for tomorrow.

---

## 38. Round D — Deli issues an invoice it can print

*"We add/select a supplier. We add list of products (will be added with prices,
also an option to add/edit those). Then all the added products will show an
invoice. Then there is an option to export, that exported will be printed."*

One correction to the vocabulary, because it decided which table this landed
in: on this flow Deli is **selling**, so the other party is a customer and the
record is a `sales_invoice`. Both already existed (§17, migration 009). What
that ledger never had was line items or a document.

Two decisions the client took, recorded so nobody re-derives them: a **plain
invoice**, no GST and no ABN; and the **app numbers them**, `DDL-0001`.

### 38.1 The description and the price are copied onto the line

The obvious schema is a `product_id` and a quantity, and it is wrong for a
document. Raise a price next month and every invoice printed last month
silently reprints at the new one — a piece of paper somebody is holding stops
agreeing with your copy of it.

A printed invoice is a claim about a moment. So the line carries what was
charged, and `product_id` is kept only to answer *which product was this*,
nullable for the one-off line that is not a product at all.

That is also what makes the products screen safe to use: changing a price there
changes what the **next** invoice suggests and nothing already issued.

### 38.2 Quantity is integer thousandths

Rule 6 makes money integer cents because floats drift and then people argue. A
quantity multiplies that money, so a float here reaches the total by the same
route with the same result — `1.1 * 3` is 3.3000000000000003, and a line on a
customer's invoice cannot fail to add up.

Thousandths rather than hundredths because the unit is not always money-like:
1.5 kg, 0.25 hours, 12 boxes. `lib/quantity.ts` is `lib/money.ts` one column
over, with the same two boundaries and the same refusal to coerce.

**`formatQuantity` trims trailing zeros, and money never does.** "12.000 boxes"
reads as a measurement taken to three places, which is a claim the docket did
not make.

### 38.3 One calculation, written twice, pinned together

`lineTotalCents` exists in TypeScript and again inside `create_sales_invoice`,
because the total on a document handed to a customer cannot be whatever the
client said it was. Two implementations of one calculation is notes §1.3 — "two
paths that built a record, one of them wrong" — so they are pinned deliberately:

```
here:  Math.round(quantity_milli * unit_price_cents / 1000)
SQL:   round(quantity_milli::numeric * unit_price_cents / 1000)
```

`test/unit/quantity.test.ts` holds a table of ten cases including both rounding
directions, and **the same table is repeated in the SQL file's verification
query**. The agreement is proven on both sides rather than assumed on one. If a
row is added to one it goes in the other.

The table earned its keep immediately: it caught a wrong expected value in its
own first draft.

### 38.4 A blank price is not a price of zero

Both are needed and they are different facts. Blank means somebody is still
typing, and a line still being typed must not join the running total — it would
make the figure flicker downward as they work. A typed `0` is a real thing: a
sample, a replacement, a line that carries a description and no charge.

`parseAmountToCents` refused zero outright, because `invoices.amount_cents` has
`check (> 0)` and an invoice for nothing is a mistake. So it gained an
`allowZero` option rather than a sibling function — **a second money parser is
notes §1.3 with the stakes at their highest.**

### 38.5 One write path, and the schema bump that cost

`create_sales_invoice` is one RPC, one transaction, and it computes
`amount_cents` from the lines it was sent. A header and its lines that disagree
is a document that lies about itself, and it gets handed to somebody.

An invoice with **no** lines still uses the amount the app sent — that is the
"record one we already sent" path, which predates line items and still works.
One branch, in one place, is the whole difference between the two shapes.

The alternative was a second mutation key for the new shape, leaving both. That
is two paths building one record. So: one key, one shape, and
**`OFFLINE_SCHEMA` went v1 → v2** — which discards anything queued on a phone
when that build loads. The cost was paid knowingly and is written into
`lib/offline/keys.ts`: deploy it when nobody is mid-entry somewhere without
signal.

### 38.6 Numbering counts upward forever

`set_sales_invoice_number` is the race-free counter `set_internal_ref` has used
since migration 002 — one `insert ... on conflict do update ... returning`,
resolved under Postgres' own row lock, with a unique index as the backstop.

Different in one way that matters: this counter is per business and **not per
day**. An internal ref is a label; a number a customer quotes back at you
should count upward forever, not restart every morning.

A number typed by hand is left alone, and §7 of the file sets the counter once
if Deli has been invoicing on paper and wants the app to carry on from 119.

### 38.7 The page prints itself

The client's word was "export", and on a phone the answer is the browser's own
print dialog: AirPrint on iOS, Save as PDF everywhere. No PDF library — rule 7,
and this one would replace something every device already has and does better.

**The chrome is marked and removed; the document is not rebuilt.** Two copies
of one invoice in a file drift, and the one that drifts is the one nobody looks
at on screen.

### 38.8 The bug that only existed on paper

The print rules first targeted `header[data-app-header]` — an attribute nothing
in this app has. So the hamburger, the back link and the header icons printed
across the top of every invoice, and **nothing on screen could have shown it**,
because the rule only exists in `@media print`.

Found by lifting the print rules out of their media query in a browser and
looking at what was left. The fix puts `no-print` on the element itself rather
than a selector guessing at it, and `test/unit/sales-invoice.test.tsx` now
asserts the header carries it — the only kind of check that catches a rule
which is invisible until it is on paper.

### 38.9 Where it stands

- **Tests: 689**, up from 651, under all three timezones. `tsc` and
  `next build` clean.
- **`CATCH_UP_015.sql` has not been run.** Like 013, the app half is inert
  without it and worse than inert: `create_sales_invoice` does not exist, so
  recording ANY sales invoice — including the old flat path — fails until it
  is applied. **Database first, then deploy.**
- **`test/preview-sales.test.tsx`** renders the document and the composer to
  standalone HTML. The document cannot otherwise be seen without a customer,
  products and an issued invoice.
- **Not built:** a global list of issued invoices. They are reachable from each
  customer, which is where somebody looks for one. Worth adding when there are
  enough of them that a customer is the wrong index.


---

## 39. Round E — the price list is the compose screen

Two reports, one sentence each, and both were about the same thing being in
the wrong place:

> "cant go to deli > customers > selected a customer > new invoice for the
> customer. doesn't wrk"

> "still no option to create invoice. I want to be able to issue an invoice
> when I am in the deli's interface."

With a photograph of somebody else's ordering screen: a plain list of stock —
Sliced Swiss Browns, Flat White Mushrooms, Green Capsicum — each row a name,
a unit, and a `−  0  +` stepper, with a pencil and a cross on the end.

### 39.1 What "doesn't work" actually was

Neither report was a crash, and looking for one cost time. `/sales/new` built,
rendered and saved. The deployed build was current — checked against
`vercel ls`, not assumed.

**The link was the defect.** `CustomerDetail` offered *"+ New invoice for this
customer"* and navigated to `/sales/new` **with no customer on it**. You
arrived at a screen whose first field said "Choose a customer". The label made
a promise the destination did not keep, and "doesn't work" is the correct
verdict on that — notes §6, do not offer what cannot be done, of which this is
the softer cousin: do not offer what will not be honoured.

Fixed by putting the customer in the query string, `/sales/new?customer=<id>`,
unwrapped in the route and handed to the screen as a plain string — the same
split every dynamic route here uses, HANDOFF §5.

### 39.2 A menu row is not an answer to "in the deli's interface"

Round D's follow-up put *New invoice for a customer* in the side drawer,
because the previous report was "I could not find create invoice feature".
That was still true afterwards, and the reason is in the second report's own
words: **the client is standing on Deli's screen when he goes looking.**

`/b/ddl` already carried a Customers link, on the reasoning that Deli is the
only business that sells. Issuing an invoice belongs in exactly the same place
and belongs first, because it is the verb. `/b/ddl` now leads with **New
invoice for a customer**, then Customers, then Products.

The drawer row stays. A thing reachable from two places is not duplication
when one of them is where somebody actually stands.

### 39.3 The screen rebuilt around the list

The old composer asked you to add an empty row, choose a product into it from
a `<select>`, then type a quantity — three taps and a native picker per item,
with the list of what Deli sells hidden inside the picker. The client's
photograph is the correction: **the stock list IS the screen.**

So every active product renders as a row with a stepper, and:

**Quantity is the only state a row has.** A product with a quantity is on the
invoice; a product on zero is not. There is no second "added" flag to
disagree with it. This is §19's shape lesson applied before the bug rather
than after it — the two-fields-that-can-disagree failure is simply not
representable.

One array still holds every line (rule 4). Product rows are matched to it by
`productId`; the "Other lines" section below is the same array filtered to
lines with no product. The footer total is `useMemo` over that one array, so
the figure about to be printed is the sum of what is on screen.

### 39.4 Two prices, named separately

The pencil opens both edits somebody wants mid-docket, under two headings:

| | reaches |
|---|---|
| **On this invoice** | this line, this piece of paper |
| **In the price list** | what the NEXT invoice suggests, and nothing issued |

They are deliberately not one Save. The price list rewritten by accident, by
somebody correcting one docket, is the kind of thing nobody notices for a
month. `test/unit/sales-invoice.test.tsx` asserts that changing the line price
never calls `useUpdateProduct`.

**+ Add a new product** creates it in the price list and puts one on the
invoice from the values typed — not by waiting for the list to come back,
which offline it never would.

### 39.5 The zero that is not a zero

`parseQuantityToMilli` answers `null` for both `"0"` and `"1."`. One is a
settled zero and one is somebody halfway through typing 1.5, and they must be
treated **oppositely**: the first takes the row off the invoice, the second
must leave it exactly where it is. Nothing downstream can tell them apart, so
`meansNone()` separates them once, at the top.

Stepping works in thousandths and formats back out rather than operating on
the string: `"1.5"` plus one is `"2.5"`, never 2.5000000000000004. Which is
what `lib/quantity.ts` exists for.

### 39.6 Two lines per row, and the four pixels

Measured, not eyeballed — HANDOFF §5, and it found a real defect twice before.

On one line the row spends **224px of a 375px phone** on controls before the
name gets a pixel, because `touch` sets a 44px minimum on every one of them.
The name was measured at **66px**: enough for "Momo (...", nowhere near enough
to tell *Sliced Swiss Browns* from *Flat White Mushrooms*. A price list you
cannot read is not a price list.

So the name owns a full-width line and the controls own the one beneath it.
That still left the unit and price with 54px for something needing 58, which
truncated `kg · $14.50` to `kg · $14...` — losing the price off a price list.
The four pixels came out of the gaps (`gap-2` → `gap-1`), never out of the
targets.

`test/preview-sales.test.tsx` now uses the client's own names as its fixture,
and writes a second page mid-docket — a row switched on and a pencil open —
because the resting state hides half the screen.

### 39.7 Where it stands

- **Tests: 701**, up from 697, under all three timezones. `tsc` and
  `next build` clean.
- **No database change.** Nothing in this round touches the schema, so this
  deploy has no SQL to run before or after it.
- **Not built:** removing a product from the price list is still on
  `/products` rather than on the cross here. The cross takes something off
  *this invoice*; deleting from the list is a different act with a different
  blast radius and it keeps its confirmation dialog.

### 39.8 The crash underneath all of it — `null` is a real render

Everything above shipped, and the screen still showed **"This screen didn't
load"** by every route in. The placement work was real; it was not the bug.

`useSydneyToday()` returns **null on the first render**, by design (§3): the
server cannot know what day it is where the phone is standing, so the date
arrives one frame later. The composer folded that into `|| ''` and then, in
the due-date presets, called `addDays('', days)` **during render**. `addDays`
asserts `'YYYY-MM-DD'` and throws. The screen died before painting a pixel,
every single time, and the error boundary said so.

It had been there since Round D. Both reports — "doesn't work" and "still no
option to create invoice" — were this. The customer-less link and the missing
menu row were real defects sitting on top of a screen that could never have
opened.

**Why nothing caught it.** Both test files mocked the hook to a fixed date:

```ts
vi.mock('@/hooks/use-sydney-today', () => ({ useSydneyToday: () => FIXTURE_TODAY }));
```

So the first render every real phone performs was the one state no test could
reach. The preview harness pinned it the same way, so looking at the screen
could not show it either. **A fixture that cannot produce a real state is a
fixture that guarantees bugs in it** — the sibling of §6's "a fence proven to
keep things out has not been proven to have a gate".

The mock is now a knob, `mocks.today.current`, defaulting to null; five tests
render the cold frame, and the preview writes `-compose-cold.html`.

**The fix is the type, not the branch.** There were three unguarded calls and
the next person adds a fourth, so `issuedOn` and `dueOn` are
`DateStr | null` and `tsc` refuses to let null reach `addDays`. The date state
is nullable too, validated with `isDateStr` at the input's edge, because a
cleared date field hands back `''` — the same empty string, by a second route.

Every other consumer of the hook already guarded (`today ? … : …`). The
composer was the only one, and it was the only screen anybody said was broken.

### 39.9 A door between the two sales paths

`AddSalesInvoiceSheet` — the `+` on Deli's screen — records an invoice that
already exists, as one amount. Somebody setting out to *build* one lands
there, finds a box marked Amount and no products, and concludes there is no
way to make one. Reported twice, and the sheet now opens with a link across to
`/sales/new`.

Two paths that both produce a sales invoice is not duplication: one writes
down a total from a docket, the other adds the docket up. What was missing was
a door between them at the moment the wrong one has been opened.

### 39.10 Where it stands, corrected

- **Tests: 706**, under all three timezones. `tsc` and `next build` clean.
- **No database change** in this round.


---

## 40. Round F — the receivables side grows up

Six items, from a phone, with two screenshots marked in red.

### 40.1 A due date is now a choice, and the default is no

> *"Need to add a toggle switch next to due date. off by default. we don't
> want to issue due dates yet."*

Deli is invoicing before it has agreed terms with anybody. A due date filled
in on its behalf is not a harmless default: it prints a deadline nobody set,
and underneath that it drives **every overdue figure in the app** off a date
that means nothing. "$1,200 past due" is the one sentence this app exists to
be trusted about.

The tempting version keeps the column NOT NULL and has the screen hide the
date it stored anyway. That is notes §1.3 exactly — a record saying one thing
and a screen saying another — and the hidden date would still have driven the
chasing. So `CATCH_UP_017` drops the NOT NULL and the absence is recorded as
an absence.

`create_sales_invoice` needed no edit: it already writes
`(p_invoice ->> 'due_date')::date`, and `->>` on a JSON null yields SQL NULL.
The constraint was the only thing refusing it.

`SalesInvoice.due_date` became `DateStr | null` and `tsc` named all five
places that had assumed otherwise — the same device as §39.8, used
deliberately this time rather than in a panic. What each of them now does:

| | |
|---|---|
| `summariseReceivable` | counts in the total; in **neither** overdue nor oldest-due |
| the row's urgency chip | absent, rather than coloured 'later' |
| the printed document | no "Due" heading at all, rather than a blank under one |
| the receivables sort | last, ascending — no agreed deadline is not urgency |
| the expanded bill | says "No due date" in words |

A deadline nobody set has not passed. That sentence is the whole of it.

### 40.2 A `+` on top of the Save button

Photographed: the floating `+` sitting across "Save & print" on the compose
screen — a button offering to start a second invoice, covering the button that
finishes the first.

`AppChrome` gained `add="none"`. The prop already carried the argument in its
own comment — *"Never both: two controls doing one thing, one of them
overlapping the other, is worse than either"* — and a screen that IS the act
of adding something is the case it had not anticipated.

### 40.3 Deli's card leads with Receivables, not with the composer

> *"remove new invoice for a customer option from the deli delights customers
> and add Receivables in there to track the pending receivables"*

Round E put the composer on `/b/ddl` after two reports of not being able to
find it. He is right that it does not belong there: **a business card is a
place you stand, not a thing you do.** An invoice starts from the customer it
is for, which is the flow he described in the first place, and the `+` asks
which ledger you mean. What belongs on the card is the money still out.

`/receivables` is the list HANDOFF §7 held as *"worth adding when a customer
becomes the wrong index, not before"*. It became the wrong index the moment
chasing was the job: that is done across every customer at once, and from the
customer list it means opening six pages to find the two with anything in them.

The screen is PendingList's shape one ledger over — a total derived from the
array beneath it, three sorts, rows that open. The drawer keeps both rows;
`sellsAsWell` grew to cover `/receivables` and `/products`, because a `+` that
opens a *supplier* sheet while you are standing on what customers owe you is
the wrong ledger entirely.

### 40.4 The row is the way in

> *"intuitively we tend to tap any invoices (receivables or payables), so I
> would want it to expand into its bill and show the details. Specially
> relevant in deli delights case."*

**The payables side already worked exactly this way.** `InvoiceRow` is a
full-width button with `aria-expanded` that opens a detail block in place. The
sales rows were the odd ones out: the invoice *number* was a link and the rest
of the row was dead, so the tappable part was the smallest text on the line.

"Specially relevant in deli delights case" is the sharp end. A payables row is
one amount from one supplier; a Deli invoice is a docket of products, and the
question you have looking at one is *what was on it* — reachable only by
leaving for the print view.

`SalesInvoiceRowItem` is the mirror, shared by the customer page and the
receivables list. It fetches its lines **only when opened** (`useSalesInvoice`
is disabled on `''`): thirty invoices must not be thirty line queries on
arrival, and until somebody taps a row nobody has asked what is on it.

### 40.5 The button that removed itself

> *"not sure why there is received in there. Remove that."*

Circled in red: a **Received** pill on every outstanding row, sitting exactly
where a chevron belongs. Two things were wrong with it and only one is
obvious. It was a one-tap way to write off money on whichever row you happened
to be looking at — and it made the row read as a *control* rather than as
something you could open, which is why the expanding behaviour of §40.4 had
never occurred to anybody as missing.

Marking one received now lives inside the invoice, after you have seen what is
on it. The undo path is unchanged.

### 40.6 Details folded, history promoted

> *"hide the contact, phone and email within the details ... and underneath
> the details, add in the history of this particular customer to see past
> payments received."*

Three rows reading "—" were the top third of the page saying nothing and
pushing **Owes us** below the fold, on the page whose whole purpose is that
figure. Both panels collapse, and both say what is behind them: the Details
row shows the phone number itself, History shows what has been received and
across how many invoices. A collapsed panel with a generic label is a panel
nobody opens, because there is no way to tell whether it holds anything.

History moved up from the very bottom, under the outstanding list, which was
the wrong way round: *have they ever actually paid us* is a question you ask
before deciding what to do about what they owe.

> *"also, contact is essentially phone, no?"*

Nearly, and the fact that it was worth asking is the defect. Contact holds a
person's NAME — who you ask for when you ring. The field is labelled
**Contact name** now, in the form and on the row. A field labelled by its role
rather than its content is a field that gets filled in wrongly.

### 40.7 The mark on the document

> *"when we add in the logo for deli, I would like that logo to show up in the
> invoice (not sure if it already does)"*

It did not. The document header carried the business *name* and nothing else.

`BusinessMark` already resolves an uploaded logo over a bundled file over the
letters (§30.2), so putting it at the top of the document means **the day
Deli's artwork is uploaded on the Brand screen it appears on every invoice
with no code change** — including invoices already issued, because the
document is rendered from the row rather than stored. Until then the header
carries "DD" rather than a hole where a logo will go. `size="lg"` (48px)
exists for this: everywhere else the mark identifies a row at 24–28px, here it
is the top of a piece of paper somebody is handed.

### 40.8 Where it stands

- **Tests: 719**, under all three timezones. `tsc` and `next build` clean.
- **`CATCH_UP_017.sql` must be run BEFORE the deploy.** It only ever makes the
  column more permissive, so the live app keeps working the moment it lands.
- **`test/unit/customers.test.tsx` now writes previews** — the customer page
  shut, the customer page with all three panels open, and the receivables
  list. Both screens were rebuilt off a marked-up photograph and both are
  dense; that is the shape where a passing assertion and a usable screen come
  apart.
- **Not changed:** payables rows, which already expanded on tap. The report
  named both directions; only one of them was actually missing it.


---

## 41. Round G — the design, and why the app felt slow

Five items, after *"using for a fair bit"*, with a two-screen design attached.

### 41.1 The date came off the home page

> *"remove the date from the home page, looks cluttered with so many things
> going on. Center aligned greeting and name."*

It was the one line on that screen answering a question nobody had — **the
phone's own clock is two centimetres above it, permanently.** Every other date
on the home screen is attached to an invoice, which is a fact about the
invoice rather than about today.

Centring the greeting also gave it a job: it is the lid of the page now,
rather than a left-aligned label competing with four left-aligned figures.

### 41.2 The dark band, and two tokens instead of one

The design puts the header and the total-outstanding card on deep green. Both
use a new `--hero` family, **not `--brand`** — brand is the PWA splash and
browser-chrome colour and has to keep matching the installed icon exactly, so
it was not available to be nudged for a header. Two tokens because they answer
two different questions.

Measured on `--hero` (#05412a), because that is what this file is for:

| | | |
|---|---|---|
| `--hero-text` | #ffffff | 11.69:1 |
| `--hero-muted` | #b8d6c4 | 7.49:1 |
| `--hero-line` | #1d5b41 | 1.46:1 — **never text**, rules and icon wells only |

`--hero-muted` is deliberately not 50% white, which resolves to #82a094 and
measures 4.12:1 — under AA on exactly the small uppercase labels that say what
each figure means.

A dark header costs every control inside it. `ConnectionStatus` and the
`ActivityBell` button both used `text-muted`, which is 1.9:1 on this ground;
both now take the light pair, while the bell's dropdown panel keeps its own
colours because it is still a white card.

**The hero figure is the same number as before.** It is `summary.total_cents`,
which the "Invoices overview" row at the bottom of the same screen has always
shown, promoted to the top — same array, rule 4, so there is still exactly one
total outstanding in this app. It scales to its own card with `cqw` like
`StatCard` does, at `0.72` rather than `0.58` because it shares its row with a
44px icon well; measured at 39px against a 12px clearance on the widest
fixture.

### 41.3 Attribution on the side that issues

> *"Added by indicator needed on issued invoices too. and indicator of who
> Marked it paid as well."*

Spec §9 makes the chip permanent and says it appears everywhere the invoice
appears afterwards. `InvoiceRow` has done that for payables since Phase 2 —
and `InvoiceDetail` has said "Paid by X" since Phase 4. **Sales invoices never
got either.** Both facts were on the row the whole time (`created_by`,
`received_by`) and were being written correctly; nothing was ever showing them.

The chip is in the same position and at the same size as the payables one, so
the two ledgers read as one app rather than two screens sharing a header.

The test asserts on the person's **name**, not their initials: `PersonChip`
renders a photograph where there is one, so an initials assertion would pass
or fail depending on who happens to have a picture. The name is what both
branches put in the accessibility tree.

### 41.4 The menu row that was a verb

> *"Remove new invoice for a customer option on side menu. The plus button
> does it all."*

Right, and worth recording why. **Every other row in that menu is a place.**
That one was the only verb, which is why it never sat right — and the `+` is
global (§16) and now asks which ledger you mean on Deli's screens, so the
composer is one tap from anywhere, from a control that is always in the same
corner. A menu row pointing at the same place is a second door onto one room.

`activeSection('/sales/new')` now returns `null` rather than lighting
Customers. Highlighting a section you did not arrive through is the menu
telling you where you are *not*.

### 41.5 "It doesn't feel smooth" — mostly not the animations

> *"Could we also work on better animations please. it doesnt feel smooth."*

The instinct is to reach for the keyframes. Two of the four causes were not
animation at all:

1. **`touch-action: manipulation` was missing.** Every button in this app was
   waiting ~300ms for a possible double-tap-to-zoom before dispatching a tap.
   **No amount of animation work can cover a delay that happens before the
   animation starts.** This is the single biggest item in this section.
2. **Chrome's grey tap flash** fired instantly, squarely on top of the
   considered 140ms pressed-state transition. The animation was being drawn
   over by a hard flash on every press. Removing it is only safe because every
   pressable thing here has its own `:active` state — this deletes the second,
   uglier copy of the feedback, not the feedback.
3. **Push and pop had no opacity.** They animated transform alone, so the
   outgoing screen vanished on the same frame the incoming one began moving: a
   hard cut with a slide bolted onto it. The eye sees the cut, not the 300ms of
   easing after it. They cross-fade now, and the distance came down from 28px
   to 16px — a long slide is only smooth if the frames underneath it are cheap,
   and these screens are doing a React render and a query resolve in the same
   window.
4. **Round F's four expanding panels appeared instantly.** Next to a 300ms
   screen transition that reads as the app stuttering rather than as it being
   fast. They fade and rise 4px now.

`translate3d` replaced `translateY`/`translateX` throughout, to hold the
compositor layer for the whole run rather than promoting and dropping it at
the seams.

**Height is deliberately not animated** on the panels. `auto` cannot be
interpolated without measuring, and measuring a panel of unknown length on
every open is exactly the main-thread work that causes the jank it would be
trying to hide.

### 41.6 Where it stands

- **Tests: 729**, under all three timezones. `tsc` and `next build` clean.
- **No database change** in this round.
- The preview harness now covers the dashboard, the customer page shut and
  open, and the receivables list — all four were checked at 375px and 360px
  with no clipping and no horizontal scroll.


---

## 42. Round H — the band settles down

Five small things, after looking at Round G on a phone.

### 42.1 The Himalaya, drawn rather than photographed

> *"add the mountain ranges in the background. himalayas."*

An inline SVG, a few hundred bytes, right on every screen and every density.
A background photograph would be a network request arriving after the header
has already painted, and it would cost everybody data on shop wifi for
scenery. Same argument `lib/logos.ts` makes about explicit tables.

Two ranges, the far one lighter, because one silhouette reads as a shape and
two read as distance.

**The placement is the whole of it, and the first attempt was wrong.** Proper
peaks across the middle of the bar landed squarely behind the wordmark and the
three icons — a mountain behind a letterform is what makes a header look
cheap. A 56px bar has no room *above* its controls, so the range became a
horizon *under* them: the same scenery, in the only band of this header that
is actually empty. Two small snow caps, and nothing else.

`--hero-ridge` is 1.24:1 on `--hero`. That is deliberate and it is never text:
a range you notice only if you look for it.

### 42.2 The strapline came off

> *"remove the manage track get paid. just have it as SHG invoices."*

It lasted one round. Right, and it is the same argument the app keeps making
about itself: **a strapline sells the product to somebody deciding whether to
use it, and everybody who sees this header decided months ago.** It was the
only line in the app addressed to a visitor rather than to the four people who
work here.

### 42.3 Toned down

> *"tone down the greens on the outstanding and header a bit."*

`--hero` #05412a → **#1a5540**, same hue with the chroma pulled back, so the
band reads as a surface rather than as a block of colour.

| | before | after |
|---|---|---|
| `--hero-text` #ffffff | 11.69:1 | **8.69:1** |
| `--hero-muted` #b8d6c4 | 7.49:1 | **5.57:1** |

Both still pass AA comfortably. The point of recording both columns: this
spends contrast that was **surplus**, not contrast that was doing work. There
is no room to do it a second time — another step of this size puts
`--hero-muted` under 4.5:1 on the small uppercase labels, and those labels are
what say which figure you are looking at.

### 42.4 The review card is off the home screen

> *"Remove nothing to review from homescreen. if someone adds a bill, it will
> be shown in the notification anyways, also there is a review panel in the
> side menu. archive it, if we miss it we will bring it."*

**This one had a written argument behind it, so here is the argument and why
it lost.** §31 put the card above the two figures and made it present at zero,
on the reasoning that an invoice a shop entered and nobody looked at is in no
total on any screen — so the one way it stays invisible is by nothing
mentioning it, and a card that vanishes when empty is one nobody notices is
missing.

That was written when the card was the only mention. It no longer is: the bell
announces a new entry, the drawer carries a count badge, and Review is its own
menu row. He is right.

**The risk, on the record: all three of those require somebody to look.** The
card was the only one that spoke without being asked. If entries start sitting
in review for days, this is the first thing to bring back — and the comment
where it used to sit says exactly what it was, so that is a paste rather than
a rebuild. `test/unit/dashboard.test.tsx` asserts it is gone, so anybody
re-adding it reads this section first.

`useAwaitingReview` is no longer called on the dashboard — one fewer request
on the screen the app cold-starts to. The drawer still calls it.

### 42.5 The outstanding box, tidier

> *"Keep the box size similar but reduce the font size a bit."*

The figure's ceiling came down from `--text-total` (44px) to `--text-h1`
(28px), and the card's vertical padding went up to hold its height — 107px,
against 111px before. At 44px a six-figure total filled the card edge to edge
and the label and count around it read as captions on a poster.

### 42.6 Where it stands

- **Tests: 731**, under all three timezones. `tsc` and `next build` clean.
- **No database change** in this round.


---

## 43. Round I — the shop edit boundary, and an audit from scratch

Two jobs: close the last open defect, then audit the whole application as
though nothing in this file could be trusted.

### 43.1 A shop is only offered Edit on its own entries

The last item on the open list, held since the venue accounts shipped so it
could be batched with other SQL.

`staff_update` allows a correction only when four things hold. The app gated on
one of them:

| condition | who checked it, before |
|---|---|
| `business_id = staff_venue()` | structural — the view returns nothing else |
| `created_by = auth.uid()` | **nobody** |
| `status = 'unpaid'` | deliberately nobody, see below |
| `created_at > now() - 5 min` | `stillCorrectable` |

So a shop was shown an Edit button on invoices one of the four had entered for
that venue, and tapping it was refused. Notes §6: do not offer what cannot be
done. **Nothing was ever at risk** — the policy refused every one of them —
which is why this was an honesty fix rather than a security one, and why it
was safe to batch.

`CATCH_UP_018` adds `is_mine` to `staff_invoices`. **A boolean, not
`created_by`**: the obvious fix exports the user id of whichever of the four
entered each invoice so a screen can answer one yes/no question. The
comparison happens in the view, where the answer is already known.

Payment stays invisible on purpose. A shop cannot be told an invoice is paid
(CATCH_UP_010 §3), so it cannot be told that is why editing stopped. Inside
five minutes of entry, one of the four having already paid it is close enough
to impossible, and if it happens the save is refused with the same sentence as
every other refusal.

The column is appended, because `create or replace view` may only add columns
to the END of the list.

### 43.2 The audit

Run against the live database and the working tree, without relying on
anything already written in this file. What follows is everything it produced,
including the checks that passed — a list of only the failures would not tell
anybody what was actually looked at.

**Held up:**

- **No service-role key anywhere**, and `.env.local` has never been committed
  in the repo's history. Rule 1 intact.
- **RLS.** The public key can read nothing and write nothing: 21 table and
  view probes, 7 RPCs, every one refused with 42501.
- **Money, quantities and dates.** 23 adversarial cases in
  `test/unit/_audit.test.ts`, written against the functions rather than from
  their existing tests, run under UTC, Sydney, Los Angeles and Kiritimati
  (UTC+14). Both Sydney DST changeovers cross correctly and `daysBetween`
  never returns a fraction. Overflow returns null rather than a wrong number.
- **The offline queue.** All 18 mutation keys have a registered function, so
  no write can be queued that cannot be replayed.
- **Test hygiene.** No `.only`, no skipped tests except the preview snapshots
  (correctly gated on `PREVIEW_OUT`), no assertion-free test files.
- **No `dangerouslySetInnerHTML`, `eval`, `as any`, or `@ts-ignore`** anywhere
  in application code.
- **Every database object exists** — 13 tables, 2 views, 11 functions.
- **`approved_at` is the single source** for whether an entry is approved.
  There is no boolean beside it that could disagree.
- **One array, one total** holds: `onlyOwed` is the single gate every summary
  calls.

**Found, and fixed:**

1. **`verify_rls.mjs` was checking 8 of 11 tables.** `products`,
   `sales_invoice_lines` and `sales_invoice_counters` were added by
   CATCH_UP_015 and never added to the list — so from that day until this
   audit, nothing in the repo proved the anon key could not read Deli's price
   list or the contents of every invoice it had issued. **It could not**,
   verified by hand and now by the script. That is the policies having been
   written correctly, not the check having done its job.

   The file's own comment says *"a table this list forgets is a table nothing
   checks, and the failure is silent — which is the whole reason this file
   exists."* It then forgot three. Same shape as §6's staff fence: **a check
   that is never extended stops being a check and becomes a claim.**

2. **`verify_catchups.mjs` covered 001–005 of eighteen migrations**, and had
   no way to check a COLUMN — which is what most migrations after 005 add. It
   answered "ok" for a table that already existed whether the migration had
   run or not. It now has a `column()` probe and covers 006, 010, 013, 014,
   015 and 018. It correctly reports CATCH_UP_018 as not yet run.

3. **`new Date()` appeared in `lib/greeting.ts`** as a default parameter —
   rule 2 says `lib/date.ts` and nowhere else. The behaviour was already
   right (it handed the instant to `sydneyHour`, which converts), but the rule
   is only enforceable if it is true. `sydneyHour` supplies the same default
   one layer down, so the parameter is simply optional now.

4. **Three unused production dependencies** — `@hookform/resolvers`,
   `lucide-react` and `react-hook-form`, zero imports between them. Removed.
   `lucide-react` in particular is an icon set that shipped nothing: this app
   draws its own glyphs.

**Found, and deliberately not fixed:**

5. **`npm audit`: one high, one moderate.** Both are `postcss` reached through
   `next`, and all four advisories are about processing untrusted CSS —
   sourceMappingURL path traversal and `</style>` escaping. PostCSS runs here
   at build time, on this project's own Tailwind input, on a build machine.
   **No user of this app can reach it.**

   The only fix npm offers is Next 15 → 16, a major version. Taking a breaking
   framework upgrade in the same change as a data wipe, on an app about to be
   declared ready, is a worse risk than the one it closes. It should be done
   deliberately, on its own, with the suite and a real phone afterwards.

6. **`/specimen`** stays. It is a builder's page, its link is gated on
   `role === 'builder'`, and Next code-splits it — the test fixtures it
   imports load only if somebody visits it.

7. **The middleware's `offline` exemption** stays. It is documented and
   correct: guarding it would cache whatever the guard returned, so the page
   shown with no signal would depend on when the service worker installed.

**Could not verify from here:**

8. **`verify_staff.mjs` needs `STAFF_EMAIL` and `STAFF_PASSWORD`**, which are
   the shops' own credentials and are not on this machine. The schema half of
   CATCH_UP_018 is checked by the SQL file's own verification block; the
   behavioural half — that a shop sees `is_mine` true on its rows and false on
   the four's — needs a shop session. The query to run is at the bottom of
   `db/CATCH_UP_018.sql`.

### 43.3 Where it stands

- **Tests: 757**, under three timezones (the audit file adds a fourth).
- `tsc` and `next build` clean. Ten production dependencies, down from
  thirteen.
- **`CATCH_UP_018.sql` must be run BEFORE the deploy.** The app selects
  `is_mine`, and PostgREST answers 42703 for a column that is not there, which
  would break the shop screen.


---

## 44. The roadmap — J1 to J5

Agreed after Mani used the app for a week. **Nothing below is built yet.** This
section is the design and the reasoning; each phase gets its own section as it
lands.

The ordering is not preference. J1 is a permission model and four of the five
phases ask a permission question, so building anything else first means
building it twice. J2 defines what is on the document and J3 renders that
document as a PDF — the other way round is the same work twice again.

---

### 44.1 J1 — the two bugs, and the tiers

**The bugs, both reported, both mine.**

*No way to add a customer while composing an invoice.* The old flat sheet has
an inline "Or add one now"; `ComposeSalesInvoice` never got one. Straight
oversight.

*"Can't actually edit details for customers. There is a - icon, but it does
nothing."* That "-" is an em dash — the placeholder in `Fact` for an empty
value. The real control is the **Edit details** pill at the top of the page.
Round F collapsed Details into a panel and left the button that edits it
OUTSIDE the panel, so the two stopped looking related. **A placeholder that
looks like a control is a control that does nothing.** Fix: Edit moves inside
the panel, and an empty row is itself tappable.

**The tiers.** Today `is_member()` is `role in ('member','owner','builder')` —
owner and member are identical for every permission in the database. The
client wants three real tiers:

| tier | who | may |
|---|---|---|
| **owner** | Mani | everything, and alone may mark paid/unpaid, change roles, edit bank details, wipe |
| **manager** | Milan, Sujan | review, edit and void invoices; add and remove suppliers and customers; issue Deli invoices. **May SEE paid status; may not change it** |
| **staff** | GMH, GMP | unchanged — enter invoices for their own venue |
| **builder** | Rabindra | owner powers, invisible. §44.2 |

`member` becomes `manager`. Renaming rather than adding a fifth value, because
two names for one tier is the shape problem this project keeps meeting.

**HANDOFF §2 is the trap here.** Three role filters were once written as
`role <> 'builder'`, and a blocklist admits every role invented after it. They
are allowlists now, and `manager` must be added to each one deliberately.
`is_member()` is rewritten as `is_manager_or_above()` — the same allowlist, one
value wider — and `is_owner()` is new.

**Paid/unpaid locks to the owner.** `mark_invoices_paid`,
`unmark_invoice_paid`, `mark_sales_received` and `unmark_sales_received` gain
an `is_owner()` check inside the function, and the buttons disappear for a
manager. The database refuses it either way: notes §6 says do not offer what
cannot be done, and the RPC is what makes the refusal real.

*Flagged to the client, and accepted by him:* this makes one person the
bottleneck for every payment tick. If Mani is away, a manager can watch bills
go overdue and not act.

**Promote and demote.** Nobody can currently change a role from the app, and
not by oversight: `revoke update on profiles from authenticated` followed by
`grant update (notify_on_new_invoice, reminder_time)` means those two columns
are the only ones a signed-in person may write. `role` and `active` are
unreachable from the client by construction.

So promotion goes through a SECURITY DEFINER RPC — `set_user_role` — the same
pattern the payment buttons already use, rather than widening the column grant.
A grant is coarse and permanent; a function can check who is asking.

Three refusals belong inside it:

1. **Not a builder row.** Otherwise the owner can lock the builder out of the
   app the builder maintains. §44.2.
2. **Not the last owner.** Demoting yourself when you are the only owner
   leaves nobody who can promote anybody.
3. **Not a staff row, and not into `staff`.** A venue account's role is tied
   to `business_id` and `staff_venue()`; moving one through this screen would
   produce a member with a venue or a shop with none.

**Creating and deleting logins is NOT in this phase, and the reason is rule 1.**
Supabase creates accounts only through the Auth Admin API, which needs the
service-role key. That key is the one thing this whole architecture is built to
not have (§1) — its presence is what makes `auth.uid()` null and silently
destroys attribution. Deactivating covers the real need: an inactive profile
fails `is_manager_or_above()` and sees nothing. The client agreed: six accounts
in the app's lifetime is an occasional event, not a workflow.

---

### 44.2 J1 — the shadow account

> *"our account is rabindra ... it will be a shadow account not within mani's
> bounds. its my app, I want to have control ... it wont be visible to any"*

`builder` already exists and is already outside every list and both
notification audiences (§8.1, `lib/staff.ts`). J1 makes it owner-equivalent:
`is_owner()` returns true for `role in ('owner','builder')`.

What "invisible" means precisely, because the difference matters:

- **Hidden** from the team list, the promote/demote screen, every person
  picker, and both notification audiences.
- **NOT hidden** from attribution. If that account marks an invoice paid, the
  row still says who did it.

That second line is deliberate and was put to the client. An account that can
change money and leaves no trace makes the audit trail lie, and the audit trail
is the thing the four of them are trusting. Hidden from lists, honest about
actions. In practice the account exists to maintain the app, not to work in it.

---

### 44.3 J2 — the document

Three additions, all owner-only to edit, all printed:

- **Deli's own contact block** — what a customer needs to reach them.
- **Bank details** — *"For direct pay, use our account details..."*
- **A signature line** — **confirmed**: a ruled line on the paper
  (*Received by / Signature / Date*). Not a digital signature, nothing
  stored, nothing to verify. It exists so the person taking the delivery can
  put a pen on it.

These are settings about a business rather than about an invoice, so they live
in one owner-writable place keyed by business, not on `sales_invoices`. An
invoice already issued keeps rendering from the row it has, so changing the
bank details tomorrow does not rewrite what was handed over yesterday — the
same copied-not-linked rule as a product price (CATCH_UP_015 §2).

---

### 44.4 J3 — Download, Share, Print

**What cannot be built, stated first.** The client asked for a Mail button that
opens Gmail with the invoice attached. **A web page cannot attach a file to a
mail client.** `mailto:` carries a subject and a body and nothing else — this
is the format, not a browser limitation, and no library changes it.

What does exactly what he described is the **Web Share API**:
`navigator.share({ files: [pdf] })` hands the file to Android, he picks Gmail,
and Gmail opens with the attachment already on it. Same three taps.

So the document gets three controls:

| | |
|---|---|
| **Download** | always present. His stated main goal, and the fallback everywhere Share is missing — desktop browsers, older iOS |
| **Share** | only when `navigator.canShare({files})` says yes. Never a dead button |
| **Print** | unchanged — `window.print()`, AirPrint or Save as PDF |

**Making the PDF.** `window.print()` never gives the app the file, so a PDF has
to be generated to be shared. **Decided with the client: write it, do not
import it.**

A one-page invoice is text, rules and a table — a constrained enough document
that a PDF writer for exactly it is a few hundred lines, and PDF is a text
format. Against ~350KB of library on every phone on shop wifi, plus a
supply-chain dependency in a project that has just removed three. Rule 7 rules
out libraries that restructure the app; a PDF encoder is a leaf that takes data
and returns bytes, so this is a judgement rather than the rule — and the
judgement is that this document is stable enough to own.

**The logo is the one complication.** Uploaded artwork is PNG in a storage
bucket, and embedding PNG means implementing zlib. Re-encoding to JPEG through
a canvas at share time avoids that entirely. If it proves awkward, v1 ships the
wordmark without the logo rather than shipping late.

---

### 44.5 J4 — export, and the wipe

**CSV export** of the full history. The list screens paginate at 50
(`HISTORY_PAGE_SIZE`), so this needs its own unpaginated read rather than
reusing a screen's array — the one place in this app where a second query is
correct, because the question is genuinely different.

**The wipe, from inside the app, owner only.** Round I's
`RESET_TO_CLEAN_SLATE.sql` was a file run deliberately in another tool, and
that friction was doing real work. The client was told so, and answered with a
better design than the objection:

1. Confirm.
2. Type **"Wipe everything"**.
3. Offered the full CSV first — take it or decline it.
4. Then wipe.

Accepted. Four conscious acts cannot be butter fingers. It is a SECURITY
DEFINER RPC gated on `is_owner()`, deleting exactly what the SQL file deletes.

**Rule 5 says nothing is ever deleted, and this is its one exception.** Named
here so it stays an exception rather than becoming a precedent.

Two warnings the flow must carry:

- It cannot reach **other phones' unsent work**. Anything queued on another
  device arrives after the wipe. Everyone must be online with an empty queue.
- It clears the local queue and cache on the device that runs it, so the person
  who wipes is not the person who re-creates a row.

---

### 44.6 J5 — discounts and refunds

> *"Custom payment (applied discount, refunded amount etc)"*

**This was deliberately closed once** (§28.3): part payments are carried by a
note and a moved due date, and `amount_received_cents` was refused as "the
first plank of an accounts package". The client has reopened it, and he is
right that a discount is a real thing that happens.

The stable shape is **adjustments as their own append-only rows** — what, how
much, why, who, when — with every total derived. Not an edit to
`amount_cents`:

- Rule 5. An overwritten amount destroys what the invoice originally said, and
  the original is what the supplier's copy says.
- Rule 4. Totals stay derived from an array rather than from a column somebody
  has to remember to keep in step.
- It answers "why is this bill $40 less than the docket" — a column cannot.

Last, because it changes every figure in the app and should be built once the
permission model underneath it has stopped moving. Whether a manager may apply
a discount is a J1 question with a J5 consequence.

**Settled with the client: Deli's customers only.** *"Discounts, only for
Deli's Customers (because refund or can offer discount)."* So this is the
receivables side — `sales_invoices` — and the payables side is untouched. That
halves the phase and it is also the honest boundary: a discount you OFFER is a
commercial decision that is yours to make, where a discount a supplier gives
you arrives on their docket and is already in the amount you were billed.

**Access: manager level.** Milan and Sujan may apply one. This is deliberately
NOT owner-only, unlike marking paid — and the distinction is worth keeping
straight. Marking paid records that money has moved. A discount changes what
is owed, on Deli's own invoice, before anybody has paid anything. The first is
a statement about the bank; the second is a commercial decision the people
running the shop are there to make.

One consequence to build for: this is the first thing a manager may do that
changes a figure the owner watches. Adjustments carry who and why, and both
appear on the invoice — an unexplained $40 is exactly the disagreement
`amount_cents` was refused to avoid.


---

## 45. The bell that rendered perfectly and could not be seen

Reported between rounds: *"tapping bell icon doesnt show anything."*

The activity panel is `absolute ... top-14` — deliberately hanging BELOW the
56px header bar. Round H put `overflow-hidden` on that header to contain the
mountain ridge (§42.1), and it clipped the panel to the header's own height.

**The panel was rendering correctly, in full, every single time.** It was cut
off at a boundary two pixels above where it began. Nothing threw, nothing
logged, and the feature had been dead since the Himalaya shipped.

`overflow-hidden` was never needed. **An outer `<svg>` clips to its own viewBox
by default**, so the ridge could not escape that element on its own — the
property was added out of caution and cost a feature. Measured after removing
it: header 56px, SVG bottom 56px, nothing escaping, no horizontal scroll.

### What could have caught it, and what could not

Not a rendering test. **jsdom does no layout**, so a test that opens the panel
and queries for its text passes whether or not the panel is visible on a
phone — which is precisely why the existing tests were green throughout.

Two things now stand over it:

1. A test asserting the **structural** fact rather than the visual one: this
   header hosts an absolutely positioned child that extends past its own box,
   so it may never clip its overflow. That is checkable in jsdom.
2. `getBoundingClientRect` in a real browser, which is what §5 of the handoff
   has said to do since Round B and what actually confirmed the fix.

**The general lesson, third time this project has met it:** a change made for
appearance can silently disable behaviour somewhere else, and neither the
appearance work nor the behaviour's own tests will notice. §39.8 was a screen
that threw before painting; this is a panel that painted where nobody could
see it. Both were invisible to a green suite.


---

## 46. J1 — the two bugs, and three real tiers

The first phase of the roadmap in §44. Two reported defects, then the
permission model the other four phases lean on.

`db/CATCH_UP_019.sql`, **before the deploy**. 784 tests under three timezones,
up from 767.

---

### 46.1 A placeholder that looks like a control

> *"Can't actually edit details for customers. There is a - icon, but it does
> nothing."*

The "-" is an em dash — `Fact`'s placeholder for an empty value — and the
report is exactly right about it. Tapping it did nothing, because it was never
a control; it only looked like one, sitting in the column where a control
belongs.

The real Edit was a pill at the top of the page. Round F (§40) folded Details
into a collapsible panel and left that pill **outside** it, so the two stopped
looking related: the panel arrives shut, and the one control that opens its
editor is above it, in a row with Remove.

Three changes, and the third is the one worth keeping:

1. **Edit moved inside the panel**, under the values it edits. With the panel
   shut there is now no way to start editing at all, which a test asserts —
   the two cannot drift apart again.
2. **Every row is the control.** An empty row says **Add** in the action
   colour instead of an em dash. It is honest about being a control rather
   than looking like one by accident, and a filled row opens the same editor,
   which is where a phone number that has changed gets fixed.
3. **`Fact` takes `value`, not `children`.** Four call sites each wrote
   `{customer.contact_phone || '—'}`, which put the decision about what empty
   means in four places, and the em dash was the result. One component decides
   now.

It stopped being a `<dl>` in the process, and that is a consequence rather
than a preference: `<dt>` and `<dd>` inside a `<button>` is not valid content,
and these rows stopped being a description list the moment every one of them
became something you press. They carry `touch` as well — measured at 36px
before, 44px after, which is the minimum every other control in this app
meets.

**The same fix went to `SupplierDetail` unasked.** It prints the same em dash
from the same shape. The Edit pill stays in its header there, because that
panel does not fold and the two already read as one thing.

---

### 46.2 A customer, added without leaving the invoice

The other reported bug, and mine. `ComposeSalesInvoice` had no way to add a
customer, so a new one standing at the counter meant abandoning a half-built
invoice, going to Customers, and starting the lines again.

The old flat sheet has an inline field, and this is the same three lines —
with one difference. **The sheet offers its field only when the list is
empty**, which is right for a first run and wrong for the case reported: a
customer list that exists and needs one more. Here it is always offered.

The id is generated on the client, as everywhere else (notes §1.5): a queued
write is resumed by key from a cold start, and an id decided by the database
would make the second attempt a second customer. `optimisticCustomer` puts the
row in the cache the picker reads, so the picker points at them immediately,
offline included.

---

### 46.3 The tiers

`member` became `manager`, and `owner` became a permission for the first time.

| tier | who | may |
|---|---|---|
| **owner** | Mani | everything, and alone marks paid/unpaid and changes roles |
| **manager** | Milan, Sujan | review, edit, void, suppliers, customers, issue invoices. **Sees paid status; cannot change it** |
| **staff** | GMH, GMP | unchanged |
| **builder** | Rabindra | owner powers, invisible in lists (§44.2) |

**Renamed rather than joined by a fifth value.** Two names for one tier is the
shape problem this project keeps meeting; every list, filter and policy would
have had to remember both forever, and the day one of them remembered only one
is the day somebody silently lost access.

**`is_member()` was renamed to `is_manager_or_above()`, not replaced.** Twenty-
odd policies say `is_member()`, and a policy stores the function's OID rather
than its name, so every one of them followed the rename with nothing to edit.
Recreating them by hand would have been twenty chances to get one wrong on a
live database. The old name is deliberately not kept as an alias: a policy
written next year saying `is_member()` should fail loudly at creation rather
than compile against a shim nobody maintains.

#### The trap, and the six allowlists

HANDOFF §2 records three role filters once written as `role <> 'builder'` — a
blocklist admits every role invented after it. They are allowlists now, and an
allowlist has the **opposite** failure: a tier added without visiting each one
is a tier quietly excluded. Nobody would write that bug either; it would
simply happen.

So all six were visited by hand rather than by search-and-replace, and
CATCH_UP_019 §1 names them:

| | where | what it decides |
|---|---|---|
| 1 | `is_manager_or_above()` | every RLS policy in the database |
| 2 | `push_targets` | who is told about a new invoice |
| 3 | `push_targets_payment` | who is told about a payment |
| 4 | `send_daily_reminders()` | whose alarm goes off |
| 5 | `isFullMember` | which app a person is shown |
| 6 | `runsTheBusinesses` | who appears in a list of people |

`test/unit/tiers.test.tsx` names all five roles against all three app-side
predicates, in both directions, so a sixth tier breaks a test rather than
somebody's access.

#### Paid and unpaid lock to the owner

`mark_invoices_paid`, `unmark_invoice_paid`, `mark_sales_received` and
`unmark_sales_received` each gained `if not is_owner() then raise`.

**Raised, not filtered.** The obvious implementation is one more `and
is_owner()` in the where clause, and it is wrong, because these functions
already carry a meaning for "changed nothing": `where status = 'unpaid'` is
what makes them idempotent under an offline replay, and the app reads an empty
result as *somebody else already ticked this off* and says so in those words.
A permission check written as a filter would make a refusal indistinguishable
from a race, and the app would tell a manager that Mani had just paid a bill
nobody has paid.

They stay SECURITY INVOKER — migration 004's reasoning holds, they are
transaction boundaries and not privilege boundaries. `is_owner()` is the one
SECURITY DEFINER piece, and it is the only piece that needs to be.

**Void is deliberately NOT owner-only.** Voiding takes a bill out of every
total with a reason and leaves it in history struck through: it corrects a
mistake, which is a manager's job. Marking paid asserts that money left the
account, which is the owner's. The two look similar and are not the same act.

App-side, the offering is decided in **one place per surface** rather than at
each call site. `useTickOff()` returns `mayTick`, so the week, the pending
list and a supplier's page share the answer as well as the action — three
lists that would otherwise be three chances to forget on the day a fourth is
written. `onMarkPaid` and `onUndo` became optional on `InvoiceRow` and
`PaymentRunRow`, so absent is what a manager gets: **absent, not disabled**, a
greyed tick on every row of the list somebody opens most often being a screen
that apologises forty times.

*Flagged to the client and accepted:* this makes one person the bottleneck for
every payment tick. If Mani is away, a manager watches bills go overdue.

#### Promote and demote

`set_user_role`, a SECURITY DEFINER RPC, and the column grant is untouched.
Migration 007 revoked blanket UPDATE on `profiles` and granted back exactly
`notify_on_new_invoice` and `reminder_time`; `role` stays unreachable from a
browser by construction. Widening that grant would let anybody signed in write
any value into anybody's row, because a grant is coarse, permanent, and cannot
ask who is calling. A function can.

Five refusals, each with a reason:

1. **Not a non-owner.** The permission itself.
2. **Not a role other than manager or owner.** A screen that can mint a
   builder is a screen that can hide an account from every list in the app.
3. **Not a builder row.** Otherwise the owner can lock the builder out of the
   app the builder maintains, from a screen, in one tap. §44.2.
4. **Not a staff row.** A venue account's role is tied to `business_id` and
   `staff_venue()`; moving one through this screen produces a manager with a
   venue attached or a shop with none.
5. **Not the last owner.** The builder is not counted here even though
   `is_owner()` includes him: an app whose only remaining owner is invisible
   to everybody in it has no owner as far as the four of them are concerned.

Four of the five are conditions on rows that are not on the list at all, so
there is no button to leave out. The fifth is a condition on a row that IS
there, and "Make manager" against the only owner is a button whose entire job
is to fail — so that one is stated in advance, as *The only owner*.

The refusals come back as sentences a person can read, and the screen shows
what the database said rather than a house message of its own. Five specific
reasons beat one vague one.

**Not offline-capable, deliberately.** Every other write in this app queues. A
promotion applied twenty minutes later, against a table somebody else has also
changed, is a permission decision made in the dark. It fails, and it says so.

#### A role change leaves a trace, and where it went

`set_user_role` writes to `activity_log` — `entity_type` is free text, so
'profile' needed no new table and no new grant, and the row is written from
inside a SECURITY DEFINER function, which is the only writer that table has
ever had.

That immediately broke something, which is worth recording because it is the
same shape as §45. **The header bell reads the whole table and links every row
to `/invoices/<entity_id>`.** A promotion would have appeared in the feed as
an invoice that does not exist, and tapping it would land on "No such
invoice". `useRecentActivity` now asks for `entity_type = 'invoice'`: the
panel is a list of things you can open, and it says so rather than trusting
that nothing else will ever be logged.

The 'profile' rows are recorded and readable by query. **Nothing surfaces them
yet** — that is a screen, and it is not in this phase.

---

### 46.4 What the verifiers now cover

HANDOFF §6: a check that is never extended stops being a check and becomes a
claim. Three files gained this phase's facts in the same commit:

- `db/verify_catchups.mjs` asks whether `is_member()` is **gone** — the one
  line in that file whose question is backwards, because PGRST202 there is the
  proof rather than the failure — then probes `is_manager_or_above`,
  `is_owner` and `set_user_role`.
- `db/verify_schema.sql` names the two new predicates and `set_user_role` in
  its function list, and its comment now says which functions may be SECURITY
  DEFINER and why the four payment RPCs must not be.
- The `is_owner()` guard inside those four **cannot be seen from outside**.
  The anon key is refused by the table grants long before `is_owner()` is
  reached, and from outside a missing permission and a working refusal are
  both 42501 — the fence with no proven gate again. CATCH_UP_019 §7 counts the
  guard from `prosrc` instead, and raises if it is not on all four.

`test/unit/settings.test.tsx` also writes a preview page now. A name plus a
pill on a 375px phone is exactly what reads correctly in an assertion and
wraps badly on glass; measured at 320px, no horizontal overflow.
