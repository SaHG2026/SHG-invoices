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
| Rounds A–H, the most recent work | §35–§42 |
| J1 — the two bugs, and the tiers | §46 |
| The audit from scratch, and what it found | §43 |

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

**Who is who.** Mani (owner, CEO), Milan (manager, COO), Sujan (manager, GM),
Rabindra (builder — maintains the app, out of every list and both notification
audiences, access untouched). Plus two shared shop logins, GMP and GMH, role
`staff`.

### The one thing that everything else assumes

**`role` is a permission, for two values now.** `staff` decides access, and
since J1 so does `owner` — for exactly one thing: **only an owner may move a
bill between paid and unpaid**, or change anybody's role. `manager` and
`builder` decide only what a screen shows.

`is_manager_or_above()` (called `is_member()` until CATCH_UP_019) was narrowed
rather than nine policies edited, so **a policy written in a later phase
excludes venues by default** — write `is_manager_or_above()` like all the
others and it is already right. §34, §46.3.

The trap it replaced: three role filters written as `role <> 'builder'`, and a
blocklist admits every role invented after it. They are allowlists now. **If
you add a role check anywhere, write it as an allowlist** or it will quietly
include whatever comes next.

**And an allowlist fails the opposite way.** Renaming `member` to `manager` in
J1 meant visiting **six** allowlists on purpose, because a tier added without
visiting each one is a tier quietly excluded. §46.3 names all six — four in
SQL, two in `lib/staff.ts`. Adding a seventh tier means the same walk.

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
npx vitest run       # 784 tests
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

Two unit test files write pages the same way, from mocks they already had:
`test/unit/customers.test.tsx` (a customer, shut and open, plus Receivables)
and `test/unit/settings.test.tsx`. Same two variables, same skip.

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
- `db/CATCH_UP_0NN.sql` are deltas already sent and applied — **001 to 018**.
  **019 is written and NOT yet run** — §7 below
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

**Live and in daily use. All database files through `CATCH_UP_018` applied;
`CATCH_UP_019` is written and waiting.** 784 tests under three timezones.

Phases 1–7, the venue accounts (§34), then eight rounds of feedback:

| | |
|---|---|
| §35 | **Round A** — the Home figures became links; edit/remove made findable; supplier totals between two dates |
| §36 | **Round B** — a shop's invoice waits to be approved; shops choose a supplier rather than creating one; a note on every entry |
| §37 | **Round C** — a daily reminder at a time each person chooses |
| §38 | **Round D** — Deli's products, line items and printable invoice |
| §39 | **Round E** — Deli's price list became the compose screen, and the two ways in |
| §40 | **Round F** — due dates optional, Receivables, invoices that open into their bill |
| §41 | **Round G** — the dark band, attribution on issued invoices, and the tap delay |
| §42 | **Round H** — the Himalaya, softer greens, the review card archived |
| §46 | **J1** — the two bugs, and three real tiers |

### The two lessons worth more than the features

**A fence proven to keep things out has not been proven to have a gate.**
`verify_staff.mjs` passed for weeks while a shop could not save a single
invoice, because from outside a missing permission and a working refusal are
both `42501`. Its one positive write test sat behind `--write` and was never
run. `db/diagnose_venue_write.mjs` is the other half; run both after any change
to the staff policies.

**A change made for appearance can silently disable behaviour elsewhere.**
`overflow-hidden`, added to the header to contain the mountain ridge, clipped
the activity panel that hangs below it — the bell was dead for a whole round
while the panel rendered perfectly every time. **jsdom does no layout, so no
rendering test can see this class of bug.** Assert the structural fact, and
measure the real thing with `getBoundingClientRect`. §45.

**"It doesn't feel smooth" is usually not the animations.** Two of the four
causes in §41.5 were not animation at all — a missing `touch-action:
manipulation` putting every tap ~300ms behind the finger, and Chrome's grey
flash painting over the considered transition. **Check what happens BEFORE the
animation starts before touching a keyframe.**

**A check that is never extended stops being a check and becomes a claim.**
`verify_rls.mjs` was proving 8 of 11 tables and reading as though it proved
all of them; `verify_catchups.mjs` covered 5 of 18 migrations and could not
see a column at all. Both had been green for months. **When you add a table or
a column, add it to the verifier in the same commit.** §43.2.

**A default is a claim.** A due date filled in because the field wanted one
prints a deadline nobody agreed to, and drives every overdue figure off it.
Where the honest answer is "nobody has decided", the column is nullable and
the switch is off. §40.1.

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

## 6b. What is being built next — J1 to J5

**J1 is built (§46) and its SQL is not yet run. J2–J5 are agreed, not
started.** ARCHITECTURE §44 has the design and the reasoning for each, §46 has
what J1 actually did. Build in order: J2 defines the document J3 renders.

