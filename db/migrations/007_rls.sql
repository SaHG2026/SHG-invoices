-- ============================================================================
-- 007 — Row Level Security. Run this last.
--
-- Notes §2: "Enforcement lives in the database, never the interface. 'The
-- button isn't rendered' is not access control."
--
-- All four users are members and all can read and write every invoice; there
-- is no per-user data in the ledger itself. What RLS is doing here is not
-- separating the four of them — it is making sure anyone who is NOT one of
-- them gets nothing, including anybody holding the anon key, which ships to
-- every browser and is therefore public.
--
-- The two exceptions, where a person is confined to their own row, are their
-- notification setting and their push subscriptions. Those are the only
-- per-user rows in the system.
--
-- Verify with db/verify_rls.mjs, not by clicking.
-- ============================================================================

alter table profiles             enable row level security;
alter table businesses           enable row level security;
alter table suppliers            enable row level security;
alter table invoices             enable row level security;
alter table invoice_notes        enable row level security;
alter table activity_log         enable row level security;
alter table invoice_ref_counters enable row level security;
alter table push_subscriptions   enable row level security;

-- ----------------------------------------------------------------------------
-- Who counts as a member. An active profile row is the membership test, so
-- deactivating someone removes their access without touching their history.
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

-- ------------------------------------------------------------ read + write --
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

-- ----------------------------------------------------------------- read only
-- Businesses are seeded, not managed in the app.

drop policy if exists member_read on businesses;
create policy member_read on businesses
  for select using (is_member());

-- ------------------------------------------------------------------ profiles
-- Everyone can read all four profiles: the attribution chips need names and
-- accent colours.
--
-- Updating is confined to your own row AND to one column. Two mechanisms,
-- because they do different jobs:
--
--   the policy      decides WHICH ROW you may touch — only your own
--   the column grant decides WHICH FIELD you may set — only the notify flag
--
-- RLS cannot restrict columns, so without the grant below a person could
-- rename themselves, change their accent, or promote themselves to owner.
-- Together they mean the only thing anyone can change about themselves is
-- whether they want to be notified.

drop policy if exists member_read on profiles;
create policy member_read on profiles
  for select using (is_member());

drop policy if exists self_update on profiles;
create policy self_update on profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

revoke update on profiles from authenticated;
grant  update (notify_on_new_invoice) on profiles to authenticated;

-- --------------------------------------------------------------- activity log
-- Append-only, and not even members may append to it directly: the only
-- writer is the SECURITY DEFINER audit trigger, which fires as a side effect
-- of a real change. There is no insert, update or delete policy here on
-- purpose. A log you can write to by hand is not a log.

drop policy if exists member_read on activity_log;
create policy member_read on activity_log
  for select using (is_member());

-- --------------------------------------------------------- push subscriptions
-- Yours and only yours. A push endpoint is a capability: anyone holding one
-- can send that device a notification, so they do not get shared.

drop policy if exists own_subscriptions on push_subscriptions;
create policy own_subscriptions on push_subscriptions
  for all using (profile_id = auth.uid()) with check (profile_id = auth.uid());

-- ------------------------------------------------------------------ no access
-- invoice_ref_counters is internal bookkeeping for the ref generator. RLS is
-- on and no policy is defined, so it is unreachable from any client. The
-- trigger reaches it because that function is SECURITY DEFINER.

-- ----------------------------------------------------------------------------
-- Belt and braces: take away the blanket grants Supabase hands the anon and
-- authenticated roles, then give back only what is needed. RLS is the
-- boundary; this makes the boundary smaller.
-- ----------------------------------------------------------------------------
revoke all on invoice_ref_counters from anon, authenticated;
revoke all on activity_log         from anon, authenticated;
grant  select on activity_log      to   authenticated;

-- push_targets is read only by the Phase 7 Edge Function, which runs with its
-- own credentials. It must never be readable from a browser: it lists other
-- people's push endpoints.
revoke all on push_targets from anon, authenticated;

revoke all on profiles           from anon;
revoke all on businesses         from anon;
revoke all on suppliers          from anon;
revoke all on invoices           from anon;
revoke all on invoice_notes      from anon;
revoke all on push_subscriptions from anon;
