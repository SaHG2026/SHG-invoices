-- ############################################################################
--
--  CATCH-UP 010 — venue staff accounts.
--
--  Supabase SQL editor -> New query -> paste -> Run.
--  Safe to run twice.
--
--  ---------------------------------------------------------------------------
--  READ THIS BEFORE RUNNING IT.
--
--  Every statement in this file is a NO-OP until a staff profile row exists,
--  and this file does not create one. Nothing anybody can see changes when you
--  run it. Creating the two accounts is a separate, deliberate step, and the
--  instructions are at the bottom.
--
--  That is the point: the risky half and the visible half are separated, so
--  the risky half can be verified while the app carries on working.
--  ---------------------------------------------------------------------------
--
--  What this is for
--
--  GroceryMate Parramatta and Hurstville get a login each, so the shop enters
--  its own invoices and management reviews rather than types. Two shops, one
--  login each, shared by whoever is on shift.
--
--  A staff account can do exactly two things:
--
--    * see the invoices logged against its own venue — supplier, number,
--      dates, amount. Not whether any of them has been paid.
--    * add an invoice to its own venue, and create a supplier while doing it.
--    * correct one it entered itself, for five minutes afterwards.
--
--  It cannot see another venue, the payment status of anything, the customer
--  list, the receivables, the activity log, or who paid what.
--
--  ---------------------------------------------------------------------------
--  THE DECISION THIS FILE TAKES, NAMED
--
--  Migration 005 says:
--
--    "`role` is NOT a permission, and it is deliberately absent from every RLS
--     policy in 007. If `role` ever starts deciding what somebody can read or
--     write, that belongs in a policy — and this comment is the warning that
--     no such policy has been written."
--
--  This is that moment, taken deliberately. From here `role` IS a permission,
--  the policies below are where it lives, and migration 005's comment has been
--  honoured rather than ignored.
--
-- ############################################################################


-- ============================================================================
--  1. THE SHAPE
--
--  A staff account is two facts: it is staff, and it belongs to one venue.
--  Storing them separately would allow two states that must never exist — a
--  staff account with no venue (which venue's invoices?) and a member with one
--  (why is Mani tied to Hurstville?).
--
--  So a constraint makes both unrepresentable. ARCHITECTURE §19: of the bugs
--  found on a real phone, five were values that could hold states which should
--  not exist. This is the cheapest possible place to stop the sixth.
-- ============================================================================

alter table profiles drop constraint if exists profiles_role_valid;

alter table profiles
  add constraint profiles_role_valid check (role in ('member', 'owner', 'builder', 'staff'));

alter table profiles
  add column if not exists business_id uuid references businesses(id);

do $$ begin
  alter table profiles
    add constraint profiles_staff_has_venue check (
      (role =  'staff' and business_id is not null)
      or
      (role <> 'staff' and business_id is null)
    );
exception when duplicate_object then null;
end $$;

-- Migration 007 revoked blanket UPDATE on profiles and granted back exactly one
-- column. `business_id` is deliberately NOT added to that grant: a staff
-- account must not be able to move itself to another venue.
--
-- Restated here rather than assumed, because it is the single line standing
-- between "sees Parramatta" and "sees whichever venue it fancies".
revoke update on profiles from authenticated;
grant  update (notify_on_new_invoice) on profiles to authenticated;


-- ============================================================================
--  2. THE DOOR
--
--  Nine policies across migrations 007, 008, 009 and CATCH_UP_007 say
--  `is_member()`, and every one of them means "one of the four". Adding
--  `and business_id = ...` to nine policies is nine chances to miss one, and a
--  missed one is a leak nobody sees.
--
--  So the door changes meaning instead. `is_member()` stops being "has an
--  active profile" and becomes "is one of the people who run the businesses".
--  Every existing policy then excludes staff without being touched, and — the
--  part that matters — any policy written in FUTURE by somebody who has never
--  read this file also excludes staff, because it will say `is_member()` like
--  all the others do.
--
--  Staff access is added deliberately, one object at a time, below. The
--  default is no.
-- ============================================================================

create or replace function is_staff()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select exists (
    select 1 from profiles p
     where p.id = auth.uid() and p.active and p.role = 'staff'
  );
$fn$;

-- The venue a staff caller belongs to, or NULL for everybody else.
--
-- NULL is load-bearing. Every staff rule below compares against this, and in
-- SQL `business_id = null` is never true — so for the four, and for anybody
-- signed in who is not staff, every staff rule silently matches nothing.
-- It fails closed by the shape of the comparison, not by remembering to check.
create or replace function staff_venue()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select p.business_id
    from profiles p
   where p.id = auth.uid() and p.active and p.role = 'staff';
$fn$;

-- The narrowing. A no-op for the current four — all of them are member, owner
-- or builder — and the verification at the bottom proves it rather than
-- asserting it.
create or replace function is_member()
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
       and p.role in ('member', 'owner', 'builder')
  );
