-- ############################################################################
--
--  CATCH-UP 004 — the customers table.
--
--  Supabase SQL editor -> New query -> paste -> Run.
--  Safe to run twice. Adds one table; changes nothing that already exists.
--
--  ---------------------------------------------------------------------------
--  What this is for
--
--  Deli Delights sells as well as buys, and you asked to be able to track who
--  it sells to. This is that list: names and contacts, nothing else.
--
--  Your condition was that it must not affect what is owed or pending. It
--  cannot, and not because anything filters it out — there is no amount on a
--  customer row for a total to pick up. Every owed and pending figure in the
--  app still comes only from the invoices table, exactly as it did before.
--
--  Sales invoices and receipts are a later phase, with their own totals that
--  never mix with these.
--  ---------------------------------------------------------------------------
--
--  Until this is run, the Customers screen says so rather than showing an
--  empty list — an empty list and a missing table look the same from the app's
--  side, and only one of them means "no customers yet".
--
-- ############################################################################

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

-- One active customer per name, ignoring case. Deactivated ones are excluded,
-- so a name can be reused after a customer closes. Same rule as suppliers.
create unique index if not exists customers_name_ci
  on customers (lower(name)) where active;

-- Row Level Security. Same as every other table: this is not separating the
-- four of you, it is making sure anybody who is NOT one of you gets nothing —
-- including anyone holding the anon key, which ships to every browser.
alter table customers enable row level security;

drop policy if exists member_all on customers;
create policy member_all on customers
  for all using (is_member()) with check (is_member());

revoke all on customers from anon;

-- ----------------------------------------------------------------------------
-- Check it worked. Expect: 1, 1, true, 1.
-- ----------------------------------------------------------------------------
select
  (select count(*) from information_schema.tables
     where table_schema = 'public' and table_name = 'customers')      as table_present,
  (select count(*) from pg_indexes
     where schemaname = 'public' and indexname = 'customers_name_ci') as unique_index,
  (select relrowsecurity from pg_class where relname = 'customers')   as rls_enabled,
  (select count(*) from pg_policies
     where schemaname = 'public' and tablename = 'customers')         as policies;
