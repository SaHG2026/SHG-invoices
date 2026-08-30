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
| Invoice marked paid | Anyone with notifications on, except whoever ticked it |
| Everything else | Nobody — it is in the history, which is always readable |

Currently that means Mani, who is notified when Milan, Sujan or Rabindra logs or pays something, and
never when he does it himself. It falls out of `push_targets` (§8.1) plus an actor exclusion, so
there is no per-person rule to maintain and no branch that names Mani.

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

### Where it goes: Phase 8

After v1 is in daily use, and here is the reason rather than the excuse. Chasing a customer is a
different job from paying a supplier — it involves reminders, part payments and a relationship — and
none of us knows yet which of those Deli Delights actually needs. Building it before the payables app
has been used for a month means guessing at all of it, and spec §11's discipline exists precisely for
this case.

Nothing about the current schema blocks it, and nothing needs adding now.


---

## 19. Where the build has got to

Written for whoever picks this up next, including a later session of me.
**Phases 1–6 are built, deployed and signed off by the client. Phase 7 is next.**

Live at **https://shg-invoices.vercel.app** · repo `SaHG2026/SHG-invoices`, branch
`phase-1-foundation` · 333 tests, run under `TZ=UTC`, `Australia/Sydney` and
`America/Los_Angeles` before every commit.

### What exists

| Route | What it is |
|---|---|
| `/login` | Email and password. No sign-up route exists. |
| `/` | Dashboard: greeting, group total, Overall plus four businesses ordered by who is most overdue. |
| `/b/[scope]` | The Week for `all` or a business code — overdue, today, next 7 days, later, with payment runs. |
| `/b/[scope]/pending` | Four sorts, search, overdue-only, supplier filter, sticky filtered total. |
| `/b/[scope]/history` | Paid and voided, searchable, filtered by payer. |
| `/invoices/[id]` | One invoice: facts, actions, and the merged notes/activity stream. |
| `/suppliers`, `/suppliers/[id]` | List, add, edit, deactivate; terms, contact, six-month spend. |
| `/specimen` | Design tokens, rendered from the test fixture. Delete when it stops being useful. |

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

1. **Supplier payment terms.** Suppliers created from the add-invoice sheet have none. The
   suppliers list counts them and the supplier page sets them. Worth a pass over the ones
   created during Phases 3–6.
2. **CSV export.** Deferred pending the bookkeeper's answer to "what do you do with the
   file when you get it?" — see §17. CSV is an hour; a real `.xlsx` is half a day and the
   first dependency added purely for output.
3. **Deli Delights receivables.** Phase 8, after a month of daily use. See §17 for why it
   is a second ledger and not a flag.
4. **Rabindra's test account** goes inactive when it is no longer needed —
   `db/seed/002_profiles.sql` has the statement, commented out.

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

The pattern worth carrying forward: **five of the eight were shape problems, not logic
problems.** The fix each time was to make the broken state unrepresentable rather than to
correct the branch that produced it.

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
