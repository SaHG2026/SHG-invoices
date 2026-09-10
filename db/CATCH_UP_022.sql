-- ===========================================================================
-- CATCH_UP_022 — a fourth tier: assistant
--
-- Run this in the Supabase SQL editor. Safe to run more than once.
--
-- RUN THIS **BEFORE** THE DEPLOY, and this one is not a preference.
--
-- The new app version can set somebody's role to 'assistant'. Run late, the
-- constraint below still refuses that value and `set_user_role` refuses it
-- too, so the button comes back with an error. Run early it is invisible:
-- a role nobody holds, and policies that match nobody.
--
-- ---------------------------------------------------------------------------
-- What this is for
--
-- Asked for as *"there needs to be option to demote Milan/Sujan to staff as
-- well within the change button"*, and then narrowed: the tier wanted is not
-- the venue one. It is a person who works across all four businesses, may LOG
-- a bill, and may not act on one.
--
--   sees    every business's invoices, paid and unpaid, and who did what
--   does    enters an invoice; writes a note on one
--   cannot  review, approve, edit, void, mark paid or unpaid, add or change a
--           supplier, customer or product, or touch Deli's receivables at all
--
-- ---------------------------------------------------------------------------
-- Why it is not called `staff`, which is the word that was asked for
--
-- `staff` already means something specific and different: **a venue, not a
-- person** (lib/types.ts says so in as many words). A staff row must have a
-- `business_id` and a non-staff row must not — `profiles_staff_has_venue`
-- enforces it — and `staff_venue()`, the `staff_invoices` view and four
-- policies are all built on that pairing.
--
-- Putting a second meaning on the value would be two names for one tier
-- inverted: one name for two tiers. That is the shape problem this project
-- keeps removing, and it would be removing it backwards.
--
-- ---------------------------------------------------------------------------
-- The rule this file is most likely to break, so it is stated first
--
-- `is_manager_or_above()` is an ALLOWLIST, and every policy in the database
-- that means "one of the people who run this" says it. **Nothing below adds
-- `assistant` to it.** If it did, this tier would silently gain every
-- permission that predicate has ever guarded — suppliers, customers,
-- products, Deli's invoices, all of it — because those policies are `for all`.
--
-- So `assistant` gets its own predicate and its own, narrower policies, and
-- every existing policy continues to exclude it by default. A policy written
-- in a later phase that says `is_manager_or_above()` like all the others is
-- already right, which is the property CATCH_UP_010 §2 bought and this file
-- must not spend.
-- ===========================================================================


-- ===========================================================================
--  1. THE VALUE
--
--  Its own statement, before anything references it. A check constraint is
--  validated against every existing row on creation, and there are no
--  assistants yet, so this cannot fail.
-- ===========================================================================

alter table profiles drop constraint if exists profiles_role_valid;

alter table profiles
  add constraint profiles_role_valid
  check (role in ('manager', 'owner', 'builder', 'staff', 'assistant'));

-- `profiles_staff_has_venue` is deliberately NOT touched. It says a venue is
-- staff and staff is a venue; an assistant is neither, so it must have no
-- `business_id` — which the existing constraint already requires of every
-- role that is not 'staff'. An assistant with a venue stays unrepresentable.


-- ===========================================================================
--  2. THE PREDICATE
--
--  A separate function rather than a widened one, for the reason in the
--  header. It is an allowlist of exactly one value, and it fails closed for
--  whatever the fifth tier turns out to be.
-- ===========================================================================

create or replace function is_assistant()
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
       and p.role = 'assistant'
  );
$fn$;

comment on function is_assistant() is
  'A person who may log a bill and may not act on one. ARCHITECTURE §52.';

-- CATCH_UP_011's default, applied here too.
revoke execute on function is_assistant() from public, anon;
grant  execute on function is_assistant() to   authenticated;


-- ===========================================================================
--  3. WHAT AN ASSISTANT MAY READ
--
--  Five tables, all `for select` only, each as its own policy beside the
--  existing one rather than by loosening it.
--
--  PostgreSQL ORs permissive policies, so a manager still passes through
--  `member_all` exactly as before and nothing about the existing tiers
--  changes. That is the point of adding rather than editing: this file cannot
--  narrow anybody by accident.
--
--  **`profiles` is the one that is not optional.** Without it an assistant
--  cannot read their OWN row, `useCurrentProfile` returns null, and the app
--  decides they are not signed in. Every other table below is a screen; this
--  one is the front door.
-- ===========================================================================

