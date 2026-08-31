-- ============================================================================
--  CATCH-UP 006 — who gets told what, once push exists.
--
--  Supabase SQL editor -> New query -> paste -> Run.
--  Safe to run twice. Adds one column and two views; changes no invoice.
--
--  ---------------------------------------------------------------------------
--  What this is for
--
--  Your instruction, in your words:
--
--    "no one except Mani should get notification of bills being paid, even if
--     they enable this option. Although they can check in history and confirm"
--
--  Two events, two different audiences:
--
--    an invoice is ADDED  ->  everyone who asked to be told, minus whoever
--                             added it. It is news to whoever has to pay it.
--    an invoice is PAID   ->  Mani, and nobody else. It is news to whoever is
--                             watching the money, which is one person.
--
--  ---------------------------------------------------------------------------
--  Why this is a column and not a line of code saying "Mani"
--
--  The rule stays general — tell the people marked for this event, never about
--  their own actions — and the fact that exactly one person is marked stays
--  data. If you later want somebody else on it, that is one UPDATE and no
--  deploy, run by you, at the time you decide.
--
--  `notify_on_payment` is deliberately NOT added to the column grant that lets
--  a person edit their own profile. That is what "even if they enable this
--  option" asks for: it is not a preference anybody can turn on for
--  themselves, including Mani. Only you, here, can set it.
--  ============================================================================

-- ----------------------------------------------------------------------------
-- 1. The column.
-- ----------------------------------------------------------------------------
alter table profiles
  add column if not exists notify_on_payment boolean not null default false;

-- ----------------------------------------------------------------------------
-- 2. Mani, and only Mani.
--
-- Matched on display_name because that is what identifies him in this database
-- — the auth uuid differs between environments. This is the one place a name
-- appears, and it is data being set, not behaviour being written: nothing in
-- the app or the function below ever reads a name to decide anything.
-- ----------------------------------------------------------------------------
update profiles set notify_on_payment = true  where display_name = 'Mani';
update profiles set notify_on_payment = false where display_name <> 'Mani';

-- ----------------------------------------------------------------------------
-- 3. Who to send to, per event.
--
-- Two views rather than one with a flag, for the reason ARCHITECTURE §17 gives
-- about the two ledgers: a condition inside a shared answer is how the wrong
-- audience eventually gets one. The Edge Function reads one or the other and
-- has no filtering of its own to get wrong.
--
-- `role <> 'builder'` appears in both. There are no builders yet — it is the
-- mechanism ARCHITECTURE §28.2 chose for keeping Rabindra out of the profile
-- list and out of every notification while he keeps access to maintain the
-- app. Putting it in the view now means that change is one UPDATE later rather
-- than another SQL file for you to run.
-- ----------------------------------------------------------------------------
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
   and p.role <> 'builder'
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
   and p.role <> 'builder'
   and p.notify_on_payment;

-- ----------------------------------------------------------------------------
-- 4. Locks.
--
-- A push endpoint is a capability: anyone holding one can send that device a
-- notification. So they are not shared, even between the four of you — each
-- person can see and change only their own rows, and the views above are read
-- by the Edge Function, which connects as the database owner rather than as
-- any of you.
-- ----------------------------------------------------------------------------
alter table push_subscriptions enable row level security;

drop policy if exists own_subscriptions on push_subscriptions;
create policy own_subscriptions on push_subscriptions
  for all using (profile_id = auth.uid()) with check (profile_id = auth.uid());

revoke all on push_subscriptions from anon;
revoke all on push_targets, push_targets_payment from anon, authenticated;

grant select, insert, update, delete on push_subscriptions to authenticated;

-- ----------------------------------------------------------------------------
-- 5. Check it worked. Expect one row saying Mani, and 0 for everybody else.
-- ----------------------------------------------------------------------------
select display_name, role, notify_on_new_invoice, notify_on_payment
  from profiles
 order by display_name;
