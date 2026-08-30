-- ============================================================================
-- 008 — customers
--
-- Supabase SQL editor -> New query -> paste -> Run. Safe to run twice.
--
-- ----------------------------------------------------------------------------
-- What this is, and what it is deliberately not.
--
-- Deli Delights sells as well as buys (ARCHITECTURE §17). This is the first
-- table of that second ledger: who it sells to. It is a separate table from
-- `suppliers` rather than a `direction` flag on one shared table, for the
-- reason §17 sets out — "what leaves the account this week" is the screen the
-- whole design is built around, and a direction flag would put a condition
-- inside every answer it gives.
--
-- Note what is absent: there is no amount, no balance, no invoice, and no
-- foreign key from anything in the payables ledger. That absence is the
-- feature. The owed and pending figures are derived entirely from `invoices`,
-- so nothing in this table can reach them — the client asked for customer
-- tracking that does not move those numbers, and the way to guarantee that is
-- to give this table no numbers to move them with.
--
-- `sales_invoices` and `receipts` are their own phase, with their own totals
-- that never mix with these. Nothing here presumes their shape.
-- ----------------------------------------------------------------------------

create table if not exists customers (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  contact_name  text,
  contact_phone text,
  contact_email text,
  notes         text,
  active        boolean not null default true,
  created_by    uuid not null references profiles(id),
  created_at    timestamptz not null default now()
);

-- One active customer per name, case-insensitively. Deactivated ones are
-- excluded so a name can be reused after a customer closes — the same rule
-- suppliers_name_ci uses, and for the same reason.
create unique index if not exists customers_name_ci
  on customers (lower(name)) where active;

-- ----------------------------------------------------------------------------
-- RLS. Migration 007's reasoning applies unchanged: this is not separating the
-- four of them, it is making sure anybody who is NOT one of them gets nothing,
-- including everyone holding the anon key — which ships to every browser and
-- is therefore public.
-- ----------------------------------------------------------------------------
alter table customers enable row level security;

drop policy if exists member_all on customers;
create policy member_all on customers
  for all using (is_member()) with check (is_member());

revoke all on customers from anon;

-- ----------------------------------------------------------------------------
-- Not audited, matching suppliers.
--
-- The audit trigger exists because money moving has to be attributable to a
-- person forever (spec §5). A customer's phone number changing is not that. If
-- customer records ever start carrying amounts, this decision gets revisited
-- in the same migration that adds them — not later.
-- ----------------------------------------------------------------------------

-- Expect: the table, one unique index, RLS enabled, one policy.
select
  (select count(*) from information_schema.tables
     where table_schema = 'public' and table_name = 'customers')            as table_present,
  (select count(*) from pg_indexes
     where schemaname = 'public' and indexname = 'customers_name_ci')       as unique_index,
  (select relrowsecurity from pg_class where relname = 'customers')         as rls_enabled,
  (select count(*) from pg_policies
     where schemaname = 'public' and tablename = 'customers')               as policies;
