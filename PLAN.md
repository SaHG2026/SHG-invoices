# Plan — eight things from real use

Written after reading `HANDOFF.md`, `ARCHITECTURE.md` (§0–§34), the spec, the
notes, and the code each item touches. Nothing below has been built. This is
the design and the order, for approval before any of it starts.

Rule 8 applies: each round below ends with a report and a stop.

---

## 0. The uncomfortable parts, first

**1. The approval gate is the biggest change since the venue accounts, and it
changes what the app's central number means.** Architecture §2 makes one array
of unpaid invoices the source of every total on every screen. An invoice
awaiting review must not be in that array — it is not yet money the group has
agreed it owes — so from that day on, "outstanding" excludes something. The
failure mode is an invoice entered by a shop, never reviewed, and therefore
invisible everywhere. The defence is that the awaiting-review count is on Home
permanently and never collapses to nothing quietly. Designed in §2 below.

**2. I cannot diagnose the push problem from here.** No Supabase access, and
the answer is in `net._http_response` and `push_subscriptions`, both of which
need your login. `db/diagnose_push.sql` is a read-only file — it sends nothing,
changes nothing, and its output says which of four causes it is. That file
should go out first because it is a round trip through a person and everything
else can proceed while it travels.

**3. Deli's printed invoice has one question that decides its shape: GST.** A
tax invoice in Australia is a different document from a plain one — the words
"Tax invoice", the ABN, a GST line, and "Total includes GST of $X". Building
the plain one and adding GST later is not a small edit; it is the schema, the
totals and the layout. Asked separately.

**4. Three of these items touch the write paths, and HANDOFF says not to touch
them until the "feels slower on a phone" report comes back.** Read literally
that blocks §2, §3 and §4 below. My reading is narrower and I want it agreed
before starting: the rule protects the offline queue's *mechanics* — one write
per key, everything in the variables, no second queue. Adding a column to a
payload and a second queued write after the sheet closes does not change any of
that. What I will not do is restructure `submit.ts`, the persister, or the
resume order. If you would rather have the speed answer first, §1, §5 and §7
are app-only and can ship while you watch for it.

---

## 1. Touch on the overdue and pending figures

**Now.** `components/screens/Dashboard.tsx` — the two headline cards, Overdue
and Next 7 days, are `<div>`s. They are the two biggest things on the screen
and neither does anything when tapped. The list underneath them is tappable,
which is what makes the cards read as broken rather than as decoration.

**Change.** Both become links.

- Overdue → `/b/all/pending?overdue=1`
- Next 7 days → `/b/all/pending?due=week`

This needs the pending list's filters to come out of `useState` and into the
URL, which is the same move §16 made for the business scope and for the same
reason: a filtered list is a place you navigated to, not a setting you
adjusted. Back goes back, and the card and the screen it opens cannot disagree
about which invoices they mean.

Also getting the treatment, because they have the same problem:

- the per-business rows already link — no change
- the four section headings in the week view (`WeekView.tsx`) get their totals
  linked to the same filtered pending list

**Cost.** Small. One new derive predicate (`due=week`), the pending list reading
`useSearchParams`, and tests at each URL. No database.

---

## 2. Venue invoices wait for approval

> "whenever gmh or gmp adds an invoice, then it has to be approved by one of
> the managements before it shows in the pending or overdue"

### The shape

Two columns on `invoices`, not a fourth `status` value:

```sql
approved_at  timestamptz
approved_by  uuid references profiles(id)
```

`status` is unpaid/paid/void and means *where the money is*. Review is a
different fact about the same row, and folding it into one enum gives twelve
combinations to reason about where four are real. §19's pattern is the guide:
make the impossible states unrepresentable, with constraints rather than care.

```sql
-- Both, or neither. Same shape as paid_fields_consistent.
constraint approval_fields_consistent check (
  (approved_at is null     and approved_by is null)
  or (approved_at is not null and approved_by is not null)
)

-- Nothing unreviewed can be paid. The database says it, so no screen has to.
constraint paid_needs_approval check (status <> 'paid' or approved_at is not null)
```

**Who is approved on arrival is decided by a trigger, never by the client.**
Same reasoning as `set_internal_ref`: if the app can send it, the app can send
it wrong, and a venue that could pre-approve its own entry would make the whole
feature decorative.

```sql
-- BEFORE INSERT on invoices
if is_staff() then
  new.approved_at := null;  new.approved_by := null;
else
  new.approved_at := now(); new.approved_by := coalesce(auth.uid(), new.created_by);
end if;
```

