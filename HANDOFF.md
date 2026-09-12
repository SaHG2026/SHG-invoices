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

`ARCHITECTURE.md` is 360KB and is an archive, not a briefing. Do not read
it end to end. Grep for the section you need:

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
| J2 — what is printed on an invoice | §47 |
| J3 — the PDF, and how a file leaves the app | §48 |
| J4 — the export, the wipe, and the dialog bug | §49 |
| J4b — the workbook, the archive, and a lying status column | §50 |
| The assistant tier, and J5 | §52, §53 |
| Rounds K and K2 — the `+`, the placeholder, payment history | §56, §57 |
| The placeholder row that was never created | §58 |
| Why a migration's notices are never read | §59 |
| The Review screen's create control, and the year-old test flake | §60 |
| The wipe, and Supabase's safeupdate guard | §61 |
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

**Who is who**, as of 2026-09-11, read out of the database rather than
remembered — `db/verify_catchups.sql` row 24 lists it:

Mani (owner, CEO), Milan (manager, COO), **Sujan (assistant** — was manager,
GM), Rabindra (builder — maintains the app, out of every list and both
notification audiences, access untouched). Plus shop logins GMP and GMH, role
`staff`, and a third, **Test Shop, suspended**.

**Sujan is an assistant now, and that is a bigger change than a label.** §7
item 7 records that Sujan is one of only three accounts that has ever signed
in, so the tier §52 built for a hypothetical person is now held by the app's
most active real user — every screen §52 hides and every permission it
withholds is live for somebody who uses this app daily.

What that did NOT cost him is §7 item 12: the notification exclusions looked
like a silent loss and were checked rather than assumed, and he had never set
a reminder.

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
SQL, two in `lib/staff.ts`.

**§52 added a fourth tier and deliberately visited NONE of them.** `assistant`
is not in `is_manager_or_above()`, not in `isFullMember`, and not in either
push audience or the reminder — every one of those exclusions is correct, and
the file says so in each place so that silence is not mistaken for an
oversight. What it added instead is `is_assistant()` and `roleMayBeChanged`,
which are narrower questions. **A fifth tier means asking the same question at
all eight, and the answer will not be the same at every one.**

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
npx vitest run       # 1062 tests
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

**And the PDF writes real files**, which matters more than the rest: every
assertion about it is the program checking its own arithmetic, and the only
proof a PDF is a PDF is a reader opening it (§48.3).

```bash
PDF_OUT=/tmp/shg/invoice.pdf npx vitest run test/unit/pdf.test.ts
```

**The workbook is the same discipline** (§50.3). The only proof an `.xlsx` is
an `.xlsx` is a reader opening it, so it writes real files too — a workbook and
a zip of workbooks:

```bash
WORKBOOK_OUT=/tmp/shg npx vitest run test/unit/workbook.test.ts
```

Both were verified with Python's `zipfile` and `ElementTree`, which know
nothing about this app. The assertion that matters is that **the Amount column
sums**: a text column sums to zero and looks perfectly fine.

Three files — the ordinary invoice, a 45-line one for the page break, and the
no-bank-details one the app is live with. A static file server sends a `.pdf`
as a download rather than rendering it, so put them in an `<iframe>` on a
scratch HTML page to look at them.

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
- `db/CATCH_UP_0NN.sql` are deltas already sent and applied — **001 to 030,
  all applied.** 028 repaired the missing "Supplier not listed" row and 029
  made it an invariant a wipe cannot lose. Its diagnosis of WHY it was missing
  was printed with `raise notice` and is therefore lost — §59
- Write a new `CATCH_UP`, send it with `SendUserFile`, make it **idempotent**
- **`RAISE NOTICE` IS INVISIBLE in the Supabase SQL editor.** It shows result
  grids and errors and swallows notices, so every `raise notice 'ok'` in every
  file here has been printed into nothing. A check must `raise exception` to
  be felt; anything you want the client to READ has to be a `select`. §59
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

**PARSE EVERY `.sql` FILE BEFORE SENDING IT.** A file goes to the client by
hand, so a syntax error costs a round trip through a person — the most
expensive unit of time in this project. Balanced brackets and a tidy diff are
not a parse; `verify_catchups.sql` went out with two `union all` in a row and
came back `42601`. §59.6.

