# Sagarmatha Payments — Build Spec

**Client:** Sagarmatha Holdings Group (SHG)
**Users:** Mani, Milan, Sujan — three people, full access each
**Businesses:** GroceryMate Hurstville, GroceryMate Parramatta, Majheri Restaurant, Deli Delights
**Currency:** AUD, GST-inclusive totals
**Purpose:** Log supplier invoices as they arrive, see what's owed and when, tick off payments, keep a permanent record of who did what.

This is an internal operations tool for three people who know each other. It is not a product. Optimise for speed of entry and clarity of "what leaves the account this week" over features.

---

## 1. The one metric that matters

**Time to log an invoice on a phone, one-handed, from cold app open: under 15 seconds.**

Every design decision below defers to this. If a feature adds a step to the add-invoice flow, it goes behind a "More" disclosure or gets cut.

Second metric: **Mani opens the app on Monday morning and knows within 3 seconds what's due this week and what's already late.**

---

## 2. Decisions made (and why)

| Decision | Choice | Reasoning |
|---|---|---|
| Auth | Three real accounts (email + password), no public sign-up | Attribution needs to be trustworthy; a shared key can't be revoked per person |
| Quick unlock | 6-digit PIN on trusted device, session persists 30 days | Speed. The PIN unlocks a session, it is not the security boundary |
| Data store | Postgres via Supabase, Row Level Security on | Free tier is plenty; real DB means real reporting later |
| Amounts | Integer cents, never floats | Money in floats produces cent drift, then arguments |
| Statuses stored | Only `unpaid` / `paid` / `void` | "Overdue" and "due soon" are computed from `due_date` at read time. Storing them means a cron job that will eventually fail silently |
| Deleting | Never. `void` with a reason, always visible in history | Three people entering data means mistakes; you want the mistake and the correction both on record |
| Un-ticking a payment | Allowed, but logged loudly | Same reason |
| Grouping | Pending list groups by supplier + due date into a **payment run** | You said multiple invoices can share a supplier and due date; that's how you'll actually pay them — one transfer |
| Partial payments | **Out of v1** | Adds a whole state machine. Ships in v2 if you actually hit the case |
| Offline | Optimistic UI, queue writes, retry | Cold rooms and back docks have bad wifi |
| Platform | Installable PWA, mobile-first | No app stores, no review cycles, works on whatever phones they have |

---

## 3. Assumptions to confirm before building

1. All four businesses pay from separate accounts / need separate totals. (Spec assumes yes — every invoice is tagged to one business.)
2. A supplier can serve more than one business. (Assumes yes.)
3. Amounts entered are GST-inclusive totals. No GST split needed in v1.
4. Nobody needs to export to the accountant in v1. (CSV export is in v2. If the bookkeeper needs it monthly, move it to v1 — say so.)
5. No approval workflow. Any of the three can add and tick off anything.

---

## 4. Stack

