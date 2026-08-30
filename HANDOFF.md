# Handoff — Sagarmatha Payments

You are picking up a build that is six phases in and working. This file is the
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

Do not skim the notes. Eight bugs have already been found on a real phone in
this build, and five of them are named in that file.

---

## 2. What this is

An internal tool for Sagarmatha Holdings Group — four businesses, four people —
to log supplier invoices and tick off payments. Not a product. It is optimised
for one number: **under 15 seconds to log an invoice on a phone, one-handed,
from cold app open.** That target has been measured and met; the client's words
were "it feels instantaneous". Every feature decision defers to it.

- **Live:** https://shg-invoices.vercel.app
- **Repo:** `SaHG2026/SHG-invoices`, branch `tidy-up-before-phase-7`
  (everything through Phase 6 is on `phase-1-foundation`; the branch-per-phase
  convention in `ARCHITECTURE.md` §14 was not followed until now)
- **Database:** Supabase, project `wkjesptogulnemfhmfod`
- **Local config:** `.env.local` (gitignored, already populated)

Phases 1–6 are built, deployed and signed off. **Phase 7 is next** — PWA
hardening, offline write queue, error boundaries, a 200-row performance pass,
and push notifications. The client said there were "more bits to tidy up"
before starting it, so **ask before beginning Phase 7.**

Those tidy-up bits are on `tidy-up-before-phase-7` and are **not** Phase 7.
`ARCHITECTURE.md` §§20–26 have the reasoning; the short version:

| | |
|---|---|
| §20 | Side menu, SHG Invoices branding, customers, Settings |
| §21 | The home screen rebuilt to the client's mockup |
| §22 | Photographs on the chips, logos on the businesses |
| §23 | The tick that appeared to erase two invoices; motion; pill buttons |
| §24 | Second round of phone feedback — the sheet, the menu counts, renames |
| §25 | Sales invoices: what customers owe. The sheet's third and final fix |
| §26 | Copy trimmed; only Mani is notified about payments |

**Next, and agreed with the client: a green repaint**, then Phase 7. Every
colour is a token in one `:root` block in `app/globals.css` — a repaint is that
block and nothing else, which is why it is worth doing as its own commit.
**Ask before starting Phase 7 proper.**

---

## 3. Running it

```bash
npm run dev          # localhost:3000
npx vitest run       # 464 tests
npx tsc --noEmit
npx next build
```

**Always run the suite under three timezones before committing.** The app's
worst historical bug class is date handling, and a Sydney-only pass hides it:

```bash
for tz in UTC Australia/Sydney America/Los_Angeles; do TZ=$tz npx vitest run; done
```

### Deploying — two commands, and the second is easy to forget

```bash
npx vercel deploy --prod --yes
npx vercel alias set <new-deployment>.vercel.app shg-invoices.vercel.app
```

**Without the alias step the stable URL still serves the previous build.**
There is no GitHub auto-deploy: the client's Vercel account has no GitHub
connection. Every release is manual.

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

3. **Hex colours exist only in `app/globals.css`.** One documented exception:
   `app/manifest.ts`, because a web manifest is JSON and cannot read a CSS
   variable. Components use tokens.

4. **One array, one total.** Every figure on a screen is derived from the same
   array the list renders (`ARCHITECTURE.md` §2). A total from a separate query
   is the bug notes §3 calls "trust-destroying".

5. **Nothing is ever deleted.** Void with a reason. Deactivate, do not remove.

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

0. **Push must not name Mani.** Only he is notified when a bill is paid
   (`ARCHITECTURE.md` §26), and the client asked for it explicitly. Implement it
   as `profiles.notify_on_payment`, true for one row and outside the
   `self_update` column grant — never as a branch on a display name.
1. **Supplier payment terms.** Suppliers created from the add-invoice sheet
   have none and fall back to 14 days. The suppliers list counts them; the
   supplier page sets them. Worth prompting him to do a pass.
2. **CSV export.** Waiting on the bookkeeper's answer to *"what do you do with
   the file when you get it?"* CSV is an hour. A real `.xlsx` is half a day and
   the first dependency added purely for output. `ARCHITECTURE.md` §17.
3. **`CATCH_UP_003.sql`** may still be unrun (accents as slot names). The app
   tolerates either, so it is not urgent.
3c. **Rabindra's photograph**, if his test account is staying. The other three
   are in `public/people/`. Add a square file and one line in `lib/logos.ts`.
   **Name it lower-case** — Windows does not care and Vercel's Linux
   filesystem does; a test now stands over that.
   Deli Delights has no logo either — same deal, `ARCHITECTURE.md` §22.
3a. **`CATCH_UP_005.sql` — sales invoices.** What customers owe. Until it is
   run, recording an invoice to a customer fails and every receivable figure
   reads zero. `ARCHITECTURE.md` §25.2.
3b. **`CATCH_UP_004.sql` — the customers table. This one IS urgent**: it has
   been sent but until it is run, the Customers screen cannot load. Unlike 003
   the app cannot work around it, because the table genuinely is not there. The
   screen says so by name rather than showing an empty list.
4. **Rabindra's test account** goes inactive when he is done —
   `db/seed/002_profiles.sql`, statement commented out at the bottom.
5. **Deli Delights receivables** — Phase 8, after a month of daily use. A second
   ledger, not a flag on this one. `ARCHITECTURE.md` §17 explains why.

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
