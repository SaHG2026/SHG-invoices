-- ===========================================================================
-- CATCH_UP_025 — suspending an account, and lifting it
--
-- Run this in the Supabase SQL editor. Safe to run more than once.
--
-- RUN THIS **BEFORE** THE DEPLOY, and this one is not a preference.
--
-- The new app version calls `set_user_active`. Run late, the function does not
-- exist and the button comes back 42883. Run early it is invisible: one
-- function the live version never calls.
--
-- **Nothing below changes anybody's access when you run it.** It creates the
-- door; it does not use it.
--
-- ---------------------------------------------------------------------------
-- What this is for
--
-- Asked for as absolute control over the users, including creating them.
-- Creating is still not possible and still for the reason in rule 1: Supabase
-- makes accounts only through the Auth Admin API, which needs the service-role
-- key, and that key is the one thing this architecture is built to not have —
-- with it present `auth.uid()` returns null and every invoice silently loses
-- its author.
--
-- Suspension is the half that IS possible, and it turns out to be most of what
-- was wanted: somebody can be shut out in one tap and let back in the same
-- way, and nothing they did is lost.
--
-- ---------------------------------------------------------------------------
-- Why this needs almost nothing new
--
-- `profiles.active` has existed since migration 005, and **every permission
-- function in the database already tests it**:
--
--   is_manager_or_above()   ... and p.active and p.role in (...)
--   is_owner()              ... and p.active ...
--   is_staff()              ... and p.active ...
--   is_assistant()          ... and p.active ...
--
-- So setting it false locks somebody out of everything at once, with no new
-- check anywhere and no policy to keep in step. The column is unreachable from
-- a browser only because the column grant does not include it (migration 007),
-- which is exactly the wall `role` sat behind until CATCH_UP_019 — and the way
-- through is the same: a function that can ask who is calling, rather than a
-- widened grant that cannot.
--
-- **Nothing is deleted and nothing is hidden.** Rule 5. A suspended person
-- keeps every invoice they entered, with their name on it — `useProfiles` was
-- fixed in the same round to stop filtering them out of the lookup (§54.1),
-- which it had been doing for a year.
-- ===========================================================================


-- ===========================================================================
--  1. THE FUNCTION
--
--  Deliberately separate from `set_user_role` rather than a fifth argument on
--  it. They are two different sentences — "what may this person do" and
--  "may this person get in at all" — and a role change that could also
--  suspend, or a suspension that could also change a role, is one call doing
--  two things with one confirmation in front of it.
-- ===========================================================================

create or replace function set_user_active(p_profile_id uuid, p_active boolean)
returns profiles
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_target profiles;
  v_owners int;