| | | |
|---|---|---|
| **J1** | **Done** — §46 | Add-customer while composing; Edit moved inside the panel it edits. `member` is now `manager`, paid/unpaid is the owner's alone, `set_user_role` promotes and demotes, the builder is an invisible owner. |
| **J2** | The document | Deli's contact block, bank details, signature line. Owner-only to edit, printed on every invoice. §44.3 |
| **J3** | Download, Share, Print | A hand-written PDF, shared through the phone's own share sheet. **Gmail-with-attachment is not buildable as asked** — `mailto:` cannot carry a file; the share sheet does the same job. §44.4 |
| **J4** | Export and the wipe | Full-history CSV, and an owner-only in-app wipe behind four conscious acts. §44.5 |
| **J5** | Discounts and refunds | **Deli's customers only** — the receivables side; payables untouched. **Manager level**, unlike marking paid. Append-only adjustment rows carrying who and why, every total derived. Reopens a decision §28.3 closed. §44.6 |

**The three things J1 established, which the rest of the roadmap leans on:**

1. **Six allowlists, all named in §46.3.** J2–J5 each ask a permission
   question; ask it with `is_owner()` or `is_manager_or_above()` and it is
   already right.
2. **`set_user_role` refuses five things**, and each refusal comes back as a
   sentence the screen shows verbatim. CATCH_UP_019 §6 has why each matters.
3. **The builder is hidden from lists, never from attribution.** An account
   that can move money and leaves no trace makes the audit trail lie. §44.2.

**Settled since the roadmap was written:** the signature line is a ruled line
on the paper, nothing stored. The PDF is written by hand rather than imported.
Discounts are Deli-only and manager-level.

**Not being built, and why:** creating and deleting logins. Supabase does that
only through the Auth Admin API, which needs the service-role key — rule 1, the
one thing this architecture is built to not have. Deactivating covers the real
need, and the client agreed.

---

## 7. What is still open

**One thing is blocking, and it is a round trip through a person.**

0. **`db/CATCH_UP_019.sql` has not been run.** Send it, and say plainly that it
   goes in **before** the deploy. It renames the role `member` to `manager`,
   so between the SQL and the deploy Milan and Sujan will see a venue
   account's drawer — minutes, not hours. The other order is worse: the new
   bundle expects `manager` and would find `member`.

   Afterwards, the two things the file's own §7 block cannot prove from
   outside: sign in as Milan and confirm there is no tick on the week and no
   **Mark paid** on an invoice, and confirm **Who can do what** is on Mani's
   Settings and not on Milan's.

1. **Done** — CATCH_UP_018 added `is_mine` to `staff_invoices` and
   `stillCorrectable` checks it (§43.1). **Still unverified behaviourally:**
   `verify_staff.mjs` needs `STAFF_EMAIL`/`STAFF_PASSWORD` in `.env.local` and
   they are not on the builder's machine. Run it, or run the query at the
   bottom of `db/CATCH_UP_018.sql` signed in as a shop.

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

6. **Done** — `/receivables` is the global list of what Deli is owed (§40.3).
   Left here as the shape of the answer: it was held until chasing money
   across customers became the actual job, and then it was one screen.

7. **Mostly done** (§43.2). The three unused packages are gone. `/specimen`
   and the middleware's `offline` exemption stay, with reasons recorded.

8. **`npm audit` reports one high and one moderate**, both `postcss` via
   `next`, both about processing untrusted CSS at build time — unreachable by
   any user of this app. The only fix is Next 15 → 16, a major version. Worth
   doing deliberately, on its own, never bundled with other work. §43.2.

### The clean slate

`db/RESET_TO_CLEAN_SLATE.sql` is the file that emptied the app before it went
into real use. It deletes every invoice, sales invoice, note, activity row and
both counters, plus suppliers, customers and products; it keeps the six
logins, the four businesses, push subscriptions and uploaded artwork. One
transaction, so there is no half-wiped state.

**The trap it documents, if it is ever run again:** a phone can be holding
work that has not been sent. That queue does not know the wipe happened, and
will send after it. Every phone has to be online with an empty queue — the
number beside the wifi symbol — before the file runs.

### Archived, not abandoned

**The review card on the home screen** (§42.4). Removed at his request because
the bell, the drawer badge and the Review menu row all mention the same thing.
The comment where it stood records what it was, and a test asserts it is gone.
**All three replacements require somebody to look; the card was the only one
that spoke unasked.** If shop entries start sitting in review for days, bring
it back first.

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

### The lesson from J1

**A placeholder that looks like a control is a control that does nothing.**
The customer page printed an em dash for an empty value, in the column where a
control belongs, and it was reported — correctly — as an edit button that did
not work. The fix was not to move the real button; it was to make the row
itself the control and say **Add**. §46.1.

Its twin, and the third time this project has met the shape: **a change made
for appearance can silently disable behaviour elsewhere.** Round F folded
Details into a panel for the look of the page and left the button that edits
it outside, and the two stopped looking related. §45 was the same thing with
`overflow-hidden`. §39.8 was the same thing with a mocked hook.

### The pattern worth carrying

Of the bugs found on his phone, **most were shape problems, not logic
problems** — a value that could hold states which should not exist. Three
booleans describing eight states when four are real; one fact owned by two
files; a time plus an "enabled" flag that can disagree.

Each fix made the broken state *unrepresentable* rather than correcting the
branch that produced it. **When something breaks twice in the same component,
stop fixing the branch and change the shape.** §19 has the full table, each with
the test that now stands over it.
