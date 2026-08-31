# Handoff — Sagarmatha Payments

You are picking up a build that is seven phases in and working. This file is the
entry point: read it, then the three documents in §1, then start.

**Everything below §3 is operational knowledge that was expensive to learn the
first time.** Reading it costs three minutes; re-deriving it costs a session.

---

## 1. Read these, in this order

| File | What it is |
|---|---|
| `sagarmatha-payments-spec.md` | The client's own spec. **What** to build. His words, his priorities. |
| `CLAUDE-CODE-NOTES.md` | **Where the bugs will be.** Written from a previous app of his that shipped these exact failures. Not hypothetical. |
| `ARCHITECTURE.md` | **How** it is put together, and every decision taken since, with reasoning. §19 is the current state of the build. |

Do not skim the notes. Ten bugs have been found in this build — nine on a real
phone, one by writing down what a function's outcomes actually were — and five
of them are named in that file before they happened.

---

## 2. What this is

An internal tool for Sagarmatha Holdings Group — four businesses, four people —
to log supplier invoices and tick off payments. Not a product. It is optimised
for one number: **under 15 seconds to log an invoice on a phone, one-handed,
from cold app open.** That target has been measured and met; the client's words
were "it feels instantaneous". Every feature decision defers to it.

- **Live:** https://shg-invoices.vercel.app
- **Repo:** `SaHG2026/SHG-invoices`, branch **`main`** — which holds everything.
  `phase-1-foundation` and `tidy-up-before-phase-7` are history and can be
  ignored. There was no `main` until handover; the branch-per-phase convention
  in `ARCHITECTURE.md` §14 was never followed and is not worth starting now.
- **Database:** Supabase, project `wkjesptogulnemfhmfod`
- **Local config:** `.env.local` (gitignored, already populated)

**Everything is built, deployed and in use.** Phases 1–7, the client-driven
revisions between 6 and 7, push, and the go-live reset. §33 is the state at
handover and the list of audit findings that were accepted rather than fixed —
read it before concluding anything looks wrong.

`ARCHITECTURE.md` carries the reasoning for every one of them:

| | |
|---|---|
| §20 | Side menu, SHG Invoices branding, customers, Settings |
| §21 | The home screen rebuilt to the client's mockup |
| §22 | Photographs on the chips, logos on the businesses |
| §23 | The tick that appeared to erase two invoices; motion; pill buttons |
| §24 | Second round of phone feedback — the sheet, the menu counts, renames |
| §25 | Sales invoices: what customers owe. The sheet's third and final fix |
| §26 | Copy trimmed; only Mani is notified about payments |
| §27 | The green repaint; screens push and pop by URL depth |
| §28 | Going live: the clean slate, who counts as one of the four, Phase 8 closed |
| §29 | **Phase 7** — the offline queue, the service worker, error boundaries, push |
| §30 | Rabindra becomes the builder; logos and photographs change without a deploy |
| §31 | The third motion pass — why it was abrupt; the go-live reset |
| §32 | Signing out no longer discards unsent work |
| §33 | **Handover** — the audit findings accepted, and what is next |

**Phase 7 is built, deployed and switched on** — the offline write queue, the
service worker, error boundaries, the 200-row pass, and push all the way
through to a phone. `ARCHITECTURE.md` §29, and `db/push/README.md` for how the
sending half is wired if it ever needs re-doing.

**The go-live reset has been run.** The ledger is empty on purpose: every
supplier, invoice and customer from the build was test data and was deleted
before the three of them started (§31.2). An empty app is the expected state,
not a broken one.

**§4 rule 8 still applies to whatever comes next.** §33.2 has the piece of
work the client has already named, and it is deliberately not soon.

### Four things Phase 7 decided that are easy to undo by accident

1. **Push names nobody in code.** Only Mani is told when a bill is *paid*, and
   that lives as `profiles.notify_on_payment` — true for one row, deliberately
   outside the `self_update` column grant so nobody can turn it on for
   themselves. The single place his name appears is an `UPDATE` in
   `CATCH_UP_006.sql`, setting data. Never a branch on a display name.
2. **Nothing in the app ever asks anybody to enable push.** No prompt, no
   interstitial, no badge about the Home Screen. §28.4: build the capability
   and stop. The switch is in Settings and that is the whole of it.
3. **The service worker touches no writes, and must never.** `public/sw.js`
   returns early on anything that is not a same-origin GET. A worker that
   retries writes is a second queue in a second process, and two queues that
   can both send the same invoice is how an invoice gets entered twice.
   Background Sync makes exactly that mistake easy and appealing.
4. **Everything a write needs must be in its variables, never in a closure.**
   A queued write is resumed by key from a cold start, with no component left
   holding what it captured. `lib/offline/keys.ts` has the full account, and
   `test/unit/offline-queue.test.ts` fails if a new write is added to `mk`
   without a function registered for it.

