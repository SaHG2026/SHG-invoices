# Handoff — Sagarmatha Payments

Entry point. Read this, then §1's list, then start.

**Everything here was expensive to learn.** Reading it costs five minutes;
re-deriving it costs a session. Several items below are here because they were
missed once and cost a round trip through a person.

---

## 1. Read these, in this order

| File | What it is |
|---|---|
| `sagarmatha-payments-spec.md` | The client's own spec. **What** to build, in his words. |
| `CLAUDE-CODE-NOTES.md` | **Where the bugs will be.** Written from his previous app, which shipped these exact failures. Not hypothetical. |
| `ARCHITECTURE.md` | **How** it is built, and every decision since, with reasoning. Long. §2 below says how to read it without reading all of it. |

`ARCHITECTURE.md` is 176KB and is an archive, not a briefing. Do not read it
end to end. Grep for the section you need:

| Question | Section |
|---|---|
| Why is there no server-side data fetching? | §1 |
| Why is every total derived from one array? | §2 |
| Dates, timezones, the worst bug class | §3 |
| Money | §4 |
| Schema, RLS, the ref counter, audit trigger | §5 |
| The offline queue and optimistic writes | §7 |
| Roles, notifications, push | §8.1 |
| Every bug found on a real phone, with its test | §19 |
| Venue staff accounts — the boundary | §34 |
| Rounds A–E, the most recent work | §35–§39 |

---

## 2. What this is

An internal tool for Sagarmatha Holdings Group — four businesses, six accounts
— to log supplier invoices and tick off payments. Not a product. Optimised for
one number: **under 15 seconds to log an invoice on a phone, one-handed, from
cold app open.** Measured and met; the client's words were "it feels
instantaneous". Every feature decision defers to it.

- **Live:** https://shg-invoices.vercel.app
- **Repo:** `SaHG2026/SHG-invoices`, branch **`main`** — holds everything.
- **Database:** Supabase, project `wkjesptogulnemfhmfod`
- **Local config:** `.env.local`, gitignored, already populated

**Who is who.** Mani (owner, CEO), Milan (member, COO), Sujan (member, GM),
Rabindra (builder — maintains the app, out of every list and both notification
audiences, access untouched). Plus two shared shop logins, GMP and GMH, role
`staff`.

### The one thing that everything else assumes

**`role` is a permission, for exactly one value.** `staff` decides access;
`member`, `owner` and `builder` decide only what a screen shows. `is_member()`
was narrowed rather than nine policies edited, so **a policy written in a later
phase excludes venues by default** — write `is_member()` like all the others
and it is already right. §34.

The trap it replaced: three role filters written as `role <> 'builder'`, and a
blocklist admits every role invented after it. All three are allowlists now
(`lib/staff.ts`). **If you add a fourth role check anywhere, write it as an
allowlist** or it will quietly include whatever comes next.

### Four things that are easy to undo by accident

1. **Push names nobody in code.** Only Mani is told when a bill is *paid*, via
   `profiles.notify_on_payment`, set by an `UPDATE` in `CATCH_UP_006.sql`.
   Never a branch on a display name.
2. **Nothing in the app ever asks anybody to enable push.** No prompt, no
   badge. The switch is in Settings and that is the whole of it. §28.4.
3. **The service worker touches no writes, and must never.** `public/sw.js`
   returns early on anything that is not a same-origin GET. A worker that
   retries writes is a second queue in a second process, and two queues that
   can both send the same invoice is how an invoice gets entered twice.
4. **Everything a write needs must be in its variables, never in a closure.**
   A queued write is resumed by key from a cold start. `lib/offline/keys.ts`
   has the account; `test/unit/offline-queue.test.ts` fails if a write is added
   to `mk` without a function registered for it.

---

## 3. Running it

```bash
npm run dev          # localhost:3000
npx vitest run       # 706 tests
npx tsc --noEmit
npx next build
```

