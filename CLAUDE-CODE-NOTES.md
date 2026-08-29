# Build notes for Claude Code — Sagarmatha Payments

Read this alongside `sagarmatha-payments-spec.md`. The spec says *what* to build. This says *where the bugs will be*.

These are not hypotheticals. Every item below is a bug that shipped in a production kitchen app built by the same person, found by real users, and cost a rebuild to fix. The stack is different (vanilla JS + Cloudflare KV, versus Next.js + Postgres here) so the mechanics differ — but the failure modes transfer almost exactly, because they come from the shape of the problem, not the tools.

Priority: items in §1 are the ones that will actually happen. Read them before Phase 3.

---

## 1. Bugs that will happen, and where

### 1.1 A background refetch will wipe a half-filled form

**This bug shipped three separate times in the previous app.** Each time it was fixed in one place and reappeared somewhere else, because the fix was local instead of structural.

Mechanism here: TanStack Query ships with `refetchOnWindowFocus: true`. Someone opens the add-invoice sheet, switches apps to check the paper docket, comes back. The refetch fires, the component re-renders, everything typed is gone.

The add-invoice sheet is the single most important screen in this app. This bug there is fatal to adoption.

Required:

- Form state lives in `react-hook-form` or `useState`, **never** derived from query data on each render.
- Any query feeding a screen that contains an open form sets `refetchOnWindowFocus: false`.
- Don't fix this per-component. Make it structural — a `useFormGuard()` hook, or a provider that suspends refetching while a sheet is open. The previous app ended with one central guard (`EDIT_VIEWS` + `bgRender()`) precisely because scattered fixes kept missing a screen.

Verify by opening the sheet, typing an amount, backgrounding the app for 30 seconds, returning. The amount must still be there.

### 1.2 Timezone: the trap moves server-side, it doesn't disappear

The spec correctly pins `date-fns` to `Australia/Sydney` on the client. That is not sufficient.

Postgres and Vercel both run UTC. Every derived-urgency comparison in §6 (`due_date < today`) is wrong for roughly the first ten hours of each Sydney day if evaluated with a UTC "today". Invoices flip to overdue on the wrong date, and the Home screen — the whole point of which is knowing what's due — lies.

Required:

- Compute "today" once, from Sydney, and pass it explicitly into any query or RPC that compares against it. Never let Postgres call `current_date` for urgency logic.
- `due_date` and `invoice_date` are `date`, not `timestamptz`. Keep it that way. A date has no timezone and should not acquire one.
- `paid_at` and `created_at` are `timestamptz`. Correct. Format for display in Sydney, always.

The precedent: in the previous app, invoices logged before ~10am filed into the previous week, because a date key was built with `toISOString()`. Silent, and only visible as a total that didn't add up.

### 1.3 Reading a draft into a copy and forgetting to write it back

The edit-invoice flow will read form values into an object, validate, then save. In the previous app the equivalent code built a copy of the record, and only wrote that copy back for *new* records — so every edit to an existing one was silently discarded and the old values were sent to the server. It looked like it saved. It even showed a success toast.

When implementing edit: write one function that produces the payload, and make the create and update paths share it. If you find yourself writing `if (isNew) { ...push } ` with no matching `else`, that's the bug.

Test explicitly: edit an existing invoice's amount, save, reload from the server, assert the new amount came back.

### 1.4 Optimistic update reverted by a refetch that lands too late

Marking paid should feel instant. The standard TanStack pattern is `onMutate` → cancel in-flight queries → snapshot → optimistically update → `onError` rollback → `onSettled` invalidate.

The failure: `onSettled` invalidates, the refetch returns data written a moment ago, and if anything upstream is stale the row flickers back to unpaid. Postgres is strongly consistent so this is far less likely here than it was on KV — but a read replica, a cached route handler, or an `onSettled` firing before the transaction commits will all reproduce it.

Required:

- `cancelQueries` in `onMutate`. Non-negotiable, or an in-flight fetch overwrites the optimistic state.
- Await the mutation fully before invalidating.
- Don't mark `staleTime: 0` on lists that receive optimistic updates.

### 1.5 Offline retry will create duplicate invoices

§2 of the spec calls for an offline write queue. The naive version double-inserts: request times out, queue retries, both eventually land, two identical invoices exist and nobody knows which is real.

Required:

- Client generates the invoice `id` (a UUID) before sending. Insert becomes idempotent — a retry with the same primary key conflicts instead of duplicating. `insert ... on conflict (id) do nothing`.
- Queue only writes, never reads. Cached reads that are hours stale are worse than an honest empty state.
- Show queue state in the UI. "Saved — will send when you're back online" is honest; a success toast for something sitting in a queue is not.

### 1.6 Ticking a payment run must be one transaction

§6 allows ticking a whole run — several invoices, one transfer. If that's implemented as a loop of individual updates, a mid-loop failure leaves some invoices paid and some not, with no indication which. In a money app that's the worst possible partial state.

Required: a Postgres function taking an array of invoice ids plus a payment ref, updating all of them in one statement. Call it via `rpc`. Never loop on the client.

---

## 2. The server is the boundary

