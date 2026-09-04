-- ############################################################################
--
--  DIAGNOSE PUSH — why nothing is arriving.
--
--  Supabase SQL editor -> New query -> paste the whole file -> Run.
--
--  ---------------------------------------------------------------------------
--  THIS FILE CHANGES NOTHING.
--
--  Every statement is a SELECT. It sends no notification, writes no row, and
--  touches no invoice. Run it as many times as you like.
--  ---------------------------------------------------------------------------
--
--  The SQL editor only shows the LAST result, so this is one query with one
--  row and one column per question. Send me that row.
--
--  There are five things that stop a push arriving. Four of them are visible
--  from in here. The fifth is not, and it is the most common:
--
--    *** An iPhone that is still a Safari tab has no Push API at all. ***
--
--  Apple only gives a site push once it has been added to the Home Screen.
--  There is no setting and no workaround. On such a phone, Settings in the app
--  shows a sentence about the Home Screen INSTEAD of a switch — so:
--
--    - if the receiving phone shows a SWITCH, this is not the cause
--    - if it shows the sentence, this IS the cause, and adding the app to the
--      Home Screen and turning the switch on there is the whole fix
--
-- ############################################################################


-- ============================================================================
--  ONE ROW. What each column means, and what a bad answer looks like.
--
--  devices_subscribed      how many phones have actually subscribed.
--                          0 = nobody is subscribed, whatever the switch
--                          appeared to say. Everything else is irrelevant
--                          until this is at least 1.
--
--  who_is_subscribed       the names behind that count. If your own phone is
--                          not in here, the switch did not take.
--
--  wants_new_invoice       how many people would be told about a new invoice.
--                          0 with devices_subscribed > 0 means the person-level
--                          switch in Settings is off for everybody.
--
--  url_state               'configured' or 'NOT SET'. NOT SET means section 3
--                          of db/push/notify_trigger.sql was never filled in
--                          and every push has been quietly skipped since.
--
--  secret_state            same, for the shared secret.
--
--  trigger_state           'on' | 'DISABLED' | 'MISSING'. Missing means the
--                          trigger was dropped; disabled means somebody turned
--                          it off.
--
--  send_attempts_24h       how many times the database has tried to send in
--                          the last day. 0 with a healthy trigger means the
--                          trigger never fired -- no invoice was added, or it
--                          was added by the only person subscribed (nobody is
--                          ever told about their own action).
--
--  last_status             the HTTP code the Edge Function last replied with.
--                            200  sent -- the failure is past this point,
--                                 which means the phone, not the database
--                            403  the secret in app_config does not match the
--                                 NOTIFY_SECRET set on the function
--                            404  the url in app_config is wrong
--                            5xx  the function itself errored -- its logs are
--                                 in Supabase -> Edge Functions -> notify-push
--                            null nothing has been attempted; see above
--
--  last_attempt_at         when. If this is weeks old, sending stopped then.
-- ============================================================================

select
  (select count(*) from push_subscriptions)                     as devices_subscribed,

  (select coalesce(string_agg(distinct p.display_name, ', '), '(none)')
     from push_subscriptions s
     join profiles p on p.id = s.profile_id)                    as who_is_subscribed,

  (select count(*) from push_targets)                           as wants_new_invoice,
  (select count(*) from push_targets_payment)                   as wants_payment,

  (select case when value like 'PASTE%' then 'NOT SET' else 'configured' end
     from app_config where key = 'notify_url')                  as url_state,

  (select case when value like 'PASTE%' then 'NOT SET' else 'configured' end
     from app_config where key = 'notify_secret')               as secret_state,

  (select case
            when count(*) = 0            then 'MISSING'
            when max(tgenabled) = 'D'    then 'DISABLED'
            else 'on'
          end
     from pg_trigger where tgname = 'invoice_push')             as trigger_state,

  (select count(*) from net._http_response
    where created > now() - interval '24 hours')                as send_attempts_24h,

  (select status_code from net._http_response
    order by created desc limit 1)                              as last_status,

  (select created from net._http_response
    order by created desc limit 1)                              as last_attempt_at;


-- ############################################################################
--
--  IF last_status IS 403 OR 404, THE FIX IS TWO LINES.
--
--  Both values live in `app_config`, and both were pasted in by hand once.
--  Nothing else in the app reads them, so correcting them is safe and takes
--  effect on the next invoice -- no deploy, no restart.
--
--    404 -- the url. It must be exactly:
--           https://<project-ref>.supabase.co/functions/v1/notify-push
--
--      update app_config set value = 'https://....../functions/v1/notify-push'
--       where key = 'notify_url';
--
--    403 -- the secret. It must match the NOTIFY_SECRET set on the function
--           (Supabase -> Edge Functions -> notify-push -> Secrets). Set both
--           sides to the same long random string:
--
--      update app_config set value = '<the same string>'
--       where key = 'notify_secret';
--
--  Do not run either of these until the diagnosis above says which one it is.
--
-- ############################################################################