drop policy if exists assistant_read on invoices;
create policy assistant_read on invoices
  for select using (is_assistant());

drop policy if exists assistant_read on invoice_notes;
create policy assistant_read on invoice_notes
  for select using (is_assistant());

drop policy if exists assistant_read on suppliers;
create policy assistant_read on suppliers
  for select using (is_assistant());

drop policy if exists assistant_read on businesses;
create policy assistant_read on businesses
  for select using (is_assistant());

drop policy if exists assistant_read on profiles;
create policy assistant_read on profiles
  for select using (is_assistant());

drop policy if exists assistant_read on activity_log;
create policy assistant_read on activity_log
  for select using (is_assistant());

-- Uploaded artwork, so faces and logos render. The photographs are at public
-- urls anyway (§33.1, accepted), so this grants nothing new in practice; it
-- keeps the bucket policy honest about who the app expects to read it.
drop policy if exists assistant_read_brand on storage.objects;
create policy assistant_read_brand on storage.objects
  for select using (bucket_id = 'brand' and is_assistant());


-- ===========================================================================
--  4. WHAT AN ASSISTANT MAY WRITE — two things, and only their own
--
--  There is no UPDATE policy and no DELETE policy here, and their absence is
--  the whole tier. An assistant cannot edit an invoice, void one, approve
--  one, or move it between paid and unpaid — not because a screen hides the
--  button, but because no policy exists that would let the row change.
--
--  `created_by = auth.uid()` in the check is not decoration. Without it an
--  assistant could insert a row attributed to Mani, and attribution is the
--  thing the four of them are trusting (rule 1's whole reasoning).
-- ===========================================================================

drop policy if exists assistant_insert on invoices;
create policy assistant_insert on invoices
  for insert with check (is_assistant() and created_by = auth.uid());

drop policy if exists assistant_insert on invoice_notes;
create policy assistant_insert on invoice_notes
  for insert with check (is_assistant() and author_id = auth.uid());


-- ===========================================================================
--  5. THEIR ENTRIES DO NOT WAIT FOR REVIEW, AND THAT IS A DECISION
--
--  `stamp_approval` (CATCH_UP_013) approves everybody's insert except a
--  venue's. Nothing below changes it, so an assistant's invoice goes straight
--  into the ledger and into the owed total.
--
--  The argument: a venue is a shared login on a shop counter, and an
--  assistant is a named person the owner has chosen to give a login to. The
--  tier exists so somebody cannot ALTER or SETTLE the ledger, not because
--  what they type is doubted. Sending their entries to review would also make
--  the owner the bottleneck for every invoice on the days both managers are
--  assistants, which is the objection already raised and accepted about
--  paid/unpaid — and it would be raised again, harder, here.
--
--  **If that is wrong, it is one line.** `stamp_approval` becomes
--  `if is_staff() or is_assistant() then` and their entries queue in Review
--  behind the same screen the shops already use. Nothing else has to change:
--  `onlyOwed` already refuses anything unapproved, and the Review screen
--  already exists.
-- ===========================================================================


-- ===========================================================================
--  6. NOTIFICATIONS — excluded, by doing nothing
--
--  The two push audiences and the daily reminder are allowlists (CATCH_UP_010
--  §6, CATCH_UP_019 §3 and §4). An allowlist excludes a value that is not
--  added to it, so an assistant is already out of all three and no statement
--  here is what keeps them out.
--
--  Recorded because the failure mode of an allowlist is the opposite of a
--  blocklist's: a tier added without visiting each one is a tier quietly
--  excluded, and silence is not evidence that it was considered. It was.
--  Adding them later means visiting `push_targets`, `payment_push_targets`
--  and the reminder view on purpose.
-- ===========================================================================


-- ===========================================================================
--  7. SETTING THE ROLE
--
--  `set_user_role` gains one value. Every refusal it already makes stays
--  exactly as it was, including the two that matter most here:
--
--    * a builder row cannot be changed, so the shadow account cannot be
--      demoted out of the app it maintains
--    * the last owner cannot be demoted, and demoting an owner to assistant
--      goes through that check unchanged — `p_role <> 'owner'` already covers
--      every destination that is not owner
--
--  And the refusal on `staff` stays too: a shop login still cannot be moved
--  through this screen, in either direction. An assistant is not a venue and
--  the two must not become a path to each other.
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

  -- Three values now, and `builder` is still not one of them. The shadow
  -- account is created by hand or not at all; a screen that can mint one is a
  -- screen that can hide an account from every list in the app.
  if p_role not in ('manager', 'owner', 'assistant') then
    raise exception 'A role can only be set to owner, manager or assistant.'
      using errcode = '22023';
  end if;

  select * into v_target from profiles where id = p_profile_id;
  if not found then
    raise exception 'No such person.' using errcode = '22023';
  end if;

  v_was := v_target.role;

  -- ---- Refusal 1: not a builder row --------------------------------------
  if v_was = 'builder' then
    raise exception 'That account maintains the app and cannot be changed here.'
      using errcode = '42501';
  end if;

  -- ---- Refusal 2: nothing to do with staff -------------------------------
  -- Unchanged, and it matters more now that there is a tier which sounds like
  -- it. A venue account's role is tied to `business_id`; moving one here
  -- produces a shop with no venue or a person with one.
  if v_was = 'staff' then
    raise exception 'A shop login belongs to its venue and cannot be changed here.'
      using errcode = '42501';
  end if;

  -- ---- Refusal 3: not the last owner -------------------------------------
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
--  8. CHECK IT WORKED
--
--  Raises rather than returning rows, so a failure cannot be scrolled past.
-- ===========================================================================

do $$
declare
  v_fn      int;
  v_reads   int;
  v_writes  int;
  v_bad     int;
begin
  -- The value is accepted.
  begin
    perform 1 from profiles where role = 'assistant';
  exception when others then
    raise exception 'profiles cannot be queried for the new role: %', sqlerrm;
  end;

  if not exists (
    select 1 from pg_constraint
     where conname = 'profiles_role_valid'
       and pg_get_constraintdef(oid) like '%assistant%'
  ) then
    raise exception 'profiles_role_valid does not allow assistant';
  end if;

  select count(*) into v_fn from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'is_assistant';
  if v_fn <> 1 then
    raise exception 'is_assistant() is missing';
  end if;

  -- Six read policies in public, plus the storage one which lives elsewhere.
  select count(*) into v_reads
    from pg_policies
   where schemaname = 'public' and policyname = 'assistant_read';
  if v_reads <> 6 then
    raise exception 'expected 6 assistant_read policies, found %', v_reads;
  end if;

  select count(*) into v_writes
    from pg_policies
   where schemaname = 'public' and policyname = 'assistant_insert';
  if v_writes <> 2 then
    raise exception 'expected 2 assistant_insert policies, found %', v_writes;
  end if;

  -- ---- The thing this file must NOT have done ---------------------------
  -- An UPDATE or DELETE policy for the assistant anywhere is the tier
  -- undone: it would mean somebody who cannot review can nevertheless change
  -- a row after it is in the ledger.
  select count(*) into v_bad
    from pg_policies
   where schemaname = 'public'
     and policyname like 'assistant%'
     and cmd in ('UPDATE', 'DELETE', 'ALL');
  if v_bad <> 0 then
    raise exception 'an assistant policy can change or remove rows — that is wrong';
  end if;

  -- And the allowlist must not have been widened. If `is_manager_or_above()`
  -- ever mentions the new tier, every `for all` policy in the database has
  -- silently included it.
  if exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'is_manager_or_above'
       and p.prosrc like '%assistant%'
  ) then
    raise exception 'is_manager_or_above() now includes assistant — that is wrong';
  end if;

  raise notice 'ok — assistant exists, reads six tables, writes two, changes none';
end $$;

-- ---------------------------------------------------------------------------
-- What you should SEE afterwards. Nobody holds the new role yet:
--
--   select display_name, role from profiles order by role, display_name;
--
-- And signed in as Milan or Sujan, this must be REFUSED with 42501:
--
--   select * from set_user_role(
--     (select id from profiles where display_name = 'Sujan'), 'assistant');
--
-- Signed in as the owner it must succeed, and the person must immediately
-- fail `is_manager_or_above()`:
--
--   select display_name, role from profiles where role = 'assistant';
-- ---------------------------------------------------------------------------
