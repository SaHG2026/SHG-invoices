-- ############################################################################
--
--  CATCH-UP 001 — adds only what is missing.
--
--  Supabase SQL editor -> New query -> paste all of this -> Run.
--
--  Everything you already ran stays exactly as it is. This does not drop,
--  recreate or reseed anything that is working. Every statement is written so
--  that running it twice is harmless.
--
--  What it adds:
--    1. profiles.notify_on_new_invoice     — the per-person notification setting
--    2. push_subscriptions + push_targets  — empty until Phase 7
--    3. the two locks that let a person change their own setting and nothing
--       else about themselves
--    4. re-seeds the four people, to set the notification defaults
--
--  Expected result: "Success. No rows returned."
--
-- ############################################################################


-- ============================================================================
-- 1. The notification setting
-- ============================================================================

alter table profiles
  add column if not exists notify_on_new_invoice boolean not null default false;


-- ============================================================================
-- 2. Push subscriptions. Created now because pasting SQL by hand costs more
--    than an empty table does. Nothing reads or writes it until Phase 7 —
--    a push subscription needs a service worker, which Phase 7 installs, so
--    this genuinely cannot be built earlier.
--
--    One row per person per device. Endpoints expire and get replaced by the
--    browser, which is why the endpoint rather than the person is unique.
--
--    What is NOT stored here: the key that signs push messages. That lives as
--    a secret on the Edge Function that sends them, and never enters the app.
-- ============================================================================

create table if not exists push_subscriptions (
  id           uuid primary key default gen_random_uuid(),
  profile_id   uuid not null references profiles(id) on delete cascade,

  endpoint     text not null unique,
  p256dh       text not null,
  auth         text not null,

  user_agent   text,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);

create index if not exists push_subscriptions_profile
  on push_subscriptions (profile_id);

-- Who should be told when an invoice is logged. Kept as a view so the rule
-- lives in one place: nobody deactivated, nobody who did not ask for it.
create or replace view push_targets as
  select
    s.id as subscription_id,
    s.profile_id,
    s.endpoint,
    s.p256dh,
    s.auth,
    p.display_name
  from push_subscriptions s
  join profiles p on p.id = s.profile_id
 where p.active
   and p.notify_on_new_invoice;


-- ============================================================================
-- 3. Security for the two new things, and for the setting.
--
--    A push endpoint is a capability: anyone holding one can send that device
--    a notification. So they are not shared, even between the four of you.
-- ============================================================================

alter table push_subscriptions enable row level security;

drop policy if exists own_subscriptions on push_subscriptions;
create policy own_subscriptions on push_subscriptions
  for all using (profile_id = auth.uid()) with check (profile_id = auth.uid());

-- Letting someone change their own notification setting means letting them
-- update their own profile row. Left there, Sujan could rename himself, change
-- his colour, or make himself an owner. Two locks, doing different jobs:
--
--   the policy       decides WHICH ROW you may touch  — only your own
--   the column grant decides WHICH FIELD you may set  — only the notify flag
--
-- Row level security cannot restrict columns, which is why it takes both.

drop policy if exists self_update on profiles;
create policy self_update on profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

revoke update on profiles from authenticated;
grant  update (notify_on_new_invoice) on profiles to authenticated;

-- push_targets lists other people's push endpoints. It must never be readable
-- from a browser; only the Phase 7 Edge Function reads it.
revoke all on push_targets       from anon, authenticated;
revoke all on push_subscriptions from anon;


-- ============================================================================
-- 4. Re-seed the four people, to set the notification defaults.
--    This is an upsert — it updates the rows already there rather than adding
--    duplicates, and it does not touch any invoice.
-- ============================================================================

insert into profiles (id, display_name, initials, accent, role, notify_on_new_invoice) values
  ('b3153037-4bf5-4baa-8c11-b94e690c92bd', 'Mani',     'MA', '#C9A227', 'owner',  true),
  ('a207c7b2-5389-445a-a46e-bb3dd7b2caad', 'Milan',    'MI', '#2E7C93', 'member', false),
  ('f57715ab-a468-4d2a-9796-0c639a2d259b', 'Sujan',    'SU', '#4F8F2E', 'member', false),
  ('2da43dcf-8b0f-4229-bf5c-e5af68210045', 'Rabindra', 'RA', '#12384B', 'owner',  true)
on conflict (id) do update
  set display_name          = excluded.display_name,
      initials              = excluded.initials,
      accent                = excluded.accent,
      role                  = excluded.role,
      notify_on_new_invoice = excluded.notify_on_new_invoice,
      active                = true;


-- ============================================================================
-- 5. Tell Supabase's API layer to re-read the database, so the new table
--    becomes visible to the app straight away rather than whenever the cache
--    next happens to refresh.
-- ============================================================================

notify pgrst, 'reload schema';
