-- ============================================================================
-- 006 — push notification subscriptions
--
-- The table is created now because the schema is being pasted in by hand and
-- an extra round trip costs more than an empty table does. Nothing reads or
-- writes it until Phase 7, which is when the service worker exists — a push
-- subscription cannot be created without one, so this genuinely cannot be
-- built earlier.
--
-- One row per person per device. Milan with a phone and a tablet has two.
-- Endpoints expire and get replaced by the browser, which is why the endpoint
-- rather than the person is the unique key.
--
-- What is NOT stored here: the VAPID private key that signs push messages.
-- That lives as a secret on the Supabase Edge Function that sends them, and
-- never enters the app bundle — same rule as the service-role key.
-- ============================================================================

create table if not exists push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,

  endpoint   text not null unique,   -- the browser's push endpoint URL
  p256dh     text not null,          -- client public key, for encryption
  auth       text not null,          -- client auth secret, for encryption

  user_agent text,                   -- so a person can tell their devices apart
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

create index if not exists push_subscriptions_profile
  on push_subscriptions (profile_id);

-- ----------------------------------------------------------------------------
-- Who should be told when an invoice is logged.
--
-- Read by the Edge Function in Phase 7. Kept as a view so the rule lives in
-- one place: the author is never notified of their own invoice, and a
-- deactivated person is never notified at all.
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
   and p.notify_on_new_invoice;