- **Next.js 15** (App Router) + TypeScript
- **Supabase**: Postgres, Auth, RLS, Storage (v2 for invoice photos)
- **Tailwind CSS v4** with the token set in §9. No component library — the UI is ~10 components and a library will fight the visual direction.
- **TanStack Query** for cache + optimistic updates
- **date-fns** for date maths, `Australia/Sydney` fixed
- **Zod** for form validation
- Deploy: **Vercel**
- PWA via manifest + service worker (write-queue only, don't over-engineer offline reads)

Do not add: Redux, tRPC, an ORM, a chart library, a state machine library.

---

## 5. Data model

```sql
-- ============ enums ============
create type invoice_status as enum ('unpaid', 'paid', 'void');

-- ============ people ============
create table profiles (
  id           uuid primary key references auth.users(id) on delete restrict,
  display_name text not null,          -- 'Mani', 'Milan', 'Sujan'
  initials     text not null,          -- 'MA', 'MI', 'SU'
  accent       text not null,          -- hex, for the attribution chip
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

-- ============ businesses ============
create table businesses (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,            -- 'GroceryMate Hurstville'
  code       text not null unique,     -- 'GMH' — used in internal refs
  sort_order int  not null default 0,
  active     boolean not null default true
);

-- ============ suppliers ============
create table suppliers (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  default_terms_days int,              -- e.g. 14 -> due date auto-fills
  contact_name       text,
  contact_phone      text,
  notes              text,
  active             boolean not null default true,
  created_by         uuid not null references profiles(id),
  created_at         timestamptz not null default now()
);
create unique index suppliers_name_ci on suppliers (lower(name)) where active;

-- ============ invoices ============
create table invoices (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references businesses(id),
  supplier_id    uuid not null references suppliers(id),

  invoice_number text,                 -- supplier's number, nullable
  internal_ref   text not null,        -- always generated, e.g. 'GMH-260828-03'
  invoice_date   date not null,        -- defaults to today, editable
  due_date       date not null,
  amount_cents   bigint not null check (amount_cents > 0),

  status         invoice_status not null default 'unpaid',
  paid_at        timestamptz,
  paid_by        uuid references profiles(id),
  payment_ref    text,                 -- bank ref / cheque no, optional
  void_reason    text,

  created_by     uuid not null references profiles(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint paid_fields_consistent check (
    (status = 'paid' and paid_at is not null and paid_by is not null)
    or (status <> 'paid' and paid_at is null and paid_by is null)
  )
);

create index invoices_due_unpaid on invoices (due_date) where status = 'unpaid';
create index invoices_supplier    on invoices (supplier_id);
create index invoices_business    on invoices (business_id);
create index invoices_paid_at     on invoices (paid_at desc) where status = 'paid';

-- Duplicate detection is a WARNING, not a constraint.
-- Suppliers restart numbering; a hard unique index will block legitimate entries.
create index invoices_dupe_lookup on invoices (supplier_id, lower(invoice_number));

-- ============ notes (threaded, attributed) ============
create table invoice_notes (
  id         uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices(id) on delete cascade,
  author_id  uuid not null references profiles(id),
  body       text not null check (length(trim(body)) > 0),
  created_at timestamptz not null default now()
);
create index invoice_notes_invoice on invoice_notes (invoice_id, created_at);

-- ============ activity log ============
create table activity_log (
  id          bigserial primary key,
  entity_type text not null,          -- 'invoice' | 'supplier'
  entity_id   uuid not null,
  action      text not null,          -- 'created' | 'edited' | 'paid' | 'unpaid' | 'voided'
  actor_id    uuid not null references profiles(id),
  detail      jsonb,                  -- changed fields, before/after
  created_at  timestamptz not null default now()
);
create index activity_entity on activity_log (entity_type, entity_id, created_at desc);
create index activity_recent on activity_log (created_at desc);
```

### Internal ref generation

Every invoice gets one, whether or not the supplier gave a number. Format:
`{BUSINESS_CODE}-{YYMMDD}-{NN}` → `GMH-260828-03` (third invoice logged for Hurstville on 28 Aug 2026).

Generate server-side in a Postgres function so two people entering at once can't collide.

### RLS

All three users are members; all can read and write everything. There is no per-user data.

```sql
alter table invoices enable row level security;
-- repeat for every table

create policy member_all on invoices
  for all
  using  (exists (select 1 from profiles p where p.id = auth.uid() and p.active))
  with check (exists (select 1 from profiles p where p.id = auth.uid() and p.active));
```

`profiles` itself: select for members, no insert/update from client (seed via SQL).

### Audit trigger

Write a trigger on `invoices` (insert/update) that appends to `activity_log` using `auth.uid()`. Do not rely on the client to log — the client will forget.

---

## 6. Business rules

**Derived urgency** (computed, never stored):

| Bucket | Rule | Shown as |
|---|---|---|
| Overdue | `due_date < today` | brick spine, day count "4 days late" |
| Today | `due_date = today` | gold spine |
| This week | within 7 days | teal spine |
| Later | beyond 7 days | grey spine |

**Payment run.** In the pending list, unpaid invoices sharing a `supplier_id` **and** `due_date` collapse into one row showing the supplier, the combined total and an invoice count. Expanding shows each invoice. You can tick the whole run (marks all children paid in one transaction, one `payment_ref`) or expand and tick one.

**Duplicate warning.** On save, if `supplier_id` + `invoice_number` already exists and isn't void, show an inline warning naming the existing invoice, its amount and who entered it. Offer "Save anyway" and "Open the existing one". Never silently block.

**Ticking off.** Sets `status='paid'`, `paid_at=now()`, `paid_by=auth.uid()`. Optional `payment_ref`. The paid row immediately shows the payer's initials chip — that chip is permanent and appears everywhere the invoice appears afterwards.

**Un-ticking.** Available from the invoice detail screen only (not swipeable from a list — too easy to fat-finger). Requires a confirm. Logs `unpaid` action with the actor.

**Voiding.** Requires a reason string. Voided invoices drop out of all totals but stay in history, struck through.

**Editing.** Any field editable while unpaid. Once paid, amount and due date are locked until it's un-ticked. Every edit logs before/after.

---

## 7. Screens

### 7.1 Unlock
PIN pad on a dark ink field. Three initial chips at the top — tap yours, enter PIN. No email/password unless the session has expired or it's a new device.

### 7.2 Home — "The Week"
The default screen. Answers *what leaves the account, and when*.

```
┌──────────────────────────────────────────┐
│ SHG                          [MA] [+]    │
│                                          │
│ OWING                                    │
│ $ 47,320.15                              │  ← Archivo, ~44px, tabular
│ across 31 invoices · 12 suppliers        │
│                                          │
│ ┌ OVERDUE ─────────────────── $8,140 ─┐  │  ← brick left spine
│ │ Bidfood            2 inv    $5,220  │  │
│ │ 4 days late                          │  │
│ │ Himalayan Wholesale 1 inv   $2,920  │  │
│ └──────────────────────────────────────┘  │
│                                          │
│ ┌ TODAY  Fri 28 Aug ───────── $3,900 ─┐  │  ← gold spine
│ │ PFD Food Services   3 inv   $3,900  │  │
│ └──────────────────────────────────────┘  │
│                                          │
│ ┌ NEXT 7 DAYS ────────────── $19,480 ─┐  │
│ │ Mon 31  Bhatbhateni Imports $6,100  │  │
│ │ Tue 01  Coca-Cola EP        $2,380  │  │
│ │ ...                                  │  │
│ └──────────────────────────────────────┘  │
│                                          │
│ [ All businesses ▾ ]                     │
└──────────────────────────────────────────┘
```

Business filter is a segmented control pinned at the bottom (thumb reach): All · GMH · GMP · MJR · DDL. Selection persists across sessions.

### 7.3 Add invoice
Opens as a sheet from the `+`. This is the screen that has to be fast.

```
┌──────────────────────────────────────────┐
│ New invoice                        ✕     │
│                                          │
│ [ GMH ] [ GMP ] [ MJR ] [ DDL ]          │  ← last used pre-selected
│                                          │
│ Supplier                                 │
│ ┌──────────────────────────────────────┐ │
│ │ bid|                                 │ │  ← type-ahead, top 5 recent
│ └──────────────────────────────────────┘ │     first, then fuzzy match
│   Bidfood                                │
│   Bidvest                                │
│   + Add "bid" as a new supplier          │
│                                          │
│ Amount                                   │
│ ┌──────────────────────────────────────┐ │
│ │ $ 5,220.00                           │ │  ← numeric keypad, mono
│ └──────────────────────────────────────┘ │
│                                          │
│ Due                                      │
│ [ +7d ] [ +14d ] [ +30d ] [ Pick date ]  │  ← supplier's default term
│ Fri 11 Sep 2026                          │     highlighted if set
│                                          │
│ ⌄ Invoice number, date, note             │  ← collapsed by default
│                                          │
│         [    Save invoice    ]           │
└──────────────────────────────────────────┘
```

Four taps and a number for the common case. Invoice date defaults to today and shows the weekday. Everything optional lives behind the disclosure.

On save: sheet closes, the new row flashes into the list, toast reads "Saved · GMH-260828-03".

### 7.4 Pending
The full list with real sorting. Sort control is a single row of pills, not a dropdown buried in a menu:

`Due date` · `Supplier` · `Amount` · `Recently added`

Filters: business (inherited from home), supplier, date range, "overdue only".

Sticky footer shows the total of whatever is currently filtered. That number changing as you filter is the whole point of the screen.

### 7.5 Supplier view
Tap any supplier name anywhere → their page.

- Outstanding total, count
- Default terms, contact
- Unpaid invoices
- Payment history, newest first, each with the payer's chip
- Rolling 6-month spend (a plain number and a sparkline, not a dashboard)

### 7.6 Invoice detail
Everything about one invoice: amounts, dates with weekday, both refs, the business, the supplier, status.

Below that, a single chronological stream mixing notes and activity:

```
  MI  Milan · added this invoice          28 Aug, 9:14am
  MI  "Short delivery — 2 cartons missing,
       credit note expected"              28 Aug, 9:15am
  SU  Sujan · changed amount
       $5,420.00 → $5,220.00              29 Aug, 4:02pm
  MA  Mani · marked paid  ref: TFR-88213  11 Sep, 8:30am
```

Notes and system events in one stream, distinguished by weight not by tabs. Add-note box pinned at the bottom.

### 7.7 History
Paid and voided invoices. Search by supplier, invoice number, internal ref, amount. Filter by payer — "everything Sujan ticked off in July" should take two taps.

### 7.8 Suppliers admin
List, add, edit, deactivate. Deactivating hides a supplier from the type-ahead but keeps all history.

---

## 8. Copy rules

- Sentence case everywhere. No Title Case Buttons.
- Buttons say what happens: "Save invoice", "Mark paid", "Add supplier". Never "Submit".
- The action name survives into the confirmation: "Mark paid" → toast "Marked paid".
- No emoji. No exclamation marks.
- Empty states are instructions: "No invoices due this week. Add one with the + button." Not "All caught up! 🎉"
- Errors say what went wrong and what to do: "Couldn't save — you're offline. It'll send when you reconnect." Not "An error occurred."
- Money always formatted `$1,234.56`, always tabular, always right-aligned in lists.
- Dates always carry the weekday: "Fri 11 Sep". Weekday matters when you're planning transfers.

---

## 9. Visual direction

The brief here is a **ledger, not a dashboard**. The subject's world is delivery dockets, order chits, supplier statements, a payment diary. It should feel like a well-kept book, not a SaaS analytics product. Dense, quiet, confident with numbers.

### Palette (derived from the SHG mark)

```css
--ink:      #12384B;  /* deepest navy-teal — text, headers, unlock screen */
--slate:    #2E7C93;  /* mid teal — structure, links, "this week" */
--gold:     #C9A227;  /* the figure — primary action, "due today" */
--chilli:   #4F8F2E;  /* the chilli/leaf — paid, cleared, positive */
--brick:    #A6392B;  /* overdue only — used sparingly, never decoratively */
--snow:     #EDF0F0;  /* page background — cool mineral grey, the snowcap shadow */
--card:     #FFFFFF;
--hair:     #D3DBDC;  /* 1px rules */
--mute:     #6B7C82;  /* secondary text */
```

Note the background is a **cool grey**, not warm cream. Warm cream + serif is the current AI-design house style and it would fight the logo anyway — the mark is cold mountain blues.

### Type

| Role | Face | Notes |
|---|---|---|
| Display / headings | **Archivo** 600–700, tracking `-0.02em` | Grotesque with slightly squared terminals; reads as signage, not as a startup |
| Body / UI | **IBM Plex Sans** 400/500 | Neutral, excellent at small sizes, pairs cleanly with Plex Mono |
| Numerals | **IBM Plex Mono** 500, `font-variant-numeric: tabular-nums` | Money is mono. Dockets are mono. Columns line up |

Type scale: 44 / 28 / 20 / 16 / 14 / 12. The 44 is used exactly once per screen — the outstanding total.

### Form

- Border radius **4px**. Not 12, not pill.
- Hairline borders, no drop shadows except the add-invoice sheet.
- Row height 56px, dense. Cards do not float; they are ruled sections.
- No gradients anywhere. No glassmorphism. No icon-in-a-tinted-circle.
- Icons: Lucide, 18px, `--mute`, used only where a word won't fit.

### Signature element: **the due spine**

Down the left edge of every pending list runs a continuous 3px vertical rule, coloured per section by urgency (brick → gold → slate → hair). Where a date changes, the spine gets a small horizontal tick and the date label sits on it. Today is marked with a filled square that stays visible as a sticky marker while you scroll.

It's a timeline of money leaving the account, and it's the one place to spend visual boldness. Everything else stays quiet.

### Attribution chips

24px square (not circle), 4px radius, user's accent colour, initials in Plex Mono 11px. Mani `--gold`, Milan `--slate`, Sujan `--chilli`. These are the app's only recurring colour-as-identity device.

### Motion

- List rows: 120ms fade+2px rise on insert. That's it.
- Tick-off: the row's spine segment fills to `--chilli` over 200ms, then the row leaves the list. One satisfying moment, no confetti.
- `prefers-reduced-motion` respected.

### Quality floor

Responsive to 360px. Visible keyboard focus rings (`--slate`, 2px offset). Touch targets ≥44px. Tested with a 200-invoice list.

---

## 10. Build phases

Hand these to Claude Code one at a time. Don't run them all in one prompt.

**Phase 1 — Foundation**
Next.js + TS + Tailwind v4 scaffold. Token system from §9 as CSS variables. Fonts loaded. Supabase project, full schema from §5 with RLS, the audit trigger, the internal-ref function. Seed the four businesses and three profiles. Verify RLS blocks an anonymous client.

**Phase 2 — Auth**
Email + password login, no sign-up route. Profile picker + 6-digit PIN quick-unlock backed by a persisted session. Middleware guarding every route. Sign out.

**Phase 3 — Add invoice**
The sheet from §7.3, exactly as specified including collapsed disclosure and the +7/+14/+30 due presets. Supplier type-ahead with inline create. Duplicate warning. Optimistic insert. This phase gets the most polish — time it on a real phone.

**Phase 4 — Home + pending**
The Week screen. Payment-run grouping. The due spine. Business segmented control with persisted selection. Pending list with all four sorts and the sticky filtered total.

**Phase 5 — Payment + detail**
Mark paid (single and whole run), payment ref, un-tick with confirm, void with reason. Invoice detail with the merged notes/activity stream. Add note.

**Phase 6 — Supplier, history, admin**
Supplier pages, history with search and payer filter, supplier admin.

**Phase 7 — PWA + hardening**
Manifest, icons from the SHG mark, offline write queue, error boundaries, empty states, 200-row performance pass, mobile QA on the actual phones.

### Opening prompt for Claude Code

> Read `sagarmatha-payments-spec.md` in full before writing any code. Build Phase 1 only. Follow §9 exactly — the visual tokens and type choices are not suggestions, and I don't want a generic dashboard look. Stop after Phase 1 and show me the schema and the token file before continuing.

---

## 11. Out of scope for v1 (deliberately)

Ranked by how likely you are to want them next.

1. **Photo of the invoice** — snap it at entry, Supabase Storage, thumbnail on the detail screen. Highest value item after v1 ships; consider pulling into Phase 3 if the shops keep losing paper.
2. **CSV export** for the bookkeeper.
3. **Partial payments** — `amount_paid_cents` plus a `partial` status.
4. **Recurring invoices** — rent, insurance, utilities on a schedule.
5. Push or email reminder for overdue.
6. Credit notes / supplier credits.
7. Spend reporting by business and month.

Don't build any of these until v1 has been in daily use for a month.

---

## 12. Seed data

```sql
insert into businesses (name, code, sort_order) values
  ('GroceryMate Hurstville',  'GMH', 1),
  ('GroceryMate Parramatta',  'GMP', 2),
  ('Majheri Restaurant',      'MJR', 3),
  ('Deli Delights',           'DDL', 4);

-- profiles: create the three auth users first, then
insert into profiles (id, display_name, initials, accent) values
  ('<mani-uuid>',  'Mani',  'MA', '#C9A227'),
  ('<milan-uuid>', 'Milan', 'MI', '#2E7C93'),
  ('<sujan-uuid>', 'Sujan', 'SU', '#4F8F2E');
```

Supplier list: to be provided. Each needs `name` and, where known, `default_terms_days` — that field is what makes the add-invoice flow fast, so it's worth filling in properly from the start.