begin
  if not is_owner() then
    raise exception 'Only the owner can suspend somebody.'
      using errcode = '42501';
  end if;

  if p_active is null then
    raise exception 'Say whether they are in or out.' using errcode = '22023';
  end if;

  select * into v_target from profiles where id = p_profile_id;
  if not found then
    raise exception 'No such person.' using errcode = '22023';
  end if;

  -- ---- Refusal 1: not the builder ----------------------------------------
  -- §44.2, and the same refusal `set_user_role` makes. An owner able to
  -- suspend the builder can lock the builder out of the app the builder
  -- maintains, from a screen, in one tap, with no way back in.
  if v_target.role = 'builder' then
    raise exception 'That account maintains the app and cannot be suspended.'
      using errcode = '42501';
  end if;

  -- ---- Refusal 2: not yourself -------------------------------------------
  -- A control whose only effect is to lock you out of the app you are holding,
  -- recoverable only by somebody else. There is no version of this that is
  -- what somebody meant to do.
  if p_profile_id = auth.uid() then
    raise exception 'You cannot suspend yourself.' using errcode = '42501';
  end if;

  -- ---- Refusal 3: not the last owner -------------------------------------
  -- The same rule `set_user_role` applies to demotion, for the same reason
  -- one step further on: suspending the last owner leaves nobody who can
  -- promote anybody, change a role, OR lift a suspension. The way back would
  -- be a hand-written statement in this editor.
  --
  -- The builder is not counted, though `is_owner()` includes him — §46.3's
  -- reasoning: an app whose only remaining owner is invisible to everybody in
  -- it has no owner as far as the four of them are concerned.
  if v_target.role = 'owner' and p_active = false then
    select count(*) into v_owners
      from profiles where active and role = 'owner';

    if v_owners <= 1 then
      raise exception 'That is the only owner. Make somebody else the owner first.'
        using errcode = '42501';
    end if;
  end if;

  -- Nothing to do is not an error, but it must not write a log line saying
  -- something happened. `set_user_role` has the same shape by accident; this
  -- one says so.
  if v_target.active = p_active then
    return v_target;
  end if;

  update profiles
     set active = p_active
   where id = p_profile_id
  returning * into v_target;

  -- ---- The trace ---------------------------------------------------------
  -- Being shut out of the app is at least as large as a role change, so it is
  -- recorded the same way and in the same place.
  --
  -- `entity_type` is 'profile', which keeps it out of the header bell and the
  -- invoice stream — both filter `entity_type = 'invoice'`, so no renderer has
  -- to learn a word for it and a suspension cannot appear in the feed as an
  -- invoice that does not exist. CATCH_UP_019 §6 made the same choice.
  insert into activity_log (entity_type, entity_id, action, actor_id, detail)
  values (
    'profile',
    p_profile_id,
    case when p_active then 'reinstated' else 'suspended' end,
    auth.uid(),
    jsonb_build_object('active', jsonb_build_object('from', not p_active, 'to', p_active))
  );

  return v_target;
end;
$fn$;

comment on function set_user_active(uuid, boolean) is
  'Shut somebody out of the app, or let them back in. Owner only, and never '
  'the builder, yourself, or the last owner. ARCHITECTURE §54.';

-- CATCH_UP_011's default. Nothing anonymous may reach this.
revoke execute on function set_user_active(uuid, boolean) from public, anon;
grant  execute on function set_user_active(uuid, boolean) to   authenticated;


-- ===========================================================================
--  2. THE GRANT STAYS EXACTLY AS IT WAS
--
--  Stated because the tempting shortcut is one line and would undo the whole
--  design: `grant update (active) on profiles to authenticated` would let
--  anybody suspend anybody, including themselves and the builder, with none of
--  the three refusals above and no log line.
--
--  A grant is coarse and permanent and cannot ask who is calling. A function
--  can. CATCH_UP_019 §6 and CATCH_UP_020 §2 both say this; it is repeated here
--  because this is the third time the same shortcut has been available.
-- ===========================================================================


-- ===========================================================================
--  3. CHECK IT WORKED
--
--  Raises rather than returning rows, so a failure cannot be scrolled past.
--  Nothing here suspends anybody.
-- ===========================================================================

do $$
declare
  v_fn    int;
  v_grant int;
begin
  select count(*) into v_fn from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'set_user_active';
  if v_fn <> 1 then
    raise exception 'set_user_active is missing';
  end if;

  if not exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'set_user_active' and p.prosecdef
  ) then
    raise exception 'set_user_active is not security definer — it could not write';
  end if;

  -- ---- The thing this file must NOT have done ---------------------------
  -- A column grant on `active` would make every refusal above decorative.
  select count(*) into v_grant
    from information_schema.column_privileges
   where table_schema  = 'public'
     and table_name    = 'profiles'
     and column_name   = 'active'
     and privilege_type = 'UPDATE'
     and grantee       = 'authenticated';

  if v_grant <> 0 then
    raise exception 'authenticated can update profiles.active directly — that is wrong';
  end if;

  raise notice 'ok — suspension exists, and the column is still unreachable directly';
end $$;

-- ---------------------------------------------------------------------------
-- What you should SEE afterwards. Nobody's access has changed:
--
--   select display_name, role, active from profiles order by display_name;
--
-- Signed in as Milan or Sujan this must be REFUSED with 42501:
--
--   select * from set_user_active(
--     (select id from profiles where display_name = 'Sujan'), false);
--
-- And signed in as the owner, suspending YOURSELF must also be refused:
--
--   select * from set_user_active(auth.uid(), false);
-- ---------------------------------------------------------------------------
