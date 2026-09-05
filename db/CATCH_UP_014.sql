-- ############################################################################
--
--  CATCH-UP 014 — a reminder at a time you choose.
--
--  Supabase SQL editor -> New query -> paste the whole file -> Run.
--  Safe to run twice.
--
--  RUN CATCH_UP_013 FIRST. This does not depend on it, but running them out of
--  order means two unapplied files in flight and no way to tell which one a
--  symptom belongs to.
--
--  ---------------------------------------------------------------------------
--  BEFORE YOU RUN IT: one switch to flip
--
--  Supabase dashboard -> Database -> Extensions -> search `pg_cron` -> enable.
--
--  Section 5 below fails without it, and it fails at the END of the file, so
--  everything above will already have applied. That is deliberate: the columns
--  and the function are useful on their own and re-running after enabling the
--  extension costs nothing.
--  ---------------------------------------------------------------------------
--
--  Your words: "I would love to have an option to send the managements an
--  alert at a time of their choosing, as a reminder to check today's
--  invoices."
--
--  ---------------------------------------------------------------------------
--  SAY THE UNCOMFORTABLE PART FIRST
--
--  This will send nothing to anybody until somebody turns push on for their
--  own phone, in Settings. Today exactly one device is subscribed and it is
--  Rabindra's — and the builder is excluded from every notification audience
--  by design (ARCHITECTURE §28.2), so even the per-invoice push has never had
--  anybody to tell.
--
--  A reminder is different in one way that helps: it is addressed to ONE
--  person rather than to an audience, so `notify_push_one` below does reach
--  the builder. But for Mani, Milan and Sujan the switch in Settings is still
--  the thing that has to happen, and the app deliberately never asks (§28.4).
--  Somebody has to tell them it is there.
--  ---------------------------------------------------------------------------
--
-- ############################################################################


-- ============================================================================
--  1. WHEN, AND WHETHER
--
--  Two columns, and they do different jobs.
--
--  `reminder_time` is a preference: null means off, and there is no separate
--  boolean saying so. A time plus an enabled flag is two values describing
--  three states when two are real, and the pair can disagree — "on, at null
--  o'clock" is a state somebody would eventually have to write a branch for.
--
--  `reminder_last_sent_on` is bookkeeping. It is what makes the job below
--  idempotent: the cron runs every ten minutes, and without this a reminder
--  set for 08:00 would arrive six times an hour until midnight.
-- ============================================================================

alter table profiles add column if not exists reminder_time          time;
alter table profiles add column if not exists reminder_last_sent_on  date;

comment on column profiles.reminder_time is
  'Sydney wall-clock time for this person''s daily reminder. Null means off — '
  'there is deliberately no separate on/off flag, because a time and a flag '
  'can disagree.';

-- ----------------------------------------------------------------------------
--  Which field you may set.
--
--  Migration 007 revoked blanket UPDATE on profiles and granted back exactly
--  one column, because RLS decides which ROW you may touch and only a column
--  grant decides which FIELD (ARCHITECTURE §8.1). `reminder_time` joins it:
--  your own reminder is yours to set.
--
--  `reminder_last_sent_on` is deliberately NOT in the grant. It is not a
--  preference, and a person able to clear it could make the job send again.
--
--  Both columns are named in ONE statement, because `grant update (a)` then
--  `grant update (b)` is additive but reading two statements a year apart is
--  how somebody concludes the second replaced the first and "tidies" it.
-- ----------------------------------------------------------------------------
revoke update on profiles from authenticated;
grant  update (notify_on_new_invoice, reminder_time) on profiles to authenticated;


-- ============================================================================
--  2. SENDING TO ONE PERSON
--
--  `notify_push` picks an audience from a view and excludes the actor, which
--  is right for "somebody added an invoice" and wrong for every part of this.
--  A reminder has no actor and exactly one recipient.
--
--  Bending the audience views into that shape would mean a view that is
--  sometimes an audience and sometimes a person. So this reads
--  `push_subscriptions` directly, and per-person targeting is true by
--  construction rather than by a WHERE clause somebody could widen.
-- ============================================================================

create or replace function notify_push_one(
  p_profile_id uuid,
  p_title      text,
  p_body       text,
  p_url        text,
  p_tag        text default 'reminder'
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

  -- Not configured, or still holding the placeholders. Do nothing, quietly.
  if v_url is null or v_secret is null or v_url like 'PASTE%' or v_secret like 'PASTE%' then
    return;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth)), '[]'::jsonb)
    into v_targets
    from push_subscriptions s
   where s.profile_id = p_profile_id;

  if jsonb_array_length(v_targets) = 0 then
    return;
  end if;

  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-shg-secret', v_secret),
    body    := jsonb_build_object(
                 'title', p_title, 'body', p_body, 'url', p_url,
                 'tag', p_tag, 'targets', v_targets));
end;
$fn$;

revoke all on function notify_push_one(uuid, text, text, text, text)
  from public, anon, authenticated;


-- ============================================================================
--  3. THE REMINDER ITSELF
--
--  ---------------------------------------------------------------------------
--  It sends every day, whether or not anything happened.
--
--  A reminder that only appears when there is news is an alert, and an alert
--  is a different thing that you did not ask for. "Nothing logged today" is
--  information: it is how you find out a shop forgot, which is exactly the
--  case a notification about new invoices can never tell you about.
--  ---------------------------------------------------------------------------
--
--  The three figures are the three questions the dashboard answers, in the
--  order they matter at the end of a day: what came in, what is waiting on
--  you, what is already late.
--
--  `sydney_today()` and `now() at time zone 'Australia/Sydney'` are the only
--  two places this file touches a clock, and both are the same anchor the
--  internal-ref trigger has used since migration 002.
-- ============================================================================