So an invoice one of you enters is approved by the act of entering it, and
there is no path where it is not. Nothing about the four's entry flow changes —
the fifteen seconds is untouched.

**The hole a policy cannot close.** `staff_update` lets a venue change its own
invoice for five minutes, and RLS lets an update write any column the role may
write. A crafted correction could set `approved_at`. `pin_invoice_facts` — the
trigger that already exists in CATCH_UP_010 for exactly this class of hole —
gains two lines: when the caller is staff, `approved_at` and `approved_by` are
forced back to their old values, alongside `created_at` and `internal_ref`.

### Approving

An RPC, on the pattern of `mark_invoices_paid` — one statement, one
transaction, `security invoker` so RLS and `auth.uid()` both still apply, and
it returns only the rows it actually flipped so the app can say honestly when
somebody else got there first.

```sql
create function approve_invoices(p_ids uuid[]) returns setof invoices
language sql security invoker as $$
  update invoices
     set approved_at = now(), approved_by = auth.uid(), updated_at = now()
   where id = any(p_ids) and approved_at is null and status = 'unpaid'
  returning *;
$$;
```

One call covers a single tick and "approve all six from Parramatta", so there
is one code path to get right.

**Rejecting is voiding.** `void_invoice(p_id, p_reason)` already exists and
already requires a reason. A rejection is a wrong entry, which is what void
means. No new mechanism, and rule 5 holds — nothing is deleted.

### Where it shows

- **A `/review` screen.** Every unapproved invoice, newest first, grouped by
  venue. Each row: supplier, number, amount, dates, who entered it, and the
  entry note (§4) rendered in full rather than behind a tap — the note is the
  mechanism for irregularities and hiding it defeats it. Per row: Approve,
  Edit and approve, Reject. Per venue: Approve all.
- **On Home, permanently.** A third card, above the two figures, that says
  "3 awaiting review" and links to `/review`. It is present at zero too,
  saying "Nothing to review" — a card that disappears when empty is a card
  nobody notices is missing when it should be there, which is exactly the
  failure mode named in §0.
- **In the nav drawer**, with a count.
- **Push.** `on_invoice_notify` already fires on insert. Its body changes for
  a staff insert to "Parramatta added an invoice — $5,220, Bidfood · needs
  review". Same audience, same rules.

### What the venue sees

**Recommended, and it is the one change that touches the boundary.**
`staff_invoices` gains a review state, and stops excluding voided rows so a
rejection can be explained rather than silently vanishing:

```
review_state   'awaiting' | 'reviewed' | 'rejected'
void_reason    only when rejected
```

§34.3's rule is that nothing on the venue screen may change when money moves.
Approval is not money moving, and its state changes when management reviews,
which is a different event. A shop that cannot tell approved from rejected
either re-enters an invoice that was rejected, or chases one that was fine.

**RULED OUT — see "Decisions taken" at the foot of this file.** The venue screen
stays exactly as it is and `staff_invoices` is not edited. Everything else in
§2 stands unchanged; this half can be added later without redoing any of it.
The cost accepted with it is that a rejected invoice vanishes from the shop's
list unexplained.

### Cost

The largest item here. Database: two columns, two constraints, two trigger
changes, one RPC, the view. App: `useUnpaidInvoices` gains
`.not('approved_at','is',null)`, one new query, one new screen, the Home card,
the drawer count. Every invoice fixture in `test/fixtures` gains `approved_at`,
and a test that fails if an unapproved invoice reaches any total.

---

## 3. Venues choose a supplier, they do not create one

> "not allow staffs to create a new supplier... however if there genuinely is a
> new supplier then they can at least leave a note"

**Database.** `drop policy staff_insert on suppliers;` — one line, and it is
the whole enforcement. The app half is a courtesy on top of it.

**The problem it creates, and the answer.** A delivery arrives from a supplier
nobody has entered yet. The shop must still be able to log it — that is your
instruction — but it must not be filed against the wrong real supplier, because
a wrong attribution is harder to find later than a missing one.

So: **one placeholder supplier row**, `Supplier not listed`, with a new
`suppliers.is_placeholder boolean` flag. The venue sheet offers it explicitly
("Not in the list?"), and choosing it makes the note field required with the
supplier's real name asked for by the placeholder text. The review screen shows
those first, and approving one includes "create the supplier and move this
invoice onto it" in a single step.