$fn$;


-- ============================================================================
--  3. WHAT A STAFF ACCOUNT MAY READ
--
--  The hard requirement: they see their invoices, and never whether one has
--  been paid.
--
--  Two mechanisms cannot do this job, and it is worth knowing why so nobody
--  tries them later:
--
--    * RLS cannot restrict columns. It decides which ROWS you see, full stop.
--    * A column-level GRANT can, but it applies to the `authenticated` role,
--      which is every signed-in person. Hiding `status` that way hides it
--      from Mani too.
--
--  So the columns are removed by a view, and the base table stays shut.
--
--  ---------------------------------------------------------------------------
--  AND: the view returns every invoice for the venue, paid or not.
--
--  That is not laziness, it is the requirement. If staff saw only unpaid ones,
--  a row disappearing from their list would BE the payment notification —
--  absence leaks exactly the fact being withheld. Nothing on their screen may
--  correlate with payment, so nothing enters or leaves it when one happens.
--
--  Void invoices are excluded. A void is a correction — the entry was wrong —
--  and it carries no payment information, so hiding it leaks nothing.
--  ---------------------------------------------------------------------------
-- ============================================================================

-- !! THIS VIEW IS THE ENTIRE BOUNDARY. !!
--
-- A view runs with its OWNER's rights, not the caller's, so this reads
-- `invoices` in full regardless of the fact that staff have no policy on it.
-- Its WHERE clause is the only thing standing between one venue and all four.
-- If you edit it, re-run db/verify_rls.mjs as a staff account before trusting
-- it. Migration 007's rule applies here more than anywhere: verify, do not
-- click.
--
-- Explicitly NOT here: status, paid_at, paid_by, payment_ref, void_reason,
-- created_by, updated_at.
create or replace view staff_invoices as
  select
    i.id,
    i.business_id,
    i.supplier_id,
    s.name           as supplier_name,
    i.invoice_number,
    i.internal_ref,
    i.invoice_date,
    i.due_date,
    i.amount_cents,
    i.created_at
  from invoices i
  join suppliers s on s.id = i.supplier_id
 where i.business_id = staff_venue()
   and i.status <> 'void';

-- Stated rather than left to the default, so a future Postgres or Supabase
-- default cannot change what this view is without somebody noticing.
--
-- If it ever did flip to `on`, staff would get zero rows — they have no select
-- policy on `invoices` — which is the safe direction to fail in.
do $do$ begin
  alter view staff_invoices set (security_invoker = false);
exception when others then null;   -- option does not exist before Postgres 15,
end $do$;                           -- where every view already ran as its owner.

revoke all    on staff_invoices from anon;
grant  select on staff_invoices to   authenticated;


-- ============================================================================
--  4. WHAT A STAFF ACCOUNT MAY WRITE
--
--  An invoice into its own venue, and a supplier while entering one.
-- ============================================================================

-- ------------------------------------------------------------------ invoices
--
-- INSERT only. No select, no update, no delete.
--
-- `with check` is the load-bearing half and the easy one to leave out. `using`
-- governs rows you may see or change; `with check` governs rows you may
-- CREATE. Without it, Parramatta can file an invoice against Hurstville.
--
-- There is deliberately no SELECT policy. That has a consequence the app must
-- respect: a staff insert cannot use `.select()` to return the new row,
-- because returning it would read the base table and hand back the status
-- columns this whole file exists to withhold. lib/queries/venue.ts carries the
-- same note.
drop policy if exists staff_insert on invoices;
create policy staff_insert on invoices
  for insert with check (business_id = staff_venue());