---

## 3. Running it

```bash
npm run dev          # localhost:3000
npx vitest run       # 532 tests
npx tsc --noEmit
npx next build
```

**Always run the suite under three timezones before committing.** The app's
worst historical bug class is date handling, and a Sydney-only pass hides it:

```bash
for tz in UTC Australia/Sydney America/Los_Angeles; do TZ=$tz npx vitest run; done
```

### Looking at the app without signing in

`test/preview-dashboard.test.tsx` renders the real components against the real
fixture and writes standalone HTML. Skipped unless `PREVIEW_OUT` is set.
`ARCHITECTURE.md` §21.6 has the commands. It is the only way to see a screen
without credentials, and it is how the green repaint was shown to the client
before it shipped.

### Deploying

```bash
npx vercel deploy --prod --yes
```

It now aliases `shg-invoices.vercel.app` itself, and says `Aliased` in the
output when it has. Earlier notes in this file said a second
`vercel alias set` was always required — check the output before reaching for
it, and only run it if the alias line is missing.

There is no GitHub auto-deploy: the client's Vercel account has no GitHub
connection. Every release is manual, and it is his to run — the CLI login
lives on his machine.

### Database changes

There is no migration CLI in the loop. **The client applies SQL by hand** in the
Supabase SQL editor. So:

- `db/migrations/` is the source of truth for a fresh install
- `db/CATCH_UP_00N.sql` are deltas already sent to him and applied
- Write a new `CATCH_UP` file, send it with `SendUserFile`, and make it
  **idempotent** — he will sometimes run it twice
- Batch changes. Each file is a round trip through a person.

---

## 4. Rules that must not be broken

These are not preferences. Each one is load-bearing and several were paid for.

1. **No service-role key. Anywhere.** Not in the app, not on Vercel, not in a
   script. `auth.uid()` returns null under it, which silently destroys the
   attribution on every invoice. If the key does not exist, the trap cannot be
   sprung. This is why the app is client-first (`ARCHITECTURE.md` §1).

2. **`new Date()` appears in `lib/date.ts` and nowhere else.** `toISOString()`
   is banned outright — it is the literal mechanism of his previous app's
   worst bug. Calendar dates are `'YYYY-MM-DD'` strings and are never parsed
   into a `Date`.

3. **Hex colours exist only in `app/globals.css`.** Components use tokens.
   Two documented exceptions, both of which cannot read a CSS variable by
   nature rather than by convenience: `app/manifest.ts`, because a web
   manifest is JSON; and `app/global-error.tsx`, which renders when the root
   layout has failed — which is exactly when the stylesheet cannot be relied
   on, and a boundary that renders white-on-white is not a boundary.

4. **One array, one total.** Every figure on a screen is derived from the same
   array the list renders (`ARCHITECTURE.md` §2). A total from a separate query
   is the bug notes §3 calls "trust-destroying".

5. **Nothing is ever deleted.** Void with a reason. Deactivate, do not remove.
   The one thing that is genuinely replaced rather than kept is a logo or a
   photograph (§30.2) — a picture is not a record of anything, and Remove
   puts back what shipped rather than leaving a hole.

6. **Money is integer cents**, parsed and formatted only by `lib/money.ts`.

7. **Do not add** an ORM, Redux, tRPC, a state-machine library, a component
   library, or a charting library. Spec §4 rules them out and the surface is
   small enough that every one of them would cost more than it saved.

8. **Stop at the end of each phase.** Report, then wait. The client's notes ask
   for this explicitly.

---

## 5. Things that will waste your time if you do not know them

Learned the hard way in this project.

**Bash heredocs break on quotes here.** Writing a `.tsx` or `.sql` file with
`cat <<'EOF'` fails unpredictably on apostrophes and `$$`. Use the Write tool
for anything non-trivial; use Python `pathlib` for surgical edits to existing
files.

**Browser-pane screenshots render stale frames.** They will show a blank or
half-painted page while the DOM is perfectly correct. Do not debug from them —
measure with `javascript_tool` (`getBoundingClientRect`, `getComputedStyle`)
and trust that instead. This found a real bug: the dashboard's headline figure
looked fine in a screenshot and was one character from overflowing its card
(`ARCHITECTURE.md` §21.5).

**The app cannot be opened without a session, so there is a way to look at it
without one.** `test/preview-dashboard.test.tsx` renders the real components
against the real fixture and writes out standalone HTML with the built
stylesheet. Skipped unless `PREVIEW_OUT` is set — `ARCHITECTURE.md` §21.6 has
the four commands.