**Always run the suite under three timezones before committing.** The worst
historical bug class is date handling, and a Sydney-only pass hides it:

```bash
for tz in UTC Australia/Sydney America/Los_Angeles; do TZ=$tz npx vitest run; done
```

### Looking at a screen without signing in

Five preview files render real components against real fixtures and write
standalone HTML. Skipped unless `PREVIEW_OUT` is set. `ARCHITECTURE.md` §21.6
has the commands.

`preview-dashboard`, `preview-venue`, `preview-supplier`, `preview-review`,
`preview-sales`. The last three exist because those screens cannot otherwise be
seen — one needs a real supplier, one needs a shop's unapproved entry, one
needs a customer, products and an issued invoice.

### Deploying — and the trap that cost two rounds

```bash
npx vercel deploy --prod --yes
```

**Check the output says `Aliased`.** And know what this command actually does:
it ships **whatever is on disk right now**. There is no git connection, so it
cannot know about commits made after you last ran it, and it will not warn you.

A deploy silently left the site a commit behind and two rounds went on "it
still shows the old message" before anybody checked. So:

**The app carries its build id. Settings shows it, last on the page.** After
deploying, open Settings and confirm it matches `git rev-parse --short HEAD`.
That question is now five seconds, not an investigation.

Auto-deploy via `vercel git connect` was considered and **deliberately not
done**: a push would then deploy app code before its database file has been
run, and that ordering has mattered twice.

### Database changes

There is no migration CLI. **The client applies SQL by hand** in the Supabase
SQL editor.

- `db/migrations/` is the source of truth for a fresh install
- `db/CATCH_UP_0NN.sql` are deltas already sent and applied — **001 to 016**
- Write a new `CATCH_UP`, send it with `SendUserFile`, make it **idempotent**
- **Batch changes.** Each file is a round trip through a person
- **Say explicitly whether the SQL must run before or after the deploy.** It
  has mattered twice: `CATCH_UP_013` deployed early empties every total,
  `CATCH_UP_015` deployed early breaks recording any sales invoice

---

## 4. Rules that must not be broken

Not preferences. Each one is load-bearing and several were paid for.

1. **No service-role key. Anywhere.** `auth.uid()` returns null under it, which
   silently destroys attribution on every invoice. If the key does not exist,
   the trap cannot be sprung. This is why the app is client-first (§1).
2. **`new Date()` appears in `lib/date.ts` and nowhere else.** `toISOString()`
   is banned outright — it is the literal mechanism of his previous app's worst
   bug. Calendar dates are `'YYYY-MM-DD'` strings, times of day are `'HH:MM'`
   strings, and neither is ever parsed into a `Date`.
3. **Hex colours exist only in `app/globals.css`.** Two documented exceptions,
   both of which cannot read a CSS variable by nature: `app/manifest.ts` and
   `app/global-error.tsx`. The `@media print` block is a third place colours
   are literal — a printer has no CSS variables and a token that failed to
   resolve on paper is white on white.
4. **One array, one total.** Every figure on a screen is derived from the same
   array the list renders (§2). A total from a separate query is the bug the
   notes call "trust-destroying".
5. **Nothing is ever deleted.** Void with a reason. Deactivate, do not remove.
   The one exception is a logo or photograph (§30.2) — a picture is not a
   record.
6. **Money is integer cents**, parsed and formatted only by `lib/money.ts`.
   **Quantities are integer thousandths**, only by `lib/quantity.ts`.
7. **Do not add** an ORM, Redux, tRPC, a state-machine library, a component
   library, or a charting library. Spec §4 rules them out.
8. **Stop at the end of each phase.** Report, then wait.

---

## 5. Things that will waste your time

**Bash heredocs break here.** Writing a `.tsx`, `.sql` or `.md` file with
`cat <<'EOF'` fails on apostrophes, `$$` and em dashes. Use the Write tool for
anything non-trivial; Python `pathlib` for surgical edits to existing files.