`is_placeholder` rather than matching on the name, because a name is a string
somebody can rename. It also keeps the row out of the four's own type-ahead,
where it means nothing.

**Cost.** Small once §2 exists — it is a policy drop, a column, a seeded row,
a branch in `SupplierField`, and one action on the review screen.

---

## 4. A note on every new entry

> "add a note section on every new entry, if to let know about any
> irregularities"

`invoice_notes` already exists — table, RLS, index, `useInvoiceNotes`,
`useAddNote`, an offline mutation key, and a stream on the invoice detail
screen. `invoiceFormSchema` has even carried a `note` field since Phase 1. It
was never wired to the entry sheets. So this is mostly connecting what is there.

**Three sheets get an optional Note field**, last, under the dates:
`AddInvoiceSheet`, `AddVenueInvoiceSheet`, `AddSalesInvoiceSheet`.

**It costs the fifteen seconds nothing.** The note is written as a second
queued mutation *after* `onClose()`, exactly as the invoice write already is.
Nothing waits on it, and it queues behind the invoice it belongs to — the same
ordering the supplier-then-invoice path has relied on since Phase 7.

**Staff policies on `invoice_notes`**, which they have none of today:

- insert, where the invoice is their own venue's and the author is themselves
- select, where `author_id = auth.uid()` — their own notes only

Deliberately not "every note on their venue's invoices". Management's notes are
free text and will eventually contain the word "paid".

**Sales invoices** get a plain `note text` column rather than a second notes
table. A sales invoice is a document you issue once; a payables invoice is a
thing several people talk about over a fortnight. One of those needs a thread
and one does not.

---

## 5. Edit and remove suppliers

**This exists and is hard to find, which is the actual bug.**
`/suppliers/[id]` has an Edit control that changes the name, terms, contact,
phone, and an Active checkbox that is the deactivate. Nothing on the suppliers
list says so, and "Active ☐" does not read as Remove.

**Change**, all on screens that already exist:

- The Active checkbox becomes an explicit **Remove supplier** button with a
  confirm dialog (`ConfirmDialog` exists) saying plainly what it does: it stops
  appearing when adding an invoice, and every invoice it has ever been on is
  kept. Rule 5 — nothing is deleted, and the copy should stop implying it might
  be.
- A deactivated supplier's page shows **Restore** in the same slot.
- The suppliers list row gets a chevron-adjacent **Edit** affordance so the
  capability is visible from the list.
- The same three changes on the customers list and detail, which are the
  mirror of these and have the same gap.

**Cost.** Small. No database.

---

## 6. Push — the one that is not working, and a reminder that is not push-on-every-invoice

### 6a. Why nothing arrives

`ARCHITECTURE.md` §33.3 records push as live — function deployed, secrets set,
trigger installed. Something between there and a phone is not true any more,
and there are exactly four candidates. `db/diagnose_push.sql` is read-only and
answers all four in one paste:

| Query | What a bad answer means |
|---|---|
| `select count(*) from push_subscriptions` | 0 — no device ever actually subscribed, whatever the switch appeared to say |
| `select key, value like 'PASTE%' from app_config` | still placeholders — `notify_trigger.sql` §3 was never filled in |
| `select tgname, tgenabled from pg_trigger where tgname='invoice_push'` | missing or `D` — the trigger is gone or disabled |
| `select status_code, created from net._http_response order by created desc limit 10` | 403 = the secret differs between the function and `app_config`; 404 = wrong url; nothing at all = the trigger never fired |

And the fifth cause, which no query can see: **an iPhone still in a Safari tab.**
Apple gives a tabbed site no Push API at all. Settings already says so on that
phone instead of showing a switch — so if you see the switch, that is not it;
if you see the sentence about the Home Screen, that is it.

I will not guess between these. The file goes out, the output comes back, and
the fix is whichever line it names.

### 6b. A reminder at a time of their choosing

> "an option to send the managements an alert at a time of their choosing, as a
> reminder to check today's invoices"

Separate from per-invoice push and it does not replace it —
`notify_on_new_invoice` already exists per person in Settings, so anybody who
wants to stop hearing about every addition can turn that off today, with or
without this.

**Shape.**

```sql
profiles.reminder_time         time      -- null means off
profiles.reminder_last_sent_on date      -- so it fires once a day, not once a tick
```

`reminder_time` joins `notify_on_new_invoice` in the column grant, so each
person sets their own and only their own. `reminder_last_sent_on` deliberately
does **not** — it is bookkeeping, not a preference.