The previous app's hardest-won rule: **enforcement lives in the database, never the interface.** "The button isn't rendered" is not access control. Here that means RLS does the work and the UI merely reflects it.

Specific traps:

**`auth.uid()` returns null under the service role key.** The audit trigger in §5 uses it. Any server action using the service role will write `null` into `actor_id`, and the column is `not null`, so it fails — or worse, you relax the constraint to make it work and lose attribution permanently. Server-side writes must run with the user's JWT, or pass the actor explicitly.

**RLS policies run per row.** The `exists (select 1 from profiles ...)` pattern is fine at this scale, but add an index on `profiles(id) where active` and check the plan once the invoice table has a few thousand rows.

**Internal ref generation must not be select-then-insert.** Two people logging at the same time will both read `02` and both write `GMH-260828-03`. Generate inside a single statement, with an advisory lock or a per-business-per-day sequence. This is exactly the class of race that destroyed a shared record in the previous app.

---

## 3. Money

The spec is right to use integer cents. The bugs live at the boundaries:

- **Parsing input.** `parseFloat("5,220.00")` returns `5`. Strip separators before parsing, and reject anything that isn't a clean decimal rather than coercing.
- **Display.** One formatter, used everywhere. `Intl.NumberFormat('en-AU', { style:'currency', currency:'AUD' })`. Never hand-roll `'$' + n.toFixed(2)` in a component.
- **Sums.** Add cents as integers, convert once at the edge for display. Never sum formatted strings or floats.
- **Totals must reflect the filter.** §7.4's sticky footer shows the total of what's *currently filtered*. A total that silently shows everything while the list shows a subset is a trust-destroying bug that looks like a display glitch. Derive the total from the same array the list renders — not from a separate query.

---

## 4. Mobile input details that are load-bearing, not polish

The 15-second target in §1 of the spec is won or lost here.

- **Amount field:** `type="text"` with `inputMode="decimal"`. Not `type="number"` — it brings spinners, changes value on scroll, and behaves inconsistently with locale separators.
- **Autofocus the supplier field** when the sheet opens, but only on a real focus event; iOS suppresses programmatic keyboard opening outside a user gesture.
- **Touch targets ≥44px**, including the due-date preset pills and the sort pills. A 32px pill is a rage-inducing miss rate at arm's length.
- **`font-variant-numeric: tabular-nums`** on every money and date figure, per §9. Non-tabular digits make columns visibly wobble and it reads as cheap.
- **Sheet must survive the keyboard.** Test with the on-screen keyboard open on a 360px viewport — the save button must remain reachable, not pushed under the keyboard.

---

## 5. Shared constants

A bug from the previous app worth stating plainly: a default value was written as `5` in the input's placeholder and `1` in the calculation. The screen said "1 per 5 people" while the maths divided by 1. Thirty people got thirty portions instead of six.

Here, the equivalents are: default payment terms, the duplicate-warning window, the "this week" horizon of 7 days, and urgency thresholds.

Put each in one exported constant in `lib/constants.ts`. If a value appears in both a validation schema and a UI hint, it must be the same imported symbol, not two literals that happen to match today.

---

## 6. Testing

Without a device in hand, the highest-value automated checks are unglamorous:

- **Render every screen with realistic data and assert the output contains no `undefined`, `NaN`, or `[object Object]`.** This is crude and it caught real bugs repeatedly in the previous project. A 200-invoice fixture, per §9's quality floor.
- **Date logic across the boundary.** Run the urgency bucketing at 09:00 and 23:00 Sydney and assert identical results for the same `due_date`. That single test would have caught the invoice-week bug.
- **Money round-trip.** Parse → cents → format, for `"5,220.00"`, `"0.05"`, `"1000000"`, and confirm no drift.
- **The edit path specifically:** create, edit a field, save, refetch, assert the change persisted. See §1.3.
- **Concurrency:** two simultaneous inserts for the same business and day produce two distinct `internal_ref` values.

---

## 7. Reporting back

The person reviewing this is not a developer. He runs a kitchen, and he built the previous app by specifying it precisely and testing it in live service. He is very good at spotting when something is off and describing it exactly — "it strikes through then undoes itself, unless I leave and come back" was a real bug report that pinpointed a cache-consistency issue.

What works with him:

- Plain language. Name the cause, not just the fix. "The list was refreshing while you typed" beats "resolved a state reconciliation issue".
- Lead with the uncomfortable part. If something can't be done, say so early rather than half-building it.
- He tests on a real phone. Anything that only works on desktop will be found within a day.
- Don't pad. He manages context and token budgets deliberately.
- When a phase is done, state plainly what changed, what needs deploying, and anything he should check.

Stop at the end of each phase in §10 as instructed. Do not run ahead.

---

## 8. Do not

- Do not add an ORM, Redux, tRPC, or a state-machine library. §4 rules them out for good reasons — the surface is small and abstractions will outweigh the code.
- Do not build any §11 item early, including invoice photos, however tempting.
- Do not use a component library. §9's visual direction is specific and a library will fight it.
- Do not delete rows. Void, with a reason, always visible.
- Do not store computed urgency. It's derived at read time. Storing it means a scheduled job that will one day fail quietly and be trusted anyway.
- Do not make the UI the enforcement layer for anything.