**Browser-pane screenshots render stale frames.** They show blank or
half-painted pages while the DOM is perfectly correct. Do not debug from them —
measure with `javascript_tool` (`getBoundingClientRect`, `getComputedStyle`).
This found real bugs twice.

**But do still look.** Two defects in Round B and D were invisible to passing
assertions and obvious in a browser: a heading truncating at 360px, and the app
header printing across every invoice. For print, lift the rules out of their
media query with JS and look at what is left.

**Component tests need the full mock set — all six.** Anything rendering
`AppChrome` reaches `useRecentActivity` via the header bell and
`useAwaitingReview` via the drawer's Review badge. A file that mocks only what
it thinks it needs passes alone and fails in the suite. Mock `session`,
`invoices`, `reference`, `detail`, `payments`, `review`.

**`use(params)` never resumes in a bare test render.** This is why every
dynamic route is a two-file pair: a thin `page.tsx` that awaits the params, and
a screen component taking a plain value. Keep that split. Search params go the
same way — the route unwraps them, the screen takes a literal.

**Testing Library cleanup is registered manually** in `test/setup.ts`, because
Vitest runs without globals.

**Accessible names collide.** The header shows the signed-in person's name.
Scope queries with `within()`.

---

## 6. Where the build has got to

**Live and in daily use. All database files through `CATCH_UP_016` applied.**
706 tests under three timezones.

Phases 1–7, the venue accounts (§34), then five rounds of feedback:

| | |
|---|---|
| §35 | **Round A** — the Home figures became links; edit/remove made findable; supplier totals between two dates |
| §36 | **Round B** — a shop's invoice waits to be approved; shops choose a supplier rather than creating one; a note on every entry |
| §37 | **Round C** — a daily reminder at a time each person chooses |
| §38 | **Round D** — Deli's products, line items and printable invoice |
| §39 | **Round E** — Deli's price list became the compose screen, and the two ways in |

### The two lessons worth more than the features

**A fence proven to keep things out has not been proven to have a gate.**
`verify_staff.mjs` passed for weeks while a shop could not save a single
invoice, because from outside a missing permission and a working refusal are
both `42501`. Its one positive write test sat behind `--write` and was never
run. `db/diagnose_venue_write.mjs` is the other half; run both after any change
to the staff policies.

**A mock that cannot produce a real state guarantees bugs in it.** The compose
screen threw on every open for a whole round -- `useSydneyToday()` returns
**null on the first render** and the screen passed that to `addDays`. Both test
files and the preview harness mocked the hook to a fixed date, so the frame
every phone actually renders was the one state nothing could reach. It is a
knob now. **When a hook is documented as returning null first, the test must
render that.** §39.8.

**A label is a promise, and an unkept one reads as broken.** "New invoice for
this customer" navigated to a screen asking who the invoice was for, and was
reported as "doesn't work" — correctly. Before hunting for a crash, check what
the control said it would do. §39.1.

**`.upsert()` is not `.insert()` under RLS.** PostgREST compiles an upsert to
`INSERT ... ON CONFLICT`, which brings the table's **UPDATE** policies into the
permission check. A member passes them via `member_all`; an account whose only
update policy is conditional does not. Where the replay guarantee is needed
without upsert: generate the id on the client, use a plain insert, and treat a
`23505` naming **the primary key and only that key** as the replay succeeding.
`test/unit/venue-write.test.ts`.

---

## 7. What is still open

**Nothing is blocking.**

1. **Edit is offered on rows a shop did not enter.** `stillCorrectable` gates on
   the clock alone; `staff_update` also requires `created_by = auth.uid()`. So
   a venue is offered Edit on one of the four's invoices and tapping it is
   refused — notes §6, do not offer what cannot be done. The fix needs the
   boundary view to answer "is this mine". **Add an `is_mine` boolean, not
   `created_by`** — answer the question, do not hand over the row. Held to
   batch with the next SQL file. Re-run `verify_staff.mjs` after.