**`use(params)` never resumes in a bare test render.** This is why every
dynamic route is a two-file pair: a thin `page.tsx` that awaits the params, and
a screen component in `components/screens/` that takes a plain value. Keep that
split — it is what makes the screens testable.

**Component tests need the full mock set.** Anything rendering `AppChrome`
reaches `useRecentActivity` via the header bell, and marking paid is reachable
from every list. A test file that mocks only what it thinks it needs passes
alone and fails in the suite. Mock all five: `session`, `invoices`,
`reference`, `detail`, `payments`.

**Testing Library cleanup is registered manually** in `test/setup.ts`, because
Vitest runs without globals. Without it renders stack up and queries find
duplicates.

**Accessible names collide.** The header shows the signed-in person's name, so
`getByRole('button', { name: /Rabindra/ })` matches two things. Scope queries
with `within()`.

---

## 6. What is still owed

**Nothing is blocking. The app is live and in daily use.** Everything below
is either waiting on real usage or waiting on the client.

### Done, so nobody re-derives them

Every database file through `CATCH_UP_009_RESET` has been run. Push is fully
wired and sending. Rabindra is the builder — out of the lists, out of both
notification audiences, access untouched. Logos and photographs are his to
change from `/brand` without a deploy. The go-live reset has been run and the
ledger started empty.

### The next piece of work, deliberately not yet

1. **Export by date range**, in his words *"from this date to this date export
   in excel or csv etc."* §33.2 has the shape and the one question to ask him
   before building it: what happens to the file when it arrives. That answer
   decides between an hour of CSV and half a day of `.xlsx` plus the first
   dependency added purely for output.
   **After a month of real use**, per spec §11's discipline and his own words.

### Small things, whenever

2. **Deli Delights' logo**, when he sends it — and it is no longer a job for
   whoever has the repo. He adds it himself at `/brand`, reachable from
   Settings. `lib/logos.ts` remains the fallback for what shipped.
3. **Supplier payment terms.** Suppliers created from the add-invoice sheet
   have none and fall back to 14 days. The suppliers list counts them; the
   supplier page sets them. Worth a prompt once real suppliers exist.
4. **Tidying the audit left behind** (§33.1): three unused packages
   (`lucide-react`, `react-hook-form`, `@hookform/resolvers`), the `/specimen`
   page, and the middleware's `offline` exemption matching more than it should.
   None of it does harm; all of it makes the next audit shorter.

### Known and deliberately accepted — do not "fix" these

The pre-release audit found eleven things. One was a defect and was fixed
(§32). **The other ten were weighed by the client and accepted**, on the
reframing that this is a reminder layer over records that live elsewhere —
not a system of record. §33.1 has each one with his reasoning.

If you are auditing this app and find no automatic backups, an open deletion
path outside the app, or staff photographs at public urls: **those are
decisions, not oversights.** Read §33.1 before raising them again. If the app
ever stops being a notebook and starts being the record, every one of them
must be reopened — that is the condition the acceptance rests on.

**Closed:** Deli Delights receivables. §17 scoped a Phase 8 of three tables;
the client's ruling is that `customers` and `sales_invoices` are the whole of
it. **Part payments are carried by a note and a moved due date**, on both
sides, and deliberately not by an `amount_received_cents` column — a
partial-payment field is the first plank of an accounts package. §28.3 has
what that costs.

---

## 7. How to work with this client

`CLAUDE-CODE-NOTES.md` §7 is accurate and worth re-reading in full. In practice:

- **He tests on a real phone and reports precisely.** "When I check certain
  invoices the whole lot gets checked off" was one bug described from two
  symptoms. Take the report literally and look for the single cause.
- **He is right about his own product more often than the spec is.** Twice he
  has asked for something the spec forbade and been correct both times — the
  tick on list rows, and removing reference numbers from the UI. When his
  instruction conflicts with the spec, re-read the spec's *reasoning* before
  pushing back; usually it does not say what you thought.
- **Lead with the uncomfortable part.** If something cannot be done, or you got
  something wrong, say it first and plainly. He responds well to it.
- **Name the cause, not the fix.** "The list was refreshing while you typed"
  beats "resolved a state reconciliation issue".
- **Do not pad.** He manages context deliberately — which is why this file
  exists.
- **He is not a developer**, but he specified this app precisely and built the
  previous one himself. Explain mechanisms, not concepts.

### The pattern worth carrying

Of the eight bugs found on his phone so far, **five were shape problems, not
logic problems** — a value that could hold states which should not exist. Three
booleans describing eight states when only four are real; one fact owned by two
files; a run and its children sharing one expansion value.

Each fix made the broken state *unrepresentable* rather than correcting the
branch that produced it. When something breaks twice in the same component,
stop fixing the branch and change the shape.

`ARCHITECTURE.md` §19 has the full table, each with the test that now stands
over it.
