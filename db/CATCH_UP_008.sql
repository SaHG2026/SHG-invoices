-- ============================================================================
--  CATCH-UP 008 — pictures are yours alone.
--
--  Supabase SQL editor -> New query -> paste -> Run.
--  Safe to run twice. One function, nothing else. Changes no invoice.
--
--  ---------------------------------------------------------------------------
--  What this corrects, and why
--
--  CATCH_UP_007 let the owner change logos as well as the builder. That was my
--  call, on the reasoning that the point of the feature was nobody having to
--  wait on one person. You corrected it:
--
--    "mani doesnt get to do any editing stuffs. the three users are only users
--     with mani having slight higher authority."
--
--  You are right, and it is the sharper reading of what `role` has always meant
--  in this database. Mani's authority is over the MONEY — he is the one told
--  when a bill is paid (CATCH_UP_006), and the one whose screen carries the
--  overview. It was never authority over the app itself, and a logo is part of
--  the app rather than part of the ledger.
--
--  So the three of them are users. The builder is the only editor, and the
--  builder is not one of the four names.
--  ---------------------------------------------------------------------------

create or replace function is_brand_editor()
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
       and p.role = 'builder'
  );
$fn$;

-- The four storage policies from CATCH_UP_007 call this function by name, so
-- replacing it is the whole change. Nothing needs re-granting.

-- ----------------------------------------------------------------------------
-- Check it. Expect exactly one row, and it should be Rabindra.
-- ----------------------------------------------------------------------------
select display_name, role
  from profiles
 where role = 'builder';