2. **The app feels a touch slower on a phone.** Reported long ago, never
   diagnosed, and the client was going to watch which pattern it follows. The
   database is fast (~45ms warm), so this is round trips. §34.12 has the three
   things to localise.

3. **Recovery within 7 days of a deletion.** Asked for. Nothing in the app
   deletes anything, so losing an account loses no data — but there is **no
   backup at all**, which was accepted at handover (§33.1) on the reasoning
   that this is a reminder layer over records kept elsewhere. A 7-day undo is
   Supabase point-in-time recovery, a paid add-on. Needs the plan checked and a
   decision.

4. **Push has now been proven to reach a phone, once.** The daily reminder
   arrived. But only the builder's device is subscribed: Mani, Milan and Sujan
   have never turned the switch on, because §28.4 decided the app never asks.
   Somebody has to tell them it is in Settings. Until then, every notification
   in this app goes nowhere.

5. **Export by date range** — *"from this date to this date export in excel or
   csv etc."* Still the "after a month of real use" item. Half of it exists as
   the supplier date range (§35.4), and what a range answers on screen is worth
   having before deciding what a file should contain. §33.2 has the one
   question to ask first: what happens to the file when it arrives.

6. **A global list of issued invoices.** Deli's are reachable per customer,
   and now from `/b/ddl` as well. Worth adding when a customer becomes the
   wrong index, not before.

7. **Tidying the audit left behind** (§33.1): three unused packages, the
   `/specimen` page, the middleware's `offline` exemption. Harmless.

### Known and deliberately accepted — do not "fix" these

A pre-release audit found eleven things. One was a defect and was fixed (§32).
**The other ten the client weighed and accepted**, on his own reframing:

> "this is meant to be just an advanced interactive notes. They have better
> means to track record of things. Rather than scribble it somewhere... its
> more of a reminder app about 'oh its already due tomorrow?'"

So if you find no automatic backups, an open deletion path outside the app, or
staff photographs at public urls: **those are decisions, not oversights.**
§33.1 has each with his reasoning. If the app ever stops being a notebook and
starts being the record, every one must be reopened — that is the condition the
acceptance rests on.

**Closed:** Deli receivables beyond `customers` and `sales_invoices`. Part
payments are carried by a note and a moved due date, deliberately not by an
`amount_received_cents` column — that field is the first plank of an accounts
package. §28.3.

---

## 8. How to work with this client

`CLAUDE-CODE-NOTES.md` §7 is accurate and worth re-reading. In practice:

- **He tests on a real phone and reports precisely.** Take the report literally
  and look for the single cause.
- **He is right about his own product more often than the spec is.** Three
  times now he has asked for something the spec forbade and been correct: the
  tick on list rows, removing reference numbers, and rounder corners. When his
  instruction conflicts with the spec, re-read the spec's *reasoning* first.
- **Lead with the uncomfortable part.** If something cannot be done, or you got
  something wrong, say it first and plainly. He responds well to it.
- **Name the cause, not the fix.** "The list was refreshing while you typed"
  beats "resolved a state reconciliation issue".
- **He is not a developer.** When he asks for steps, give numbered steps and say
  *where* — terminal, Supabase, text editor, or the app. He has asked for this
  twice; both times it was because an answer mixed all four together.
- **Do not pad.** He manages context deliberately, which is why this file exists.

### The pattern worth carrying

Of the bugs found on his phone, **most were shape problems, not logic
problems** — a value that could hold states which should not exist. Three
booleans describing eight states when four are real; one fact owned by two
files; a time plus an "enabled" flag that can disagree.

Each fix made the broken state *unrepresentable* rather than correcting the
branch that produced it. **When something breaks twice in the same component,
stop fixing the branch and change the shape.** §19 has the full table, each with
the test that now stands over it.