create or replace function send_daily_reminders()
returns integer
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $fn$
declare
  v_today   date := sydney_today();
  v_now     time := (now() at time zone 'Australia/Sydney')::time;
  v_person  record;
  v_added   int;
  v_review  int;
  v_overdue int;
  v_body    text;
  v_sent    int := 0;
begin
  -- Counted once, not once per person: these are the same three numbers for
  -- everybody, and four people is four identical scans otherwise.
  select count(*) into v_added
    from invoices
   where (created_at at time zone 'Australia/Sydney')::date = v_today;

  select count(*) into v_review
    from invoices where status = 'unpaid' and approved_at is null;

  select count(*) into v_overdue
    from invoices
   where status = 'unpaid' and approved_at is not null and due_date < v_today;

  v_body :=
      case when v_added = 0 then 'Nothing logged today'
           else v_added || ' logged today' end
    || case when v_review  > 0 then ' · ' || v_review  || ' to review' else '' end
    || case when v_overdue > 0 then ' · ' || v_overdue || ' overdue'   else '' end;

  for v_person in
    select p.id
      from profiles p
     where p.active
       and p.role in ('member', 'owner', 'builder')
       and p.reminder_time is not null
       and p.reminder_time <= v_now
       -- The idempotence. Without it the cron sends this every ten minutes
       -- from the chosen time until midnight.
       and (p.reminder_last_sent_on is null or p.reminder_last_sent_on < v_today)
  loop
    perform notify_push_one(
      v_person.id, 'Today''s invoices', v_body, '/review', 'reminder');

    -- Stamped whether or not a phone was actually reached. A person with no
    -- subscription is not a failure to retry every ten minutes; the reminder
    -- was due, it was attempted, and tomorrow it is due again.
    update profiles
       set reminder_last_sent_on = v_today
     where id = v_person.id;

    v_sent := v_sent + 1;
  end loop;

  return v_sent;
end;
$fn$;

revoke all on function send_daily_reminders() from public, anon, authenticated;


-- ============================================================================
--  4. STAFF DO NOT GET ONE
--
--  The loop above is an allowlist — `role in ('member','owner','builder')` —
--  and it is written that way on purpose, for the reason CATCH_UP_010 §6 gives
--  in full: three blocklists spelled `role <> 'builder'` would each have
--  silently admitted the venue accounts on the day they were created.
--
--  Nobody would have written that bug. It would simply have happened.
--
--  The builder IS included here, and that is not an inconsistency with §28.2.
--  He is out of the two AUDIENCES, which are about being told what other
--  people did. A reminder is a personal alarm somebody set for themselves.
-- ============================================================================


-- ============================================================================
--  5. THE CLOCK
--
--  Every ten minutes rather than every minute: the finest choice the app
--  offers is a minute, and being up to ten minutes late on a reminder to check
--  today's invoices costs nothing that six times the scans would buy back.
--
--  THIS SECTION FAILS IF pg_cron IS NOT ENABLED. Everything above will already
--  have applied — enable it in the dashboard and run the file again.
-- ============================================================================

create extension if not exists pg_cron;

-- Unschedule first so a second run does not leave two jobs sending two copies.
do $do$ begin
  perform cron.unschedule('shg-daily-reminders');
exception when others then null;   -- not scheduled yet, which is fine
end $do$;

select cron.schedule(
  'shg-daily-reminders',
  '*/10 * * * *',
  $job$ select send_daily_reminders(); $job$
);


-- ============================================================================
--  6. CHECK IT WORKED
--
--  Expect:
--
--    reminder_columns    2
--    grantable_columns   2      <- notify_on_new_invoice, reminder_time
--    push_one_function   1
--    reminder_function   1
--    cron_job            1      <- 0 means pg_cron is not enabled; see §5
--    reminders_set       0      <- nobody has chosen a time yet; correct
--    devices_subscribed  ?      <- if this is 1, only Rabindra's phone is on
-- ============================================================================

select
  (select count(*) from information_schema.columns
     where table_name = 'profiles'
       and column_name in ('reminder_time', 'reminder_last_sent_on'))   as reminder_columns,
  (select count(*) from information_schema.column_privileges
     where table_name = 'profiles' and privilege_type = 'UPDATE'
       and grantee = 'authenticated')                                   as grantable_columns,
  (select count(*) from pg_proc where proname = 'notify_push_one')      as push_one_function,
  (select count(*) from pg_proc where proname = 'send_daily_reminders') as reminder_function,
  (select count(*) from cron.job where jobname = 'shg-daily-reminders') as cron_job,
  (select count(*) from profiles where reminder_time is not null)       as reminders_set,
  (select count(*) from push_subscriptions)                             as devices_subscribed;


-- ############################################################################
--
--  7. TESTING IT WITHOUT WAITING FOR TOMORROW
--
--  Set a time, clear the stamp, and call it by hand. It respects everything
--  the cron respects, so if this sends nothing, the cron would have too.
--
--    update profiles
--       set reminder_time = '00:01', reminder_last_sent_on = null
--     where display_name = 'Rabindra';
--
--    select send_daily_reminders();      -- returns how many it sent to
--
--  A return of 1 with no notification on the phone means the push half, not
--  this half: `select status_code, created from net._http_response
--  order by created desc limit 5;` and db/diagnose_push.sql.
--
--  A return of 0 means nobody matched — the time has not passed yet in Sydney,
--  or the stamp is already today.
--
--  TO TURN THE WHOLE THING OFF, later:
--
--    select cron.unschedule('shg-daily-reminders');
--
--  The app carries on exactly as before; the Settings field simply stops
--  producing anything.
--
-- ############################################################################