A `pg_cron` job every ten minutes runs `send_daily_reminders()`, which takes
everyone whose Sydney-local time has passed their `reminder_time` and who has
not been sent one today, and pushes them a digest:

> **Today's invoices** — 4 logged today · 2 awaiting review · 5 overdue

Two things this needs that do not exist:

- **`notify_push_one(profile_id, ...)`.** The existing `notify_push` picks its
  audience from a view and excludes the actor. A reminder has no actor and one
  recipient, so it reads `push_subscriptions` for that person directly rather
  than bending the audience views into a shape they were not built for.
- **`pg_cron` enabled** on the project. One toggle in the Supabase dashboard.
  Its own file, separate from everything else, because a script that fails on a
  missing extension takes the rest of the paste down with it.

**Assumption, stated rather than asked:** it sends every day at that time
whether or not anything happened, and says "Nothing logged today" when nothing
did. A reminder that only appears when there is news is an alert, and you asked
for a reminder. Easy to flip.

**In Settings:** a time field and an off state, under the existing switches.
`'HH:MM'` is handled the way `'YYYY-MM-DD'` already is — a string, compared as
a string, never parsed into a `Date`. Rule 2 holds; `lib/date.ts` gains the
two functions and nothing else touches a clock.

---

## 7. Supplier totals between two dates

> "An option within suppliers to check total pending between two time periods"

On `/suppliers/[id]`, a panel with two date fields. It reports, for that range:
the number of invoices, the total, and the split between still-pending and
already-settled — with the matching invoices listed underneath, so the figure
and the list it describes are the same array. Rule 4 is not negotiable even in
a panel.

**By due date, not invoice date.** "Total pending between two dates" is a
question about when money leaves, which is the question the whole app is built
around. A small toggle offers invoice date for when you want what was billed
in a month instead — two labelled buttons, not a hidden default.

**Its own server-side query**, not a filter over the page's existing array.
`useSupplierInvoices` caps at 300 rows, and a range across two years would
quietly report a total that is missing its oldest invoices — which is exactly
the class of bug notes §3 calls trust-destroying.

This is the first half of the export in §33.2, and it is deliberately not the
whole of it. What the range answers on screen is worth having before deciding
what a file should contain.

---

## 8. Deli Delights issues and prints an invoice

> "We add/select a supplier → we add list of products (with prices, also an
> option to add/edit those) → all the added products show an invoice → an
> option to export, that exported will be printed."

One correction to the vocabulary before the design, because it decides which
table this lands in: on this flow Deli is **selling**, so the other party is a
**customer**, not a supplier, and the record is a `sales_invoice`. That ledger
already exists (§17, migration 009) with customers, statuses, receivables, and
a mark-received path. What it has never had is line items or a document.

### Schema

```sql
create table products (
  id, business_id, name, unit,          -- 'kg' | 'each' | 'box'
  unit_price_cents bigint not null,
  active boolean, created_by, created_at
);
create unique index products_name_ci on products (business_id, lower(name)) where active;

create table sales_invoice_lines (
  id, sales_invoice_id references sales_invoices on delete cascade,
  position         int,
  product_id       uuid null,            -- null = a one-off line typed by hand
  description      text not null,        -- snapshot
  quantity_milli   bigint not null,      -- thousandths
  unit_price_cents bigint not null,      -- snapshot
  line_total_cents bigint not null
);
```

**The description and the price are snapshotted onto the line.** Changing a
product's price next month must not rewrite an invoice printed last month. A
printed document is a claim about a moment, and a line that reads its price
through a foreign key is a document that changes after you hand it over.

**Quantity is integer thousandths**, mirroring rule 6 exactly. 1.5 kg is
`1500`, no float anywhere, parsed and formatted by a new `lib/quantity.ts`
built like `lib/money.ts` and tested the same way.

**One write, one transaction.** `create_sales_invoice(p_invoice, p_lines)` —
`security invoker`, inserts the header and its lines, and computes
`amount_cents` itself as the sum of the lines. The client's total is not
trusted, because a header and its lines that disagree is a document that lies
about itself. Idempotent on the client-generated id, so a replayed offline
write is a no-op — notes §1.5, and it matters more here than anywhere: a
duplicated receivable is a customer invoiced twice.

`round(quantity_milli::numeric * unit_price_cents / 1000)` in SQL, and the same
arithmetic in integers in TypeScript. A table of cases is asserted in the unit
tests and repeated in the SQL file's verification query, so the two are proven
to agree rather than assumed to.

