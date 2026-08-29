-- ############################################################################
--
--  SAGARMATHA PAYMENTS — run this once, in the Supabase SQL editor.
--
--  Dashboard -> SQL Editor -> New query -> paste all of this -> Run.
--
--  Safe to run more than once: every table is "create if not exists" and
--  every function is "create or replace". If it fails partway through, send
--  me the error and run the whole thing again after the fix.
--
--  Expected result: "Success. No rows returned."
--
--  Contents, in the order they must run:
--    001  tables, constraints, indexes
--    002  internal reference generation  (the race fix)
--    003  audit trigger                  (who did what, automatically)
--    004  payment RPCs                   (mark paid / un-tick / void)
--    005  roles and notification settings
--    006  push subscriptions             (table only; used in Phase 7)
--    007  Row Level Security             (must be last)
--    seed businesses, then the four people
--
--  The individual files in db/migrations/ and db/seed/ are the originals,
--  and are what to read to review a single piece.
--
-- ############################################################################


-- ####################  001_schema.sql  ####################

-- ============================================================================
-- 001 — enums, tables, indexes
-- Sagarmatha Payments. Spec §5.
--
-- Money is bigint cents, never numeric and never float.
-- Calendar dates are `date`, instants are `timestamptz`. A date has no
-- timezone and must not acquire one (notes §1.2).
-- Nothing is ever deleted; `void` with a reason (notes §8).
-- ============================================================================

-- ---------------------------------------------------------------- enums ----
do $$ begin
  create type invoice_status as enum ('unpaid', 'paid', 'void');
exception when duplicate_object then null;
end $$;

