-- ============================================================================
--  PUSH — the trigger that decides who is told, and asks the Edge Function to
--  send it.
--
--  RUN THIS LAST, after the function is deployed and its four secrets are set.
--  Safe to run twice.
--
--  ---------------------------------------------------------------------------
--  BEFORE YOU RUN IT: two values to paste in
--
--  Search this file for PASTE_ and replace both, at the bottom in section 3.
--  Everything else is ready.
--  ---------------------------------------------------------------------------
--
--  ---------------------------------------------------------------------------
--  Why the address and the secret live in a table
--
--  The obvious place is a database setting:
--
--      alter database postgres set app.notify_url = '...';
--
--  On a hosted Supabase project that fails with `42501: permission denied to
--  set parameter`. The SQL editor connects as `postgres`, which is not a
--  superuser there, and altering a database-level parameter needs one. Found
--  the hard way, which is why it is written down here.
--
--  So a table instead, with row level security on and no policy at all. That
--  combination means **nobody** reaches it through the API: not the anon key,
--  not a signed-in person, not by accident. The only things that can read it
--  are the table's owner and a SECURITY DEFINER function owned by that owner,
--  which is exactly what `notify_push()` below is.
--
--  Supabase Vault would encrypt the value at rest and is the tidier answer.
--  This does not use it, deliberately: it is one more extension to depend on,
--  and the thing being stored only lets its holder send a notification. It is
--  not money and it is not data.
--  ---------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- 1. pg_net, for making an HTTP call from a trigger without blocking the write.
--
-- `net.http_post` queues the request and returns immediately. That matters: the
-- insert that fires this must not wait on a push service, or adding an invoice
-- on bad wifi would take as long as the slowest phone's push endpoint.
-- ----------------------------------------------------------------------------
create extension if not exists pg_net with schema extensions;

-- ----------------------------------------------------------------------------
-- 2. Somewhere to keep the address and the secret.
-- ----------------------------------------------------------------------------
create table if not exists app_config (
  key   text primary key,
  value text not null
);

alter table app_config enable row level security;

-- No policy is created on purpose. RLS with no policy denies everything, which
-- is the intent: this table is for the definer function below and nothing else.
drop policy if exists app_config_none on app_config;

revoke all on app_config from anon, authenticated;

-- ----------------------------------------------------------------------------
-- 3. The two values. REPLACE BOTH.
--
--   PASTE_NOTIFY_URL     https://<your-project-ref>.supabase.co/functions/v1/notify-push
--   PASTE_NOTIFY_SECRET  the same string you set as the NOTIFY_SECRET function
--                        secret. If these two disagree, every push is refused
--                        with a 403 and nothing else goes wrong.
-- ----------------------------------------------------------------------------
insert into app_config (key, value) values
  ('notify_url',    'PASTE_NOTIFY_URL'),
  ('notify_secret', 'PASTE_NOTIFY_SECRET')
on conflict (key) do update set value = excluded.value;

-- ----------------------------------------------------------------------------
-- 4. The sender.
--
-- SECURITY DEFINER so it can read the target views and the table above, all of
-- which are revoked from everybody else. `search_path` is pinned for the reason
-- every definer function in this schema pins it: without it, whoever calls this
-- could put their own `push_targets` earlier on the path and choose their own
-- audience.
-- ----------------------------------------------------------------------------
create or replace function notify_push(
  p_audience text,          -- 'new_invoice' or 'payment'
  p_actor     uuid,         -- never told about their own action
  p_title     text,
  p_body      text,
  p_url       text
)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $fn$
declare
  v_targets jsonb;
  v_url     text;
  v_secret  text;
begin
  select value into v_url    from app_config where key = 'notify_url';
  select value into v_secret from app_config where key = 'notify_secret';

  -- Not configured, or still holding the placeholders. Do nothing, quietly: a
  -- half-set-up push must never stop an invoice being saved.
  if v_url is null or v_secret is null or v_url like 'PASTE%' or v_secret like 'PASTE%' then
    return;
  end if;

  -- The audience rule, in one place. `profile_id <> p_actor` is the half that
  -- ARCHITECTURE §16 states as a rule rather than a preference: never tell
  -- somebody about their own action. They know.
  if p_audience = 'payment' then
    select coalesce(jsonb_agg(jsonb_build_object(
             'endpoint', t.endpoint, 'p256dh', t.p256dh, 'auth', t.auth)), '[]'::jsonb)
      into v_targets
      from push_targets_payment t
     where t.profile_id is distinct from p_actor;
  else
    select coalesce(jsonb_agg(jsonb_build_object(
             'endpoint', t.endpoint, 'p256dh', t.p256dh, 'auth', t.auth)), '[]'::jsonb)
      into v_targets
      from push_targets t
     where t.profile_id is distinct from p_actor;
  end if;

  if jsonb_array_length(v_targets) = 0 then
    return;
  end if;

  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-shg-secret', v_secret),
    body    := jsonb_build_object(
                 'title',   p_title,
                 'body',    p_body,
                 'url',     p_url,
                 'tag',     p_audience,
                 'targets', v_targets)
  );
end;
$fn$;

revoke all on function notify_push(text, uuid, text, text, text) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 5. The two events.
--
-- Both read from the row rather than being told what happened, so there is no
-- path where the app forgets to announce something. The audit trigger records
-- these regardless — turning notifications off never turns information off.
-- ----------------------------------------------------------------------------
create or replace function on_invoice_notify()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $fn$
declare
  v_supplier text;
  v_amount   text;
begin
  select name into v_supplier from suppliers where id = new.supplier_id;
  v_amount := to_char(new.amount_cents / 100.0, 'FM999,999,990.00');

  if tg_op = 'INSERT' then
    perform notify_push(
      'new_invoice',
      new.created_by,
      'New invoice',
      coalesce(v_supplier, 'A supplier') || ' — $' || v_amount,
      '/invoices/' || new.id);

  elsif tg_op = 'UPDATE'
        and new.status = 'paid' and old.status is distinct from 'paid' then
    perform notify_push(
      'payment',
      new.paid_by,
      'Invoice paid',
      coalesce(v_supplier, 'A supplier') || ' — $' || v_amount,
      '/invoices/' || new.id);
  end if;

  return null;  -- AFTER trigger; the return value is ignored.
end;
$fn$;

drop trigger if exists invoice_push on invoices;
create trigger invoice_push
  after insert or update of status on invoices
  for each row execute function on_invoice_notify();

-- ----------------------------------------------------------------------------
-- 6. Check it. Expect one row saying invoice_push, and two saying configured.
-- ----------------------------------------------------------------------------
select tgname as trigger_name, tgenabled as enabled
  from pg_trigger where tgname = 'invoice_push';

select key,
       case when value like 'PASTE%' then 'NOT SET — replace it in section 3'
            else 'configured' end as state
  from app_config
 order by key;
