-- ===========================================================================
-- CATCH_UP_019 — three real tiers: owner, manager, staff
--
-- Run this in the Supabase SQL editor. Safe to run more than once.
--
-- RUN THIS **BEFORE** THE DEPLOY, and deploy soon after.
--
-- Why before: this file RENAMES `is_member()` to `is_manager_or_above()` and
-- renames the role `member` to `manager`. The version of the app currently
-- live never names either one — the app calls RPCs and reads columns, and the
-- role string it reads is only used to decide what a screen shows. So the live
-- app keeps working across this file, with one visible consequence in the
-- window between the two: `isFullMember()` in the old bundle tests for
-- 'member' and will no longer match Milan or Sujan, so their drawer will look
-- like a venue account's until the deploy lands. Minutes, not hours.
--
-- Running it AFTER the deploy is the worse order: the new bundle expects
-- 'manager' and would find 'member'.
--
-- ---------------------------------------------------------------------------
-- What this changes, in one paragraph
--
-- Today `owner` and `member` are the same thing everywhere it matters —
-- `is_member()` is `role in ('member','owner','builder')` and every policy in
-- the database says `is_member()`. The client wants a real difference: a
-- manager runs the day, and the owner alone moves money between paid and
-- unpaid. So `member` becomes `manager`, `is_member()` becomes
-- `is_manager_or_above()` (the same allowlist, one value wider),
-- `is_owner()` is new, the four paid/received RPCs refuse anybody who is not
-- an owner, and `set_user_role` is the only way a role can change.
--
-- ---------------------------------------------------------------------------
-- Renaming, rather than adding a fifth value
--
-- The alternative was to leave `member` alone and add `manager` beside it,
-- which is one `update` less and wrong: two names for one tier is exactly the
-- shape problem this project keeps meeting (HANDOFF §8). Every list, filter
-- and policy would then have to remember both forever, and the day one of
-- them remembers only one is the day somebody silently loses access.
--
-- ---------------------------------------------------------------------------
-- THE TRAP IN THIS FILE, and it is the same one as last time
--
-- Three role filters in this app were once written as `role <> 'builder'`.
-- A blocklist admits every role invented after it, so on the day the venue
-- accounts were created those three filters would have listed GroceryMate
-- Parramatta as one of the people who run the businesses. They are allowlists
-- now — and an allowlist has the opposite failure: a tier added without
-- visiting each one is a tier that is quietly excluded.
--
-- There are FOUR allowlists in the database, and every one of them is in this
-- file on purpose rather than by search-and-replace:
--
--    1. is_member()             -> is_manager_or_above()   §2
--    2. push_targets            (who is told about a new invoice)   §3
--    3. push_targets_payment    (who is told about a payment)       §3
--    4. send_daily_reminders()  (whose alarm goes off)              §4
--
-- And two more in the app: `isFullMember` and `runsTheBusinesses`, both in
-- `lib/staff.ts`, both changed in the same commit as this file.
-- ===========================================================================


-- ===========================================================================
--  1. THE ROLE ITSELF
--
--  Widen the constraint, move the rows, then narrow it again. In that order,
--  in one transaction — a constraint narrowed before the rows move rejects
--  them, and rows moved without widening first are rejected by the old one.
--
--  `member` is not left as a permitted value at the end. Leaving it would let
--  the next `insert` quietly create an account belonging to a tier that no
--  longer exists anywhere else.
-- ===========================================================================

begin;

alter table profiles drop constraint if exists profiles_role_valid;

alter table profiles
  add constraint profiles_role_valid
  check (role in ('member', 'manager', 'owner', 'builder', 'staff'));

update profiles set role = 'manager' where role = 'member';

alter table profiles drop constraint profiles_role_valid;

alter table profiles
  add constraint profiles_role_valid
  check (role in ('manager', 'owner', 'builder', 'staff'));

commit;