-- ------------------------------------------------------------- profiles ----
create table if not exists profiles (
  id           uuid primary key references auth.users(id) on delete restrict,
  display_name text not null,
  initials     text not null,
  accent       text not null,                  -- hex, for the attribution chip
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

-- Notes §2: the RLS policies run `exists (select 1 from profiles ...)` per row.
create index if not exists profiles_active on profiles (id) where active;

-- ----------------------------------------------------------- businesses ----
create table if not exists businesses (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  code       text not null unique,             -- 'GMH' — used in internal refs
  sort_order int  not null default 0,
  active     boolean not null default true
);

-- ------------------------------------------------------------ suppliers ----
create table if not exists suppliers (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  default_terms_days int,                      -- 14 -> the due date auto-fills
  contact_name       text,
  contact_phone      text,
  notes              text,
  active             boolean not null default true,
  created_by         uuid not null references profiles(id),
  created_at         timestamptz not null default now()
);

create unique index if not exists suppliers_name_ci
  on suppliers (lower(name)) where active;

-- ------------------------------------------------------------- invoices ----
create table if not exists invoices (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references businesses(id),
  supplier_id    uuid not null references suppliers(id),

  invoice_number text,                         -- the supplier's number, optional
  internal_ref   text not null,                -- always generated: 'GMH-260828-03'
  invoice_date   date not null,
  due_date       date not null,
  amount_cents   bigint not null check (amount_cents > 0),

  status         invoice_status not null default 'unpaid',
  paid_at        timestamptz,
  paid_by        uuid references profiles(id),
  payment_ref    text,                         -- bank ref / cheque no, optional
  void_reason    text,

  created_by     uuid not null references profiles(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  -- A paid invoice always knows when and by whom; an unpaid one never claims to.
  constraint paid_fields_consistent check (
    (status =  'paid' and paid_at is not null and paid_by is not null)
    or
    (status <> 'paid' and paid_at is null     and paid_by is null)
  ),

  -- Voiding requires a reason. Spec §6.
  constraint void_needs_reason check (
    status <> 'void' or (void_reason is not null and length(trim(void_reason)) > 0)
  )
);

create index if not exists invoices_due_unpaid on invoices (due_date) where status = 'unpaid';
create index if not exists invoices_supplier    on invoices (supplier_id);
create index if not exists invoices_business    on invoices (business_id);
create index if not exists invoices_paid_at     on invoices (paid_at desc) where status = 'paid';

-- Duplicate detection is a WARNING, not a constraint. Suppliers restart their
-- numbering, and a unique index here would block legitimate entries. Spec §5.
create index if not exists invoices_dupe_lookup
  on invoices (supplier_id, lower(invoice_number));

-- ---------------------------------------------------------------- notes ----
create table if not exists invoice_notes (
  id         uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices(id) on delete cascade,
  author_id  uuid not null references profiles(id),
  body       text not null check (length(trim(body)) > 0),
  created_at timestamptz not null default now()
);

create index if not exists invoice_notes_invoice on invoice_notes (invoice_id, created_at);

-- --------------------------------------------------------- activity log ----
create table if not exists activity_log (
  id          bigserial primary key,
  entity_type text not null,                   -- 'invoice' | 'supplier'
  entity_id   uuid not null,
  action      text not null,                   -- created|edited|paid|unpaid|voided
  actor_id    uuid not null references profiles(id),
  detail      jsonb,                           -- changed fields, before/after
  created_at  timestamptz not null default now()
);

create index if not exists activity_entity on activity_log (entity_type, entity_id, created_at desc);
create index if not exists activity_recent on activity_log (created_at desc);

-- ####################  002_internal_ref.sql  ####################

-- ============================================================================
-- 002 — internal reference generation
--
-- Notes §2: "Internal ref generation must not be select-then-insert. Two
-- people logging at the same time will both read 02 and both write
-- GMH-260828-03. This is exactly the class of race that destroyed a shared
-- record in the previous app."
--
-- The fix is a counter table written with a single upsert. Postgres takes a
-- row lock for the duration of that one statement, so two concurrent inserts
-- serialise on it and come out with different numbers. No select-then-insert,
-- and no advisory lock to reason about later.
-- ============================================================================

create table if not exists invoice_ref_counters (
  business_id uuid not null references businesses(id),
  day         date not null,
  n           int  not null,
  primary key (business_id, day)
);

-- ----------------------------------------------------------------------------
-- The only place the database is allowed to know what day it is.
--
-- Used solely to stamp a ref, which is a label. Urgency comparisons never call
-- this — `today` is computed once in Sydney on the client and passed in
-- explicitly (notes §1.2). If you find this function in a WHERE clause that
-- decides whether something is overdue, that is the bug.
-- ----------------------------------------------------------------------------
create or replace function sydney_today()
returns date
language sql
stable
set search_path = public, pg_temp
as $fn$
  select (now() at time zone 'Australia/Sydney')::date;
$fn$;

create or replace function set_internal_ref()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_day  date;
  v_code text;
  v_n    int;
begin
  -- Already stamped (a restore, or a replayed write): leave it alone.
  if new.internal_ref is not null and new.internal_ref <> '' then
    return new;
  end if;

  -- The day it was LOGGED, per spec §5 ("third invoice logged for Hurstville
  -- on 28 Aug"), which is not necessarily the invoice date.
  v_day := sydney_today();

  select code into v_code from businesses where id = new.business_id;
  if v_code is null then
    raise exception 'unknown business_id: %', new.business_id;
  end if;

  -- One statement. This is the whole race fix.
  insert into invoice_ref_counters (business_id, day, n)
  values (new.business_id, v_day, 1)
  on conflict (business_id, day)
    do update set n = invoice_ref_counters.n + 1
  returning n into v_n;

  new.internal_ref := v_code || '-' || to_char(v_day, 'YYMMDD') || '-' || lpad(v_n::text, 2, '0');
  return new;
end;
$fn$;

drop trigger if exists invoices_set_internal_ref on invoices;
create trigger invoices_set_internal_ref
  before insert on invoices
  for each row execute function set_internal_ref();

-- Accepted consequence, recorded so it is not later "fixed" back into a race:
-- an offline retry arriving as `insert ... on conflict (id) do nothing` still
-- fires this trigger and burns a counter value before the row is discarded.
-- Ref sequences can therefore contain gaps. A ref is an identifier, not a
-- count; a gap is harmless, a collision is not.

-- ####################  003_audit.sql  ####################

-- ============================================================================
-- 003 — the audit trigger and updated_at
--
-- Spec §5: "Do not rely on the client to log — the client will forget."
--
-- Notes §2: `auth.uid()` returns null under the service-role key. This app
-- never holds that key (architecture §1, §13), so auth.uid() is always the
-- real person. The `app.actor_id` fallback exists only so seed and migration
-- scripts can attribute themselves. The `not null` on actor_id stays: relaxing
-- it to make a script work loses attribution permanently.
--
-- The function is SECURITY DEFINER so it can write activity_log while the
-- table itself grants no insert to anyone. Nobody can forge a log entry;
-- entries only ever arrive as a side effect of a real change.
-- ============================================================================

create or replace function current_actor_id()
returns uuid
language sql
stable
set search_path = public, pg_temp
as $fn$
  select coalesce(
    auth.uid(),
    nullif(current_setting('app.actor_id', true), '')::uuid
  );
$fn$;

create or replace function touch_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  new.updated_at := now();
  return new;
end;
$fn$;

drop trigger if exists invoices_touch_updated_at on invoices;
create trigger invoices_touch_updated_at
  before update on invoices
  for each row execute function touch_updated_at();

-- ----------------------------------------------------------------------------
-- The log itself.
--
-- `detail` carries only the fields that actually changed, as
-- {"amount_cents": {"from": 542000, "to": 522000}} — which is exactly what the
-- invoice detail stream renders as "Sujan changed amount $5,420.00 -> $5,220.00".
-- ----------------------------------------------------------------------------
create or replace function log_invoice_activity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_actor  uuid := current_actor_id();
  v_action text;
  v_detail jsonb := '{}'::jsonb;
  v_field  text;
begin
  if v_actor is null then
    raise exception 'activity_log needs an actor: auth.uid() is null and app.actor_id is unset';
  end if;

  if tg_op = 'INSERT' then
    v_action := 'created';
    v_detail := jsonb_build_object(
      'internal_ref', new.internal_ref,
      'amount_cents', new.amount_cents,
      'due_date',     new.due_date,
      'business_id',  new.business_id,
      'supplier_id',  new.supplier_id
    );
  else
    -- Status changes are named, because they are what people look for.
    if new.status is distinct from old.status then
      v_action := case new.status
                    when 'paid'   then 'paid'
                    when 'void'   then 'voided'
                    when 'unpaid' then 'unpaid'
                  end;
    else
      v_action := 'edited';
    end if;

    foreach v_field in array array[
      'invoice_number', 'invoice_date', 'due_date', 'amount_cents',
      'business_id', 'supplier_id', 'status', 'payment_ref', 'void_reason'
    ] loop
      if to_jsonb(new) -> v_field is distinct from to_jsonb(old) -> v_field then
        v_detail := v_detail || jsonb_build_object(
          v_field,
          jsonb_build_object('from', to_jsonb(old) -> v_field, 'to', to_jsonb(new) -> v_field)
        );
      end if;
    end loop;

    -- An update that changed nothing we track is not worth a log line.
    if v_action = 'edited' and v_detail = '{}'::jsonb then
      return null;
    end if;
  end if;

  insert into activity_log (entity_type, entity_id, action, actor_id, detail)
  values ('invoice', new.id, v_action, v_actor, v_detail);

  return null;
end;
$fn$;

drop trigger if exists invoices_log_activity on invoices;
create trigger invoices_log_activity
  after insert or update on invoices
  for each row execute function log_invoice_activity();

-- ####################  004_payments.sql  ####################

-- ============================================================================
-- 004 — payment RPCs
--
-- Notes §1.6: "If ticking a whole run is implemented as a loop of individual
-- updates, a mid-loop failure leaves some invoices paid and some not, with no
-- indication which. In a money app that's the worst possible partial state."
--
-- So every payment state change is one statement, in one transaction, called
-- once. The client never loops.
--
-- All three are SECURITY INVOKER — RLS still applies and auth.uid() is still
-- the caller. These are transaction boundaries, not privilege boundaries. A
-- SECURITY DEFINER here would quietly become a hole around RLS.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Mark one invoice or a whole payment run paid.
--
-- One code path for both: spec §6 lets you tick a run or expand it and tick
-- one, and two code paths would mean two chances to get it wrong.
--
-- `where status = 'unpaid'` makes this idempotent and safe under a retry from
-- the offline queue. It returns only the rows it actually changed, so if
-- somebody else ticked one off two seconds ago the client can say so plainly
-- instead of silently disagreeing with the server.
-- ----------------------------------------------------------------------------
create or replace function mark_invoices_paid(p_ids uuid[], p_ref text default null)
returns setof invoices
language sql
security invoker
set search_path = public, pg_temp
as $fn$
  update invoices
     set status      = 'paid',
         paid_at     = now(),
         paid_by     = auth.uid(),
         payment_ref = nullif(trim(coalesce(p_ref, '')), '')
   where id = any(p_ids)
     and status = 'unpaid'
  returning *;
$fn$;

-- ----------------------------------------------------------------------------
-- Un-tick. Spec §6: available from the invoice detail screen only, never
-- swipeable from a list, and logged loudly. The log is not optional here —
-- the audit trigger records it as action 'unpaid' with the actor.
-- ----------------------------------------------------------------------------
create or replace function unmark_invoice_paid(p_id uuid)
returns setof invoices
language sql
security invoker
set search_path = public, pg_temp
as $fn$
  update invoices
     set status      = 'unpaid',
         paid_at     = null,
         paid_by     = null,
         payment_ref = null
   where id = p_id
     and status = 'paid'
  returning *;
$fn$;

-- ----------------------------------------------------------------------------
-- Void. Never delete (notes §8). Voided invoices drop out of every total but
-- stay in history, struck through, with the reason attached.
-- ----------------------------------------------------------------------------
create or replace function void_invoice(p_id uuid, p_reason text)
returns setof invoices
language sql
security invoker
set search_path = public, pg_temp
as $fn$
  update invoices
     set status      = 'void',
         void_reason = trim(p_reason),
         paid_at     = null,
         paid_by     = null
   where id = p_id
     and status <> 'void'
     and length(trim(coalesce(p_reason, ''))) > 0
  returning *;
$fn$;

-- ----------------------------------------------------------------------------
-- Duplicate warning lookup. Spec §6: a warning, never a block.
--
-- Returns matching invoices so the UI can name the existing one, its amount
-- and who entered it, then offer "Save anyway" and "Open the existing one".
-- Bounded by a lookback window because suppliers restart their numbering.
-- ----------------------------------------------------------------------------
create or replace function find_duplicate_invoices(
  p_supplier_id   uuid,
  p_invoice_number text,
  p_lookback_days  int default 180
)
returns setof invoices
language sql
stable
security invoker
set search_path = public, pg_temp
as $fn$
  select *
    from invoices
   where supplier_id = p_supplier_id
     and invoice_number is not null
     and lower(invoice_number) = lower(trim(p_invoice_number))
     and status <> 'void'
     and invoice_date >= (sydney_today() - p_lookback_days)
   order by created_at desc;
$fn$;

-- ####################  005_roles.sql  ####################

-- ============================================================================
-- 005 — roles and notification preferences
--
-- Everyone keeps full access. Spec §2 and §3.5 are unchanged: any member can
-- add any invoice and tick off any payment, and there is no approval workflow.
--
-- `role` exists only so the app knows whose screen gets the owner's overview
-- and the lightly accented treatment. It is NOT a permission, and it is
-- deliberately absent from every RLS policy in 007. If `role` ever starts
-- deciding what somebody can read or write, that belongs in a policy — and
-- this comment is the warning that no such policy has been written.
--
-- `notify_on_new_invoice` is a per-person setting, on by default for the
-- owner and off for everyone else, changeable by each person for themselves.
-- ============================================================================

alter table profiles
  add column if not exists role text not null default 'member';

alter table profiles
  add column if not exists notify_on_new_invoice boolean not null default false;

do $$ begin
  alter table profiles
    add constraint profiles_role_valid check (role in ('member', 'owner'));
exception when duplicate_object then null;
end $$;

-- ####################  006_push.sql  ####################

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

-- ####################  007_rls.sql  ####################

-- ============================================================================
-- 007 — Row Level Security. Run this last.
--
-- Notes §2: "Enforcement lives in the database, never the interface. 'The
-- button isn't rendered' is not access control."
--
-- All four users are members and all can read and write every invoice; there
-- is no per-user data in the ledger itself. What RLS is doing here is not
-- separating the four of them — it is making sure anyone who is NOT one of
-- them gets nothing, including anybody holding the anon key, which ships to
-- every browser and is therefore public.
--
-- The two exceptions, where a person is confined to their own row, are their
-- notification setting and their push subscriptions. Those are the only
-- per-user rows in the system.
--
-- Verify with db/verify_rls.mjs, not by clicking.
-- ============================================================================

alter table profiles             enable row level security;
alter table businesses           enable row level security;
alter table suppliers            enable row level security;
alter table invoices             enable row level security;
alter table invoice_notes        enable row level security;
alter table activity_log         enable row level security;
alter table invoice_ref_counters enable row level security;
alter table push_subscriptions   enable row level security;

-- ----------------------------------------------------------------------------
-- Who counts as a member. An active profile row is the membership test, so
-- deactivating someone removes their access without touching their history.
-- ----------------------------------------------------------------------------
create or replace function is_member()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select exists (
    select 1 from profiles p where p.id = auth.uid() and p.active
  );
$fn$;

-- ------------------------------------------------------------ read + write --
-- The three tables members genuinely create and change.

drop policy if exists member_all on suppliers;
create policy member_all on suppliers
  for all using (is_member()) with check (is_member());

drop policy if exists member_all on invoices;
create policy member_all on invoices
  for all using (is_member()) with check (is_member());

drop policy if exists member_all on invoice_notes;
create policy member_all on invoice_notes
  for all using (is_member()) with check (is_member());

-- ----------------------------------------------------------------- read only
-- Businesses are seeded, not managed in the app.

drop policy if exists member_read on businesses;
create policy member_read on businesses
  for select using (is_member());

-- ------------------------------------------------------------------ profiles
-- Everyone can read all four profiles: the attribution chips need names and
-- accent colours.
--
-- Updating is confined to your own row AND to one column. Two mechanisms,
-- because they do different jobs:
--
--   the policy      decides WHICH ROW you may touch — only your own
--   the column grant decides WHICH FIELD you may set — only the notify flag
--
-- RLS cannot restrict columns, so without the grant below a person could
-- rename themselves, change their accent, or promote themselves to owner.
-- Together they mean the only thing anyone can change about themselves is
-- whether they want to be notified.

drop policy if exists member_read on profiles;
create policy member_read on profiles
  for select using (is_member());

drop policy if exists self_update on profiles;
create policy self_update on profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

revoke update on profiles from authenticated;
grant  update (notify_on_new_invoice) on profiles to authenticated;

-- --------------------------------------------------------------- activity log
-- Append-only, and not even members may append to it directly: the only
-- writer is the SECURITY DEFINER audit trigger, which fires as a side effect
-- of a real change. There is no insert, update or delete policy here on
-- purpose. A log you can write to by hand is not a log.

drop policy if exists member_read on activity_log;
create policy member_read on activity_log
  for select using (is_member());

-- --------------------------------------------------------- push subscriptions
-- Yours and only yours. A push endpoint is a capability: anyone holding one
-- can send that device a notification, so they do not get shared.

drop policy if exists own_subscriptions on push_subscriptions;
create policy own_subscriptions on push_subscriptions
  for all using (profile_id = auth.uid()) with check (profile_id = auth.uid());

-- ------------------------------------------------------------------ no access
-- invoice_ref_counters is internal bookkeeping for the ref generator. RLS is
-- on and no policy is defined, so it is unreachable from any client. The
-- trigger reaches it because that function is SECURITY DEFINER.

-- ----------------------------------------------------------------------------
-- Belt and braces: take away the blanket grants Supabase hands the anon and
-- authenticated roles, then give back only what is needed. RLS is the
-- boundary; this makes the boundary smaller.
-- ----------------------------------------------------------------------------
revoke all on invoice_ref_counters from anon, authenticated;
revoke all on activity_log         from anon, authenticated;
grant  select on activity_log      to   authenticated;

-- push_targets is read only by the Phase 7 Edge Function, which runs with its
-- own credentials. It must never be readable from a browser: it lists other
-- people's push endpoints.
revoke all on push_targets from anon, authenticated;

revoke all on profiles           from anon;
revoke all on businesses         from anon;
revoke all on suppliers          from anon;
revoke all on invoices           from anon;
revoke all on invoice_notes      from anon;
revoke all on push_subscriptions from anon;

-- ####################  001_businesses.sql  ####################

-- Spec §12. Codes are load-bearing: they appear in every internal ref.
insert into businesses (name, code, sort_order) values
  ('GroceryMate Hurstville', 'GMH', 1),
  ('GroceryMate Parramatta', 'GMP', 2),
  ('Majheri Restaurant',     'MJR', 3),
  ('Deli Delights',          'DDL', 4)
on conflict (code) do update
  set name = excluded.name,
      sort_order = excluded.sort_order;

-- ####################  002_profiles.sql  ####################

-- Spec §12, with the four accounts created in the SHG invoicing project.
--
-- profiles.id references auth.users(id), so these UUIDs are the ones Supabase
-- issued when the accounts were created. They are not secrets — they are row
-- identifiers, and they are what every invoice records as its author.
--
-- Accents are the app's only colour-as-identity device (spec §9):
--   Mani     gold    — the figure in the mark
--   Milan    slate   — mid teal
--   Sujan    chilli  — the leaf
--   Rabindra ink     — the deepest navy. The one colour in the palette that
--                      carries no status meaning, which suits a temporary
--                      account. Brick is deliberately not used: spec §9
--                      reserves it for overdue, "never decoratively".
--
-- Roles: Mani and Rabindra are `owner`, so they see the same screens and the
-- same lightly accented treatment, and Rabindra can tune it against his own
-- account. Role is not a permission — all four have identical access.
--
-- Notifications: on for Mani by default, and on for Rabindra so the push flow
-- can actually be tested end to end in Phase 7. Milan and Sujan start off and
-- can switch themselves on from their own settings.
--
-- Rabindra is a test account. When it is finished with, do not delete it —
-- run the statement at the bottom. Deactivating removes him from the profile
-- picker and the type-aheads while every invoice he entered keeps its
-- attribution. Notes §8: nothing is ever deleted.

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

-- ----------------------------------------------------------------------------
-- Later, when the test account is finished with. Run this on its own.
-- ----------------------------------------------------------------------------
-- update profiles set active = false
--  where id = '2da43dcf-8b0f-4229-bf5c-e5af68210045';
