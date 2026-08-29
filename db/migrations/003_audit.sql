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