-- ===========================================================================
--  2. THE DOOR — is_member() becomes is_manager_or_above()
--
--  A rename, not a new function, and that matters: twenty-odd policies say
--  `is_member()` and a policy stores the function's OID rather than its name,
--  so every one of them follows the rename with nothing to edit. Recreating
--  them by hand would be twenty chances to get one wrong, on a live database.
--
--  The old name is deliberately NOT kept as an alias. A policy written next
--  year saying `is_member()` should fail loudly at creation time rather than
--  compile against a shim nobody maintains. CATCH_UP_010 §2 made exactly this
--  argument for narrowing the door instead of adding a second one.
-- ===========================================================================

do $$
begin
  if exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'is_member' and p.pronargs = 0
  ) then
    alter function is_member() rename to is_manager_or_above;
  end if;
end $$;

-- The allowlist, one value wider. `member` is gone from it because §1 removed
-- the value; if any row still said 'member' this would lock that person out,
-- which is why §1 is above §2 and in its own transaction.
create or replace function is_manager_or_above()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select exists (
    select 1 from profiles p
     where p.id = auth.uid()
       and p.active
       and p.role in ('manager', 'owner', 'builder')
  );
$fn$;

-- ---------------------------------------------------------------------------
-- The new one. Two values, and the second is the whole of §44.2: the builder
-- account has owner powers and is invisible in every list. Invisible is done
-- in the app and in the two push views; it is NOT done here, because a
-- permission that hides itself from the permission check is a permission
-- nobody can reason about.
--
-- `active` is tested for the same reason `is_manager_or_above` tests it: a
-- deactivated owner is not an owner. HANDOFF §2.
-- ---------------------------------------------------------------------------
create or replace function is_owner()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select exists (
    select 1 from profiles p
     where p.id = auth.uid()
       and p.active
       and p.role in ('owner', 'builder')
  );
$fn$;

-- CATCH_UP_011's default, applied to both. Neither returns anything an
-- anonymous caller could use — they both return false — so this is the house
-- pattern rather than a fix. Left out, the next person concludes that two
-- predicates revoked and two not was deliberate.
revoke execute on function is_manager_or_above() from public, anon;
revoke execute on function is_owner()            from public, anon;
grant  execute on function is_manager_or_above() to   authenticated;
grant  execute on function is_owner()            to   authenticated;


-- ===========================================================================
--  3. THE TWO PUSH AUDIENCES — allowlist 2 and 3
--
--  `role in ('member','owner')` becomes `role in ('manager','owner')`.
--
--  The builder stays out of both, unchanged and deliberately: these are the
--  audiences for being told what other people did, and §28.2 keeps the shadow
--  account out of them. He is IN the daily reminder below, which is a
--  different thing — an alarm somebody set for themselves.
-- ===========================================================================

create or replace view push_targets as
  select
    s.id            as subscription_id,
    s.profile_id,
    s.endpoint,
    s.p256dh,
    s.auth,
    p.display_name
  from push_subscriptions s
  join profiles p on p.id = s.profile_id
 where p.active
   and p.role in ('manager', 'owner')
   and p.notify_on_new_invoice;

create or replace view push_targets_payment as
  select
    s.id            as subscription_id,
    s.profile_id,
    s.endpoint,
    s.p256dh,
    s.auth,
    p.display_name
  from push_subscriptions s
  join profiles p on p.id = s.profile_id
 where p.active
   and p.role in ('manager', 'owner')
   and p.notify_on_payment;

revoke all on push_targets         from anon, authenticated;
revoke all on push_targets_payment from anon, authenticated;


-- ===========================================================================
--  4. THE DAILY REMINDER — allowlist 4
--
--  One line of CATCH_UP_014's loop. Everything else about that function is
--  unchanged and the body is repeated here in full only because `create or
--  replace function` has no way to edit one line.
-- ===========================================================================

create or replace function send_daily_reminders()
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_today   date := (now() at time zone 'Australia/Sydney')::date;
  v_now     time := (now() at time zone 'Australia/Sydney')::time;
  v_added   int;
  v_review  int;
  v_overdue int;
  v_body    text;
  v_person  record;
  v_sent    int := 0;
