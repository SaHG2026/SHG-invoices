-- ############################################################################
--
--  CATCH-UP 005 — invoices Deli Delights SENDS to customers.
--
--  Supabase SQL editor -> New query -> paste -> Run.
--  Safe to run twice. Adds one table and one function; changes nothing that
--  already exists.
--
--  ---------------------------------------------------------------------------
--  What this is
--
--  CATCH_UP_004 added the customers. This adds what they owe: an invoice you
--  have sent, with its number, its date, when it is due, and how much.
--
--  It is a SEPARATE table from `invoices`, not a flag on it. Money out and
--  money in are different questions — for a supplier invoice "overdue" is your
--  problem and the action is to pay it; for one of these "overdue" is their
--  problem and the action is to chase it. Sharing one table would put a
--  condition inside every answer the app gives, including the screen the whole
--  design is built around: what leaves the account this week.
--
--  The practical guarantee that falls out of it: nothing in here can ever
--  reach the owed or pending figures, because those are computed from
--  `invoices` and this is not `invoices`.
--  ---------------------------------------------------------------------------
--
-- ############################################################################

-- A status of its own. `invoice_status` says 'paid', which is the wrong word
-- in this direction — you do not pay an invoice you sent. Two enums also mean
-- a query cannot accidentally compare one kind to the other.
do $$ begin
  create type sales_status as enum ('outstanding', 'received', 'void');
exception when duplicate_object then null;
end $$;

create table if not exists sales_invoices (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references businesses(id),
  customer_id    uuid not null references customers(id),

  invoice_number text,                         -- ours; we issued it
  invoice_date   date not null,
  due_date       date not null,
  amount_cents   bigint not null check (amount_cents > 0),

  status         sales_status not null default 'outstanding',
  received_at    timestamptz,
  received_by    uuid references profiles(id),
  payment_ref    text,
  void_reason    text,

  created_by     uuid not null references profiles(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  -- A received invoice always knows when and from whom; an outstanding one
  -- never claims to. Same constraint the payables table carries.
  constraint received_fields_consistent check (
    (status =  'received' and received_at is not null and received_by is not null)
    or
    (status <> 'received' and received_at is null     and received_by is null)
  ),

  constraint sales_void_needs_reason check (
    status <> 'void' or (void_reason is not null and length(trim(void_reason)) > 0)
  )
);

create index if not exists sales_due_outstanding
  on sales_invoices (due_date) where status = 'outstanding';
create index if not exists sales_customer on sales_invoices (customer_id);

-- ----------------------------------------------------------------------------
-- Marking one or several received.
--
-- One statement, one transaction, called once — notes §1.6, the same rule the
-- payables side follows. `where status = 'outstanding'` makes it idempotent and
-- returns only the rows it actually changed, so if somebody recorded the same
-- payment thirty seconds ago the app can say so instead of quietly
-- re-stamping it with a new name.
-- ----------------------------------------------------------------------------
create or replace function mark_sales_received(p_ids uuid[], p_ref text default null)
returns setof sales_invoices
language sql
security invoker
set search_path = public, pg_temp
as $fn$
  update sales_invoices
     set status      = 'received',
         received_at = now(),
         received_by = auth.uid(),
         payment_ref = nullif(trim(coalesce(p_ref, '')), ''),
         updated_at  = now()
   where id = any(p_ids)
     and status = 'outstanding'
  returning *;
$fn$;

create or replace function unmark_sales_received(p_id uuid)
returns setof sales_invoices
language sql
security invoker
set search_path = public, pg_temp
as $fn$
  update sales_invoices
     set status      = 'outstanding',
         received_at = null,
         received_by = null,
         payment_ref = null,
         updated_at  = now()
   where id = p_id
     and status = 'received'
  returning *;
$fn$;

-- ----------------------------------------------------------------------------
-- RLS. Migration 007's reasoning, unchanged: this is not separating the four
-- of you, it is making sure anybody who is NOT one of you gets nothing.
-- ----------------------------------------------------------------------------
alter table sales_invoices enable row level security;

drop policy if exists member_all on sales_invoices;
create policy member_all on sales_invoices
  for all using (is_member()) with check (is_member());

revoke all on sales_invoices from anon;

-- ----------------------------------------------------------------------------
-- Check it worked. Expect: 1, true, 1, 2.
-- ----------------------------------------------------------------------------
select
  (select count(*) from information_schema.tables
     where table_schema = 'public' and table_name = 'sales_invoices')     as table_present,
  (select relrowsecurity from pg_class where relname = 'sales_invoices')  as rls_enabled,
  (select count(*) from pg_policies
     where schemaname = 'public' and tablename = 'sales_invoices')        as policies,
  (select count(*) from pg_proc
     where proname in ('mark_sales_received', 'unmark_sales_received'))   as functions;
