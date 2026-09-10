-- ===========================================================================
-- CATCH_UP_024 — the accents CATCH_UP_003 never converted
--
-- Run this in the Supabase SQL editor. Safe to run more than once.
--
-- **Run it whenever you like.** It touches nothing the app version depends
-- on, so unlike every other file in this folder there is no before-or-after
-- the deploy. It is cosmetic.
--
-- ---------------------------------------------------------------------------
-- Why this is its own file
--
-- It was §5 of CATCH_UP_023, folded in to save a round trip. Its verification
-- raised when the updates matched nothing — and because the SQL editor runs a
-- script as one transaction, **it took the adjustments table and both
-- functions down with it.** A cosmetic change rolled back a schema change.
--
-- Hence: alone, and written so that it cannot fail. There is no `raise
-- exception` anywhere below. The worst case is that it reports what it could
-- not work out and changes nothing.
--
-- ---------------------------------------------------------------------------
-- What is actually wrong
--
-- `profiles.accent` is meant to hold a SLOT NAME — 'person-1' .. 'person-4' —
-- and the live rows still hold hex: '#C9A227' for Mani, and so on. Found by
-- reading the output of `db/verify_schema.sql`.
--
-- Rule 3 is that hex colours exist only in `app/globals.css`, because a
-- repaint has to be able to change every colour in one place. Four of them in
-- a table is that rule broken, and it is why `PersonChip.slotOf` carries a
-- fallback whose own comment says "until the catch-up SQL is run".
--
-- **Nothing looks broken today.** That fallback derives a stable slot from
-- each person's id, so the chips have distinct, consistent colours — just not
-- the ones anybody chose. This makes them the ones anybody chose.
-- ===========================================================================


-- ===========================================================================
--  1. BY ID, WHICH IS WHAT SHOULD WORK
--
--  The ids from `db/seed/002_profiles.sql`. If the live accounts are the
--  seeded ones, this is the whole job and §2 finds nothing left to do.
--
--  These may match nothing, and that is not an error — it means the accounts
--  were created separately from the seed file, which is entirely possible
--  three phases later. §2 is the answer for that case rather than this file
--  failing.
-- ===========================================================================

update profiles set accent = 'person-1'
 where id = '2da43dcf-8b0f-4229-bf5c-e5af68210045' and accent like '#%';
update profiles set accent = 'person-2'
 where id = 'b3153037-4bf5-4baa-8c11-b94e690c92bd' and accent like '#%';
update profiles set accent = 'person-3'
 where id = 'a207c7b2-5389-445a-a46e-bb3dd7b2caad' and accent like '#%';
update profiles set accent = 'person-4'
 where id = 'f57715ab-a468-4d2a-9796-0c639a2d259b' and accent like '#%';


-- ===========================================================================
--  2. AND ANYONE STILL LEFT ON A HEX
--
--  Whoever remains gets the next free slot, in a stable order.
--
--  ---------------------------------------------------------------------------
--  Ordered by `id`, not by name and not by when they joined.
--
--  It has to be deterministic or running this twice could hand two people
--  each other's colour. `id` is the one field on a profile that never
--  changes: a display name can be edited, and CATCH_UP_003 matched on exactly
--  that, which is part of how it came to be re-run against rows it no longer
--  matched.
--
--  Slots already taken in §1 are skipped, so nobody ends up sharing.
--  ---------------------------------------------------------------------------
--
--  Venues are excluded. 'venue' is already a slot name and is what
--  `PersonChip` looks for to render a shop without a face — converting it
--  would give GroceryMate Hurstville a person's colour.
-- ===========================================================================

with taken as (
  select accent from profiles where accent like 'person-%'
),
free as (
  select slot, row_number() over (order by slot) as n
    from unnest(array['person-1', 'person-2', 'person-3', 'person-4']) as slot
   where slot not in (select accent from taken)
),
stragglers as (
  select id, row_number() over (order by id) as n
    from profiles
   where accent like '#%'
     and role <> 'staff'
)
update profiles p
   set accent = free.slot
  from stragglers
  join free on free.n = stragglers.n
 where p.id = stragglers.id;


-- ===========================================================================
--  3. WHAT HAPPENED
--
--  A notice, never an exception. This file must not be able to take anything
--  else down with it — which is the entire reason it exists separately.
-- ===========================================================================

do $$
declare
  v_hex   int;
  v_slots int;
begin
  select count(*) into v_hex   from profiles where accent like '#%';
  select count(*) into v_slots from profiles where accent like 'person-%';

  if v_hex = 0 then
    raise notice 'ok — no hex accents left, % profiles on slot names', v_slots;
  else
    -- Not a failure. The app renders these perfectly well through
    -- `PersonChip.slotOf`'s fallback; they are simply not the assigned
    -- colours. Worth knowing about, not worth stopping for.
    raise notice
      '% profile(s) still hold a hex accent. The app still renders them; '
      'tell the builder and it can be sorted by hand.', v_hex;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- What you should SEE afterwards — slot names, and 'venue' for the two shops:
--
--   select display_name, role, accent from profiles order by accent;
-- ---------------------------------------------------------------------------