begin
  select count(*) into v_added
    from invoices
   where (created_at at time zone 'Australia/Sydney')::date = v_today;

  select count(*) into v_review
    from invoices where status = 'unpaid' and approved_at is null;

  select count(*) into v_overdue
    from invoices
   where status = 'unpaid' and approved_at is not null and due_date < v_today;

  v_body :=
      case when v_added = 0 then 'Nothing logged today'
           else v_added || ' logged today' end
    || case when v_review  > 0 then ' · ' || v_review  || ' to review' else '' end
    || case when v_overdue > 0 then ' · ' || v_overdue || ' overdue'   else '' end;

  for v_person in
    select p.id
      from profiles p
     where p.active
       -- Allowlist 4. `manager` where `member` was, builder still included:
       -- a reminder is a personal alarm, not an audience.
       and p.role in ('manager', 'owner', 'builder')
       and p.reminder_time is not null
       and p.reminder_time <= v_now
       and (p.reminder_last_sent_on is null or p.reminder_last_sent_on < v_today)
  loop
    perform notify_push_one(
      v_person.id, 'Today''s invoices', v_body, '/review', 'reminder');

    update profiles
       set reminder_last_sent_on = v_today
     where id = v_person.id;

    v_sent := v_sent + 1;
  end loop;

  return v_sent;
end;
$fn$;

revoke all on function send_daily_reminders() from public, anon, authenticated;


-- ===========================================================================
--  5. PAID AND UNPAID BELONG TO THE OWNER
--
--  Four functions, one guard. A manager may see that a bill is paid and may
--  not change it; the same on the receivables side.
--
--  ---------------------------------------------------------------------------
--  Why a raised exception rather than `and is_owner()` in the where clause
--
--  Because these functions already carry a meaning for "changed nothing".
--  `where status = 'unpaid'` is what makes them idempotent under an offline
--  replay, and the app reads an empty result as *somebody else already ticked
--  this off* — it says so, in those words. A permission check written as one
--  more `and` would make a refusal indistinguishable from a race, and the app
--  would tell a manager that Mani had just paid a bill nobody has paid.
--
--  So the refusal is loud, carries 42501, and carries a sentence a person can
--  read. Notes §6: the buttons disappear for a manager as well, but the app is
--  not the enforcement layer and must never be the only thing saying no.
--
--  These stay SECURITY INVOKER (migration 004's reasoning: they are
--  transaction boundaries, not privilege boundaries). `is_owner()` is the
--  SECURITY DEFINER piece, and it is the only piece that needs to be.
-- ===========================================================================

create or replace function mark_invoices_paid(p_ids uuid[], p_ref text default null)
returns setof invoices
language plpgsql
security invoker
set search_path = public, pg_temp
as $fn$
begin
  if not is_owner() then
    raise exception 'Only the owner can mark a bill paid.' using errcode = '42501';
  end if;

  return query
  update invoices
     set status      = 'paid',
         paid_at     = now(),
         paid_by     = auth.uid(),
         payment_ref = nullif(trim(coalesce(p_ref, '')), '')
   where id = any(p_ids)
     and status = 'unpaid'
  returning *;
end;
$fn$;

create or replace function unmark_invoice_paid(p_id uuid)
returns setof invoices
language plpgsql
security invoker
set search_path = public, pg_temp
as $fn$
begin
  if not is_owner() then
    raise exception 'Only the owner can put a bill back to unpaid.' using errcode = '42501';
  end if;

  return query
  update invoices
     set status      = 'unpaid',
         paid_at     = null,
         paid_by     = null,
         payment_ref = null
   where id = p_id
     and status = 'paid'
  returning *;
end;
$fn$;

create or replace function mark_sales_received(p_ids uuid[], p_ref text default null)
returns setof sales_invoices
language plpgsql
security invoker
set search_path = public, pg_temp
as $fn$
begin
  if not is_owner() then
    raise exception 'Only the owner can record money received.' using errcode = '42501';
  end if;

  return query
  update sales_invoices
     set status      = 'received',
         received_at = now(),
         received_by = auth.uid(),
         payment_ref = nullif(trim(coalesce(p_ref, '')), ''),
         updated_at  = now()
   where id = any(p_ids)
     and status = 'outstanding'
  returning *;