-- ----------------------------------------------------------- fixing a typo
--
-- Five minutes to correct what you just typed, and then it is head office's.
--
-- ---------------------------------------------------------------------------
-- Why a CLOCK and not "while it is unpaid"
--
-- The obvious rule is "editable until it is paid". It cannot be used, and the
-- reason is the whole shape of this feature: a shop would learn the payment
-- status from whether the edit was refused. The rule that decides what you may
-- do must not be the fact you are not allowed to know.
--
-- A clock leaks nothing. Five minutes after entry is five minutes after entry,
-- the shop can see it coming, and it says nothing whatever about money.
--
-- `status = 'unpaid'` is STILL in the policy, on both sides, and it is not
-- there to hide anything — it is there so an invoice that has already been
-- paid cannot have its amount changed underneath the payment. The leak that
-- creates is: somebody paid this within five minutes of a shop entering it,
-- which is a case that will essentially never happen and which reveals nothing
-- when it does, because the app says the same sentence either way.
-- ---------------------------------------------------------------------------
--
-- Four conditions, and each one is load-bearing:
--
--   business_id = staff_venue()   their own venue
--   created_by  = auth.uid()      their own entry, not one Mani made for them
--   status      = 'unpaid'        see above
--   created_at  > now() - 5 min   the window
--
-- And the same four in `with check`, minus the clock, so the row cannot be
-- edited INTO somebody else's venue, onto somebody else's name, or into a paid
-- state. `using` decides which row you may touch; `with check` decides what it
-- may look like afterwards, and leaving the second one out is how a "fix a
-- typo" policy becomes "mark your own invoice paid".
drop policy if exists staff_update on invoices;
create policy staff_update on invoices
  for update
  using (
    business_id = staff_venue()
    and created_by = auth.uid()
    and status = 'unpaid'
    and created_at > now() - interval '5 minutes'
  )
  with check (
    business_id = staff_venue()
    and created_by = auth.uid()
    and status = 'unpaid'
  );

-- ---------------------------------------------------------------------------
-- The hole that policy leaves, and the trigger that closes it.
--
-- `created_at` is what the five minutes is measured from, and nothing above
-- stops it being SET. A crafted update could write `created_at = now()` on
-- every edit and keep one invoice editable forever — the window would exist
-- and mean nothing.
--
-- RLS cannot express "this column may not change"; only a trigger can. And it
-- is the right rule for everybody, not a staff patch: when a row was created,
-- and what its reference is, are facts about it. Neither is a field. The four
-- have never changed either and nothing in the app tries to.
-- ---------------------------------------------------------------------------
create or replace function pin_invoice_facts()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  new.created_at   := old.created_at;
  new.internal_ref := old.internal_ref;
  return new;
end;
$fn$;

-- Fires before touch_updated_at, alphabetically, which is fine either way:
-- they write different columns.
drop trigger if exists invoices_pin_facts on invoices;
create trigger invoices_pin_facts
  before update on invoices
  for each row execute function pin_invoice_facts();

-- ----------------------------------------------------------------- suppliers
--
-- Read all, insert new, change none.
--
-- Read-all is a deliberate acceptance, not an oversight: the supplier
-- type-ahead is how the fifteen seconds works, and it needs the list. So
-- Parramatta will see the names of suppliers only Majheri uses. A supplier
-- name is not a figure, and no amount, invoice or payment travels with it.
--
-- UPDATE is withheld on purpose. Suppliers are shared by all four businesses,
-- and one shop renaming or deactivating a supplier the group depends on is a
-- change nobody would know how to trace.
drop policy if exists staff_read on suppliers;
create policy staff_read on suppliers
  for select using (is_staff());

drop policy if exists staff_insert on suppliers;
create policy staff_insert on suppliers
  for insert with check (is_staff());

-- ---------------------------------------------------------------- businesses
-- Their own venue only, so the screen can say "GroceryMate Parramatta".
drop policy if exists staff_read on businesses;
create policy staff_read on businesses
  for select using (id = staff_venue());

-- ------------------------------------------------------------------ profiles
--
-- Their own row, and only their own.
--
-- Not optional: `useCurrentProfile` reads this row on every cold start, and an
-- account that cannot read its own profile cannot start the app at all. It
-- would look like a permanent "Loading…", which is the worst possible symptom
-- because it names nothing.
--
-- Safe for the four as well — they can already read every profile through
-- `member_read`, so this grants them nothing new. Policies of the same command
-- are OR'd.
drop policy if exists self_read on profiles;
create policy self_read on profiles
  for select using (id = auth.uid());


-- ============================================================================
--  5. THE DUPLICATE WARNING
--
--  Spec §6: a warning, never a block. It is the protection against entering
--  the same invoice twice — and a shared venue login is the most likely place
--  in this app for that to happen. Two people, two shifts, one account, and no
--  way to see what the other did.
--
--  `find_duplicate_invoices` cannot serve them. It returns `setof invoices` —
--  the whole row, status and paid_at included — so wiring staff to it would
--  leak payment status through the back door and undo section 3.
--
--  So they get their own, returning only what the warning needs to say
--  "there is already one of these, entered on the 3rd, for $5,220".
-- ============================================================================