```bash
pip install pglast   # once
python -c "import pglast,glob; [pglast.parse_sql(open(f,encoding='utf-8').read()) for f in glob.glob('db/**/*.sql',recursive=True)]" && echo PARSE OK
```

**`RAISE NOTICE` is invisible in the Supabase SQL editor.** It shows result
grids and errors and swallows notices, so every `raise notice 'ok'` in every
CATCH_UP file has been printed into nothing. A check must `raise exception` to
be felt; anything the client should READ has to be a `select`. §59.

**Bash heredocs break here, and backslashes are the worst of it.** Writing a
`.tsx`, `.sql` or `.md` file with `cat <<'EOF'` fails on apostrophes, `$$` and
em dashes — and a `python - <<'PY'` heredoc silently collapses `\\n` to a real
newline, which turns `'a\\nb'` in the patch into a string literal broken across
two lines. It looks like the patch worked and `tsc` reports an unterminated
string. **That happened five times in one session.**

Use the **Write tool** for anything non-trivial. For surgical edits to existing
files, write the Python to a file in the scratchpad and run it — never inline
in a heredoc if it contains a backslash.

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

**Live and in daily use. Every database file through `CATCH_UP_030` applied
and verified. J1 to J5 complete, and Rounds K to K2 with them.
Deployed — `916c2a1`, and `origin/main` matches.**

**Nothing is waiting on anybody.** 1062 tests under three timezones.

**The build stamp is a commit, so uncommitted work deploys anonymously.**
`next.config.ts` takes it from `VERCEL_GIT_COMMIT_SHA` or `git rev-parse
--short HEAD`. Round K was deployed before it was committed, so Settings
showed the *previous* commit while carrying the new code — §6's trap running
backwards, and the five-second "did my deploy land?" check answered a
question nobody had asked. **Commit before deploying, always**, or the stamp
is worse than useless.

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
| §47 | **J2** — the contact block, the bank details and the signature line |
| §48 | **J3** — a PDF written by hand, Download and Share |
| §49 | **J4** — the ledger as three CSVs, and the wipe behind four acts |
| §50 | **J4b** — Excel workbooks with sheets, a zip of them, and a status column that was lying |
| §50.6 | One button that says Change — the demote label nobody could reach |
| §51 | The notification badge, and the test that had to decode a PNG |
| §52 | The assistant tier — a person who logs a bill and cannot act on one |
| §53 | J5 — discounts and refunds, and everywhere the net had to reach |
| §54 | Suspending an account, and the lookup that was hiding half of them |
| §55 | Next 16, vitest 5, and a linter's first run over this codebase |
| §56 | **Round K** — the Add control the chevron hid, a `+` that means the screen it is on, near-duplicate names, and an assistant's placeholder entry that was never reviewed |
| §57 | **Round K2** — one column missing from three selects, and payment history's four doors |
| §58 | The placeholder row that was never created, and the app that failed silently without it |
| §59 | Every "ok" a migration printed, nobody read — and two checks that were themselves wrong |
| §60 | The Review screen's create control, disabled under a comment saying it was the point |
| §61 | The wipe refused itself: ten bare deletes against Supabase's safeupdate guard |

### What this codebase has learned the hard way

The reasoning for each is in `ARCHITECTURE.md` at the section named. These are
the one-line versions; do not go looking for the control, go looking for the
§.

**Two that carry an instruction rather than a caution:**

**A fence proven to keep things out has not been proven to have a gate.**
`verify_staff.mjs` passed for weeks while a shop could not save a single
invoice, because from outside a missing permission and a working refusal are
both `42501`. **Run `db/verify_staff.mjs` AND `db/diagnose_venue_write.mjs`
after any change to the staff policies** — one proves the fence, the other the
gate. Both proven 2026-09-11.

