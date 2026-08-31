# Sagarmatha Payments — Architecture & Workflow

Companion to `sagarmatha-payments-spec.md` (what to build) and `CLAUDE-CODE-NOTES.md` (where the bugs will be).
This document is the third leg: **how it is put together, and in what order.**

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
- **Tests:** 532, under `UTC`, `Australia/Sydney` and `America/Los_Angeles`.
