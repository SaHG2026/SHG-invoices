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

  -- Pad to two digits, but never truncate.
  --
  -- lpad(n, 2, '0') alone is wrong: PostgreSQL's lpad truncates when the
  -- string is already longer than the target, so the 100th invoice of the day
  -- would be handed '10' — the reference belonging to the 10th. Everything
  -- below 100 is correct, which is what makes that the dangerous kind of bug.
  new.internal_ref := v_code || '-' || to_char(v_day, 'YYMMDD') || '-' ||
    case when v_n < 100 then lpad(v_n::text, 2, '0') else v_n::text end;

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