end;
$fn$;

create or replace function unmark_sales_received(p_id uuid)
returns setof sales_invoices
language plpgsql
security invoker
set search_path = public, pg_temp
as $fn$
begin
  if not is_owner() then
    raise exception 'Only the owner can undo money received.' using errcode = '42501';
  end if;

  return query
  update sales_invoices
     set status      = 'outstanding',
         received_at = null,
         received_by = null,
         payment_ref = null,
         updated_at  = now()
   where id = p_id
     and status = 'received'
  returning *;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- Voiding is NOT here, and that is a decision.
--
-- `void_invoice` stays open to a manager. Voiding takes a bill OUT of every
-- total with a reason attached and leaves it in history struck through — it is
-- correcting a mistake, which is a manager's job. Marking paid asserts that
-- money left the account, which is the owner's.
-- ---------------------------------------------------------------------------


-- ===========================================================================
--  6. PROMOTE AND DEMOTE
--
--  Nobody can change a role from the app today, and not by oversight:
--  migration 007 revoked blanket UPDATE on `profiles` and granted back exactly
--  `notify_on_new_invoice` and `reminder_time`. `role` and `active` are
--  unreachable from a browser by construction.
--
--  That grant stays exactly as it is. Widening it to `role` would let anybody
--  signed in write any value into anybody's row — a grant is coarse and
--  permanent, and cannot ask who is calling. A SECURITY DEFINER function can,
--  which is the same pattern the payment RPCs already use.
-- ===========================================================================

create or replace function set_user_role(p_profile_id uuid, p_role text)
returns profiles
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_target  profiles;
  v_owners  int;
  v_was     text;
begin
  if not is_owner() then
    raise exception 'Only the owner can change what somebody may do.'
      using errcode = '42501';
  end if;

  -- Two values, and `builder` is not one of them. The shadow account is
  -- created by hand or not at all; a screen that can mint one is a screen that
  -- can hide an account from every list in the app.
  if p_role not in ('manager', 'owner') then
    raise exception 'A role can only be set to manager or owner.'
      using errcode = '22023';
  end if;

  select * into v_target from profiles where id = p_profile_id;
  if not found then
    raise exception 'No such person.' using errcode = '22023';
  end if;

  v_was := v_target.role;

  -- ---- Refusal 1: not a builder row --------------------------------------
  -- Otherwise the owner can lock the builder out of the app the builder
  -- maintains, from a screen, in one tap, with no way back in. §44.2.
  if v_was = 'builder' then
    raise exception 'That account maintains the app and cannot be changed here.'
      using errcode = '42501';
  end if;

  -- ---- Refusal 2: nothing to do with staff -------------------------------
  -- A venue account's role is tied to `business_id` and `staff_venue()`.
  -- Moving one through this screen produces a manager with a venue attached,
  -- or a shop with none — two states nothing downstream expects. Shop logins
  -- are made once, by hand, with their venue.
  if v_was = 'staff' then
    raise exception 'A shop login belongs to its venue and cannot be changed here.'
      using errcode = '42501';
  end if;

  -- ---- Refusal 3: not the last owner -------------------------------------
  -- Demoting yourself when you are the only owner leaves nobody who can
  -- promote anybody, and no way out except a hand-written statement.
  --
  -- The builder is NOT counted, though `is_owner()` includes him. He is the
  -- way back from a mistake, not a reason to allow one: an app whose only
  -- remaining owner is invisible to everybody in it has no owner as far as
  -- the four of them are concerned.
  if v_was = 'owner' and p_role <> 'owner' then
    select count(*) into v_owners
      from profiles where active and role = 'owner';

    if v_owners <= 1 then
      raise exception 'That is the only owner. Make somebody else the owner first.'
        using errcode = '42501';
    end if;
  end if;

  update profiles
     set role = p_role
   where id = p_profile_id
  returning * into v_target;

  -- ---- The trace ---------------------------------------------------------
  -- A role change moves who may spend money, so it does not happen quietly.
  -- `activity_log` already takes a free-text entity_type, so this needs no
  -- new table and no new grant: the row is written from inside a SECURITY
  -- DEFINER function, which is the only writer `activity_log` has ever had
  -- (migration 007 gives it a select policy and no insert policy on purpose).
  --
  -- Nothing in the app SHOWS these rows yet. The header bell reads the whole
  -- table and links every row to /invoices/<entity_id>, so it now asks for
  -- invoices only — otherwise a promotion would appear in the feed as an
  -- invoice that does not exist. Recorded and readable by query; surfacing it
  -- is a screen, and that screen is not in this phase.
  insert into activity_log (entity_type, entity_id, action, actor_id, detail)
  values (
    'profile',
    p_profile_id,
    'role_changed',
    auth.uid(),
    jsonb_build_object('role', jsonb_build_object('from', v_was, 'to', p_role))
  );

  return v_target;
