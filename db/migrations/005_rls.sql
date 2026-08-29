-- ============================================================================
-- 005 — Row Level Security
--
-- Notes §2: "Enforcement lives in the database, never the interface. 'The
-- button isn't rendered' is not access control."
--
-- All three users are members and all can read and write everything; there is
-- no per-user data. What RLS is doing here is not separating the three of
-- them, it is making sure that anyone who is NOT one of the three gets
-- nothing — including someone holding the anon key, which ships to every
-- browser and is therefore public.
--
-- Run this migration last. Verify it with db/verify_rls.mjs, not by clicking.
-- ============================================================================

alter table profiles             enable row level security;
alter table businesses           enable row level security;
alter table suppliers            enable row level security;
alter table invoices             enable row level security;
alter table invoice_notes        enable row level security;
alter table activity_log         enable row level security;
alter table invoice_ref_counters enable row level security;

-- ----------------------------------------------------------------------------
-- Who counts as a member. An active profile row is the membership test; a
-- deactivated person loses access without their history being touched.
-- ----------------------------------------------------------------------------
create or replace function is_member()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select exists (
    select 1 from profiles p where p.id = auth.uid() and p.active
  );
$fn$;

-- ---------------------------------------------------------------- read + write
-- The three tables members genuinely create and change.

drop policy if exists member_all on suppliers;
create policy member_all on suppliers
  for all using (is_member()) with check (is_member());

drop policy if exists member_all on invoices;
create policy member_all on invoices
  for all using (is_member()) with check (is_member());

drop policy if exists member_all on invoice_notes;
create policy member_all on invoice_notes
  for all using (is_member()) with check (is_member());

-- --------------------------------------------------------------- read only --
-- Businesses are seeded, not managed in the app.

drop policy if exists member_read on businesses;
create policy member_read on businesses
  for select using (is_member());

-- Profiles: members can read all three (the attribution chips need names and
-- accents). Nobody writes them from the client — they are seeded by SQL, so
-- a person cannot rename themselves out of an audit trail.

drop policy if exists member_read on profiles;
create policy member_read on profiles
  for select using (is_member());

-- The activity log is append-only, and not even members may append to it
-- directly: the only writer is the SECURITY DEFINER audit trigger, which fires
-- as a side effect of a real change. There is no insert, update or delete
-- policy here on purpose. A log you can write to by hand is not a log.

drop policy if exists member_read on activity_log;
create policy member_read on activity_log
  for select using (is_member());

-- ----------------------------------------------------------------- no access
-- invoice_ref_counters is internal bookkeeping for the ref generator. RLS is
-- enabled and no policy is defined, so the table is unreachable from any
-- client. The trigger reaches it because that function is SECURITY DEFINER.

-- ----------------------------------------------------------------------------
-- Belt and braces: revoke the blanket grants Supabase gives the anon and
-- authenticated roles, then grant back only what is actually needed. RLS is
-- the boundary; this makes the boundary smaller.
-- ----------------------------------------------------------------------------
revoke all on invoice_ref_counters from anon, authenticated;
revoke all on activity_log         from anon, authenticated;
grant  select on activity_log      to   authenticated;

revoke all on profiles   from anon;
revoke all on businesses from anon;
revoke all on suppliers  from anon;
revoke all on invoices   from anon;
revoke all on invoice_notes from anon;