**Numbering.** The app, sequentially — `DDL-0001` — from a counter table and a
`BEFORE INSERT` trigger, the same race-free mechanism as `internal_ref` (§5.2),
with a unique index as the backstop. No tax columns: the document is a plain
invoice, decided below.

### The screens

- **`/products`** — list, add, edit price, remove. The same shape as
  `/suppliers`, deliberately, so there is one thing to learn.
- **Compose**, from a customer or from `/sales`: pick the customer, add lines
  (product type-ahead, quantity, price pre-filled and editable per line), and
  the running total updates as you go. One free-text line is allowed for the
  thing that is not a product.
- **`/sales/[id]`** — the record, and where Received is ticked off.
- **`/sales/[id]/print`** — the document. Business letterhead and logo (the
  brand system already stores logos), the customer's details, the number and
  dates, a table of lines, the total, and payment details. A Print button
  calling `window.print()`, with an `@media print` block in `globals.css` — no
  PDF library, rule 7, and the browser's own dialog already offers AirPrint on
  a phone and Save as PDF on a laptop, which is both halves of "export".

**Letterhead** needs fields `businesses` does not have: ABN, address, phone,
email and payment/bank details. They go on `/brand`, which already exists and
is where the logos are set without a deploy.

**It is tracked for free.** The invoice is a `sales_invoice`, so it appears on
the customer's page, in the receivable totals, and in the activity log, with no
new tracking mechanism at all.

### Cost

The largest item after §2 and the one with the most new surface: two tables,
one RPC, one counter, three screens, a print stylesheet, and a quantity module
with its own test file.

---

## Sequencing

Four rounds, each ending in a report and a stop.

| | Round | Contains | Database |
|---|---|---|---|
| **0** | Today | `db/diagnose_push.sql` — read-only, sent immediately | one paste, changes nothing |
| **A** | App-only | §1 touch targets, §5 edit/remove, §7 supplier date range | none |
| **B** | Review | §2 approval, §3 no supplier creation, §4 notes | `CATCH_UP_013` |
| **C** | Reminders | §6b, plus whatever §6a's answer turns out to be | `CATCH_UP_014` |
| **D** | Deli | §8 in full | `CATCH_UP_015` |

Round A first because it is visible, has no database step, and cannot break
anything — and because if the phone-speed report arrives during it, nothing has
to be unwound.

Round B is the one that needs the most care. It ends with `verify_staff.mjs`
re-run against the live database, not with a passing test suite.

Every round: `npx tsc --noEmit`, `npx next build`, and the suite under all
three timezones before anything is committed.

---

## Decisions taken, 5 September 2026

The four questions that changed the work, and their answers.

**1. Deli's invoice is a plain invoice. No GST, no tax line, no ABN
requirement.** So `sales_invoice_lines` carries no tax column and the document
is description / quantity / price / total. Written down because adding GST
later is genuinely a schema, totals and layout change, not an edit — if Deli
ever registers, this line is the one to come back to.

**2. The app numbers Deli's invoices, sequentially.** `DDL-0001`, from a
counter table with a `BEFORE INSERT` trigger — the same race-free
`insert ... on conflict do update ... returning n` that stamps `internal_ref`
(§5.2), for the same reason: `select max()` then insert loses the race, and two
people composing at once must not produce one number twice. A unique index on
the number is the backstop, as it is on `internal_ref`.

**3. The unlisted supplier is a placeholder row.** §3 as written stands.

**4. The venue screen does not change. No review state, no rejection reason.**
The `staff_invoices` view is untouched, and its `WHERE` — the whole boundary —
is not edited by any of this.

**The consequence of 4, so it is not rediscovered as a bug:** when management
rejects a venue's invoice, it is voided, and a voided row leaves the view. The
shop's entry disappears with no explanation and the app will not give one.
Somebody has to tell them out of band, or they will re-enter it. That is the
accepted cost of not touching the boundary, and it is reversible — the venue
half of §2 can be added later without redoing anything else.

**`verify_staff.mjs` is still re-run at the end of Round B**, even though the
view is untouched. The staff surface changes in three other ways: the supplier
insert policy is dropped, two note policies are added, and `pin_invoice_facts`
gains two lines. The script gains three checks to match — a supplier insert is
now refused, a note on the venue's own invoice is allowed, and a note on
anybody else's is not.