end;
$fn$;

revoke execute on function set_user_role(uuid, text) from public, anon;
grant  execute on function set_user_role(uuid, text) to   authenticated;


-- ===========================================================================
--  7. CHECK IT WORKED
--
--  One block, because the SQL editor shows you only the last result. It
--  raises rather than returning rows, so a failure is impossible to scroll
--  past.
-- ===========================================================================

do $$
declare
  v_members  int;
  v_managers int;
  v_owners   int;
  v_old_door int;
  v_new_door int;
  v_owner_fn int;
  v_setrole  int;
  v_guarded  int;
begin
  select count(*) into v_members  from profiles where role = 'member';
  select count(*) into v_managers from profiles where role = 'manager';
  select count(*) into v_owners   from profiles where role = 'owner';

  if v_members > 0 then
    raise exception 'still % rows on the old role name — §1 did not run', v_members;
  end if;

  if v_managers < 1 then
    raise exception 'nobody is a manager — expected Milan and Sujan';
  end if;

  if v_owners < 1 then
    raise exception 'nobody is an owner — STOP and send me this output';
  end if;

  select count(*) into v_old_door from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'is_member';

  select count(*) into v_new_door from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'is_manager_or_above';

  select count(*) into v_owner_fn from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'is_owner';

  select count(*) into v_setrole from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'set_user_role';

  if v_old_door <> 0 then
    raise exception 'is_member() still exists — the rename did not happen';
  end if;
  if v_new_door <> 1 or v_owner_fn <> 1 or v_setrole <> 1 then
    raise exception 'expected is_manager_or_above, is_owner and set_user_role';
  end if;

  -- The policies followed the rename by OID. If this is zero, every table in
  -- the app is unreadable and that is the first thing to know.
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'invoices' and policyname = 'member_all'
  ) then
    raise exception 'invoices.member_all is missing — STOP and send me this output';
  end if;

  -- All four payment RPCs carry the guard. Counted from the source, because
  -- "I rewrote four functions" is exactly the claim that is wrong three
  -- times out of four (HANDOFF §6: a check never extended becomes a claim).
  select count(*) into v_guarded from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('mark_invoices_paid', 'unmark_invoice_paid',
                       'mark_sales_received', 'unmark_sales_received')
     and p.prosrc like '%is_owner()%';

  if v_guarded <> 4 then
    raise exception 'only % of the 4 payment functions check is_owner()', v_guarded;
  end if;

  raise notice 'ok — % owner(s), % manager(s); paid/unpaid is owner-only',
    v_owners, v_managers;
end $$;

-- ---------------------------------------------------------------------------
-- What you should SEE afterwards. Mani owner, Milan and Sujan manager,
-- Rabindra builder, GMH and GMP staff.
-- ---------------------------------------------------------------------------
-- select display_name, role, active from profiles order by role, display_name;
--
-- And, signed in as Milan or Sujan, this must be REFUSED with 42501 rather
-- than returning zero rows:
--
-- select * from mark_invoices_paid(array[]::uuid[]);
