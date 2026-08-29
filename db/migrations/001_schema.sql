-- ============================================================================
-- 001 — enums, tables, indexes
-- Sagarmatha Payments. Spec §5.
--
-- Money is bigint cents, never numeric and never float.
-- Calendar dates are `date`, instants are `timestamptz`. A date has no
-- timezone and must not acquire one (notes §1.2).
-- Nothing is ever deleted; `void` with a reason (notes §8).
-- ============================================================================

-- ---------------------------------------------------------------- enums ----
do $$ begin
  create type invoice_status as enum ('unpaid', 'paid', 'void');
exception when duplicate_object then null;
end $$;

-- ------------------------------------------------------------- profiles ----
create table if not exists profiles (
  id           uuid primary key references auth.users(id) on delete restrict,
  display_name text not null,
  initials     text not null,
  accent       text not null,                  -- hex, for the attribution chip
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

-- Notes §2: the RLS policies run `exists (select 1 from profiles ...)` per row.
create index if not exists profiles_active on profiles (id) where active;

-- ----------------------------------------------------------- businesses ----
create table if not exists businesses (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  code       text not null unique,             -- 'GMH' — used in internal refs
  sort_order int  not null default 0,
  active     boolean not null default true
);

-- ------------------------------------------------------------ suppliers ----
create table if not exists suppliers (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  default_terms_days int,                      -- 14 -> the due date auto-fills
  contact_name       text,
  contact_phone      text,
  notes              text,
  active             boolean not null default true,
  created_by         uuid not null references profiles(id),
  created_at         timestamptz not null default now()
);

create unique index if not exists suppliers_name_ci
  on suppliers (lower(name)) where active;

-- ------------------------------------------------------------- invoices ----
create table if not exists invoices (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references businesses(id),
  supplier_id    uuid not null references suppliers(id),

  invoice_number text,                         -- the supplier's number, optional
  internal_ref   text not null,                -- always generated: 'GMH-260828-03'
  invoice_date   date not null,
  due_date       date not null,
  amount_cents   bigint not null check (amount_cents > 0),

  status         invoice_status not null default 'unpaid',
  paid_at        timestamptz,
  paid_by        uuid references profiles(id),
  payment_ref    text,                         -- bank ref / cheque no, optional
  void_reason    text,

  created_by     uuid not null references profiles(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  -- A paid invoice always knows when and by whom; an unpaid one never claims to.
  constraint paid_fields_consistent check (
    (status =  'paid' and paid_at is not null and paid_by is not null)
    or
    (status <> 'paid' and paid_at is null     and paid_by is null)
  ),

  -- Voiding requires a reason. Spec §6.
  constraint void_needs_reason check (
    status <> 'void' or (void_reason is not null and length(trim(void_reason)) > 0)
  )
);

create index if not exists invoices_due_unpaid on invoices (due_date) where status = 'unpaid';
create index if not exists invoices_supplier    on invoices (supplier_id);
create index if not exists invoices_business    on invoices (business_id);
create index if not exists invoices_paid_at     on invoices (paid_at desc) where status = 'paid';

-- Duplicate detection is a WARNING, not a constraint. Suppliers restart their
-- numbering, and a unique index here would block legitimate entries. Spec §5.
create index if not exists invoices_dupe_lookup
  on invoices (supplier_id, lower(invoice_number));

-- ---------------------------------------------------------------- notes ----
create table if not exists invoice_notes (
  id         uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices(id) on delete cascade,
  author_id  uuid not null references profiles(id),
  body       text not null check (length(trim(body)) > 0),
  created_at timestamptz not null default now()
);

create index if not exists invoice_notes_invoice on invoice_notes (invoice_id, created_at);

-- --------------------------------------------------------- activity log ----
create table if not exists activity_log (
  id          bigserial primary key,
  entity_type text not null,                   -- 'invoice' | 'supplier'
  entity_id   uuid not null,
  action      text not null,                   -- created|edited|paid|unpaid|voided
  actor_id    uuid not null references profiles(id),
  detail      jsonb,                           -- changed fields, before/after
  created_at  timestamptz not null default now()
);

create index if not exists activity_entity on activity_log (entity_type, entity_id, created_at desc);
create index if not exists activity_recent on activity_log (created_at desc);