**`.upsert()` is not `.insert()` under RLS.** PostgREST compiles an upsert to
`INSERT ... ON CONFLICT`, which brings the table's **UPDATE** policies into the
check. Where the replay guarantee is needed without upsert: generate the id on
the client, use a plain insert, and treat a `23505` naming **the primary key
and only that key** as the replay succeeding. `test/unit/venue-write.test.ts`.

**On checks, and trusting them:**

| | |
|---|---|
| A check that is never extended stops being a check and becomes a claim. Add a table or column to the verifier in the same commit. | §43.2 |
| A check never extended can cry wolf as easily as go blind — a standing false MISSING teaches everybody to skim past MISSING. Ask what it was protecting, not what it tests. | §59.4 |
| A conditional INSERT that finds nothing is indistinguishable from success. Seed with a check that RAISES. | §58.1 |
| A scan that finds nothing is indistinguishable from a scan searching for nothing. Make a check say what it SEARCHED, not just what it found. | §62 |
| A hand-written column list beside a cast is a type that has stopped being checked. Compare the list to something, in a test. | §57.1 |
| A mock that cannot produce a real state guarantees bugs in it. | §39.8 |
| A file that has not been parsed has not been checked, however carefully read. | §59.6 |
| When every failure is a timeout and never an assertion, the suite is reporting on the machine, not the code. | §60.1 |
| When somebody reports a partial failure of something that cannot partially fail, count the rows and show them. | §61.1 |

**On what the interface promises:**

| | |
|---|---|
| A control absent along the path somebody actually walks is absent. Go looking for the path, not the control. | §24.7, §56.1 |
| A comment describing behaviour is not behaviour. When a comment says a control exists, check that it does. | §60 |
| A label is a promise, and an unkept one reads as broken. | §39.1 |
| An interface that cannot offer what it was told to offer should say so — the mirror of notes §6. | §58.2 |
| A default is a claim. Where the honest answer is "nobody has decided", the column is nullable and the switch is off. | §40.1 |
| Read the size of an instruction, not just its direction. "A little bit below" is a gap, not an anchor. | §48.4 |

**On mechanisms, and what they rest on:**

| | |
|---|---|
| Half a mechanism copied is a mechanism that does not work. When reusing a pattern for a new role, list what it DEPENDS on. | §56.2 |
| Ask what else reads through a policy before you narrow it — a permission change must not weaken a protection as a side effect. | §57.3 |
| A change made for appearance can silently disable behaviour elsewhere; jsdom does no layout, so measure with `getBoundingClientRect`. | §45 |
| "It doesn't feel smooth" is usually not the animations. Check what happens BEFORE the animation starts. | §41.5 |
| Ask the store what is in it before designing around what you assume. | §48.5 |

---

## 6b. The J roadmap — all of it delivered

**J1 to J5 are built, deployed and complete**, and so are Rounds K to K2.
ARCHITECTURE §44 has the design and the reasoning; §46–§53 have what was
actually done, including where §44 was overruled.

| | |
|---|---|
| **J1** §46 | Add-customer while composing; Edit inside the panel it edits. `member` became `manager`, paid/unpaid is the owner's alone, the builder is an invisible owner. |
| **J2** §47 | Deli's contact block and bank details, owner-only, printed on every invoice, plus a ruled signature line that stores nothing. Read **live**, not frozen — §47.1 overrules §44.3. |
| **J3** §48 | A PDF written by hand in `lib/pdf/`, no library, logo embedded as JPEG. Download always, Share where the phone can take a file. |
| **J4** §49, §50 | Three CSVs and Excel workbooks over an optional date range; the wipe behind four acts, gated on `is_owner()`. Deployed; `CATCH_UP_021` applied. |
| **J5** §53 | **Deli's customers only.** Manager level, unlike marking paid. Append-only adjustment rows carrying who and why, every total derived. |

**The three things J1 established, which everything since leans on:**

1. **Nine allowlists** — six named in §46.3, §52 made it eight, §59's
   `maySeePaymentHistory` is the ninth. Ask a permission question with
   `is_owner()` or `is_manager_or_above()` and it is already right.
2. **`set_user_role` refuses five things**, each coming back as a sentence the
   screen shows verbatim. CATCH_UP_019 §6.
3. **The builder is hidden from lists, never from attribution.** §44.2.