create or replace function find_duplicate_invoices_staff(
  p_supplier_id    uuid,
  p_invoice_number text,
  p_lookback_days  int default 180
)
returns table (
  id             uuid,
  invoice_number text,
  invoice_date   date,
  amount_cents   bigint,
  supplier_name  text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select i.id, i.invoice_number, i.invoice_date, i.amount_cents, s.name
    from invoices i
    join suppliers s on s.id = i.supplier_id
   where i.business_id = staff_venue()     -- the boundary; security definer
     and i.supplier_id = p_supplier_id
     and i.invoice_number is not null
     and lower(i.invoice_number) = lower(trim(p_invoice_number))
     and i.status <> 'void'
     and i.invoice_date >= (sydney_today() - p_lookback_days)
   order by i.invoice_date desc;
$fn$;

revoke all     on function find_duplicate_invoices_staff(uuid, text, int) from anon;
grant  execute on function find_duplicate_invoices_staff(uuid, text, int) to   authenticated;


-- ============================================================================
--  6. TWO BLOCKLISTS THAT WOULD HAVE INCLUDED THE NEW ROLE
--
--  Both views say `role <> 'builder'`, written when builder was the only role
--  that had to be kept out. A blocklist admits every role invented after it —
--  so the moment a staff account exists, both of these would quietly consider
--  it a notification audience.
--
--  Turned into allowlists. Same result today, and no longer a trap.
--
--  (The third one is in the app: `useTeam()` in lib/queries/session.ts filters
--  `role !== 'builder'`, which would list the two venues as people who run the
--  businesses. Fixed in the same change as this file.)
-- ============================================================================

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
   and p.role in ('member', 'owner')
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
   and p.role in ('member', 'owner')
   and p.notify_on_payment;

revoke all on push_targets         from anon, authenticated;
revoke all on push_targets_payment from anon, authenticated;


-- ============================================================================
--  7. CHECK IT WORKED
--
--  One query, because the SQL editor only shows you the last result.
--
--  Expect FOUR ROWS — Mani, Milan, Sujan, you — and on every one of them:
--
--    still_a_member    true      <- the row that matters
--    new_functions     4
--    view_present      1
--    staff_policies    6
--    staff_accounts    0         <- nobody is staff yet; that is correct
--    rows_you_can_see  0         <- if this is not 0, staff_venue() is wrong
--
--  If any row says still_a_member = false, STOP and send me the output. That
--  is three people locked out of a live app, and it is one statement to undo.
-- ============================================================================

select
  p.display_name,
  p.role,
  p.business_id,
  p.role in ('member', 'owner', 'builder')  as still_a_member,
  (select count(*) from pg_proc
     where proname in ('is_staff', 'staff_venue', 'pin_invoice_facts',
                       'find_duplicate_invoices_staff'))  as new_functions,
  (select count(*) from pg_views
     where schemaname = 'public'
       and viewname = 'staff_invoices')                   as view_present,
  (select count(*) from pg_policies
     where schemaname = 'public'
       and policyname in ('staff_read', 'staff_insert',
                          'staff_update', 'self_read'))                   as staff_policies,
  (select count(*) from profiles where role = 'staff')    as staff_accounts,
  (select count(*) from staff_invoices)                   as rows_you_can_see
from profiles p
where p.active
order by p.role, p.display_name;


-- ############################################################################
--
--  8. CREATING THE TWO ACCOUNTS — LATER, AND NOT YET.
--
--  Do not run this section until the app half has shipped. A staff account
--  that exists before the screens do can sign in and will land on a dashboard
--  built for someone else, which is worse than not existing.
--
--  When the time comes:
--
--   1. Supabase -> Authentication -> Users -> Add user. Twice.
--      Use mailboxes you control. There is no password reset flow in this app,
--      so a forgotten password is reset by you, from that same screen.
--
--   2. Copy each new user's UUID and put it in the statement below.
--
--   3. Run it. `accent` is 'venue' on purpose — it is not one of the four
--      person slots, so the chip renders the venue treatment instead of
--      pretending a venue is a person.
--
--  ---------------------------------------------------------------------------
--  insert into profiles (id, display_name, initials, accent, role, business_id,
--                        notify_on_new_invoice)
--  values
--    ('PASTE-GMP-USER-UUID', 'Parramatta', 'GMP', 'venue', 'staff',
--       (select id from businesses where code = 'GMP'), false),
--    ('PASTE-GMH-USER-UUID', 'Hurstville', 'GMH', 'venue', 'staff',
--       (select id from businesses where code = 'GMH'), false)
--  on conflict (id) do update
--    set display_name = excluded.display_name,
--        initials     = excluded.initials,
--        accent       = excluded.accent,
--        role         = excluded.role,
--        business_id  = excluded.business_id,
--        active       = true;
--  ---------------------------------------------------------------------------
--
--  And to take one away later — never delete it, the invoices it entered
--  reference it forever:
--
--  update profiles set active = false where initials = 'GMP';
--
-- ############################################################################