**Not being built, and why:** creating and deleting logins. Supabase does that
only through the Auth Admin API, which needs the service-role key — rule 1.
Deactivating covers the real need, and the client agreed.

---

## 7. What is still open

**Nothing is blocking.** Everything through `CATCH_UP_030` is applied, `npm
audit` is clean, and 1062 tests pass under three timezones. Live at
`916c2a1`, and `origin/main` matches.

**Confirm the database with `db/verify_catchups.sql`.** Paste it into the
Supabase SQL editor — it returns a table, which is the only thing that editor
shows (§59). Twenty-seven rows: every migration 001–030 it can see, the
placeholder supplier by name, what is filed against it, who can sign in, and
who the daily reminder reaches. Last full run 2026-09-11: **every row `ok`**,
two `info`.

### Never exercised — the real gap

Built, tested, and never used against live data by a person. Tests prove the
program checks its own arithmetic; they do not prove it works on a phone.

1. **The export has never been run against the live database.** Every byte the
   CSV and workbook writers produce is asserted and both were opened with
   independent readers (§50.3). The three *reads* behind them have never run
   with a real session. §49.4.

2. **The wipe's deletion has still never run.** It was attempted 2026-09-11
   and refused itself — ten bare `delete from x;` against Supabase's
   **safeupdate** guard, which loads per SESSION by the connecting role, so
   `SECURITY DEFINER` does not exempt it. `CATCH_UP_030` adds `where true` to
   all ten and it is applied. **Nothing was lost**: a plpgsql function is one
   transaction, confirmed by counting every table afterwards. §61.

   **Do not test the deletion on real data.** There is no backup at all
   (§33.1) and the ledger holds real invoices.

3. **No discount or refund exists yet.** J5's arithmetic, document, PDF and
   panel are tested against fixtures; nothing has been applied to a real
   invoice. §53.

4. **No assistant has filed against "Supplier not listed."** Sujan is a live
   assistant, so this is testable by a real person. File one on the
   placeholder and confirm it reaches **Review**, not Pending; then file one
   naming a real supplier and confirm it does the opposite — that second half
   is CATCH_UP_022 §5's decision and must still hold. §56.2.

   A shop has now done the first half for real (Parramatta, $300, note "Sokko
   Pastry"), which is what found §60.

### Waiting on the client, not on code

5. **Deli's bank details are still not set**, by choice — *"I don't have it."*
   The document handles it (§47.2).

6. **A 7-day undo after a deletion.** Asked for, still undecided. Nothing in
   the app deletes anything, so losing an account loses no data — but there is
   **no backup at all**, accepted at handover (§33.1). The real answer is
   Supabase point-in-time recovery, a paid add-on. Needs a decision, not code.

7. **Mani and Milan have never signed in.** `last_sign_in_at` is null for both
   (2026-09-11). Only Parramatta, Sujan and the builder have used the app.
   That reframes anything about notifications: it is not that they have not
   found the switch.

### Known, and not urgent

8. **`npm run lint` reports 15 problems**, all deliberate documented patterns
   — a ref read during render, `window.location.href` on sign-out, and nine
   `set-state-in-effect` findings that are the hydration pattern. The two that
   were real bugs are fixed. **Do not "fix" the fifteen** without reading what
   each protects. §55.5, §55.6.

9. **The app feels a touch slower on a phone.** Reported long ago, never
   diagnosed. The database is fast (~45ms warm), so this is round trips.
   §34.12 has the three things to localise.

10. **The PDF cannot draw Devanagari**, or any non-Latin script (§48.1). Print
    is unaffected and the CSV and workbook carry any name exactly (§49.1).
    Only worth reopening if a real customer name hits it.

11. **The daily reminder has no real users.** Exactly one exists — Rabindra at
    00:01, the builder's account, which reads as a leftover test value.
    **Asked and answered 2026-09-11: leave it as is.** Do not raise it again
    as a tidy-up.

    The near-miss worth keeping: an assistant is in none of the three
    notification audiences, and a `reminder_time` SURVIVES a role change — so
    anybody demoted after setting one would keep the switch in Settings and
    receive nothing. Sujan's demotion looked like that case and was not; he
    had never set one. `verify_catchups.sql` row 26 asks on every run.

### Closed this round, recorded so they are not re-opened

| | |
|---|---|
| The intermittent test failure, uncaptured for a year | every failure a 5s timeout, never an assertion; the suite saturates itself. `testTimeout` is 30s. §60.1 |
| Suspension never used | Test Shop is suspended, 2026-09-11 |
| Anything stranded on the placeholder | none — and §57.1 explains why the count could only have been zero |
| The venue fence and its gate | both proven, 2026-09-11 |
| `CATCH_UP_021` not run / J4 not deployed | both long since done |

---

## 7b. If the next session is a security, bug or stability review

Written for that, because it is the next thing planned.

### What has already been proven, and how — do not redo these

| | |
|---|---|
| **Anonymous access** | `node db/verify_rls.mjs` — every table refuses the anon key |
| **The venue fence AND its gate** | `node db/verify_staff.mjs` — **all pass**, 2026-09-11, as `gmp@shg.com`. §54's note explains why it must be run as Parramatta, not Hurstville |
| **Every migration applied** | `node db/verify_catchups.mjs` for what is visible from outside, then **`db/verify_catchups.sql` in the SQL editor** for the rest — 27 rows, clean through `CATCH_UP_030`, 2026-09-11 |
| **Schema, functions, policies** | `db/verify_schema.sql`, pasted into the Supabase SQL editor. **Re-run it — the last run predates `CATCH_UP_025`**, so `set_user_active`, `find_duplicate_invoices_assistant` and `ensure_placeholder_supplier` are not in that output |
| **Dependencies** | `npm audit` — 0 vulnerabilities, Next 16 and vitest 5 |
| **The assistant tier** | 8 policies, 6 read and 2 insert, and nothing that can UPDATE or DELETE. Confirmed in a live schema dump. §52.3 |
| **The workbook and the zip** | opened with Python's `zipfile` and `ElementTree`; the money column sums. §50.3 |
| **The PDF** | opened in a real reader. §48.3, §53.2 |

### Where the risk actually is

Not in the policies — those are measured. It is in these:

- **`is_owner()` gates seven things** and one of them is the wipe. If a fifth
  role is ever added, §46.3's allowlist walk is now **eight** places, and
  §52.2 explains why widening `is_manager_or_above()` is the tempting wrong
  move.
- **`wipe_everything` must stay SECURITY DEFINER.** As invoker it would delete
  nothing and report success, because RLS hides the rows and `delete` does not
  complain about rows it cannot see.
- **Three grants must stay narrow**: `profiles` update is two columns only,
  `profiles.active` has no grant at all, and `sales_invoice_adjustments` has
  no write policy whatsoever. Each is checked by its own CATCH_UP file's
  verification block.
- **The offline queue.** `lib/offline/keys.ts` is the list of writes that can
  be replayed from a cold start. The wipe and suspension are deliberately NOT
  on it; adjustments deliberately are. `test/unit/offline-queue.test.ts` fails
  if a write is added without being registered.

### What must NOT be reported as findings

**§33.1's ten accepted risks.** No backups, deletion possible outside the app,
`paid_by` forgeable by a crafted request, staff photographs at public urls, no
bucket size limit. The client weighed each on his own reframing — *"this is
meant to be just an advanced interactive notes"* — and accepted them. They are
decisions, not oversights. If the app ever stops being a notebook and starts
being the record, every one must be reopened; that is the condition the
acceptance rests on.

**And there is no rate limiting**, anywhere, by design: there is no server of
ours to put it in. Every request goes from the phone to Supabase. Anonymous
callers are refused by RLS, only six logins exist, and creating a seventh needs
the service-role key this architecture is built without. A signed-in account
making unlimited requests is unprotected, and that falls under the same
acceptance.

### The one thing a review should actually try

**Use the features nobody has used** — items 1 to 4 above. The policies are
measured; the untested surface is a person on a phone doing something for the
first time. Every bug this project has found on a real phone was a shape
problem, not a logic problem (§19), and no test suite has ever found one of
those.

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
