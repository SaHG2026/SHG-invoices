-- ############################################################################
--
--  CHECK WHAT ACTUALLY LANDED
--
--  Supabase SQL editor -> New query -> paste all of this -> Run.
--  Send me the whole result table.
--
--  The first line tells Supabase's API layer to re-read the database. If a
--  table exists but the API says it doesn't, that single line fixes it.
--
--  Everything after it is one query returning one table, so nothing gets
--  hidden by the editor only showing the last result.
--
-- ############################################################################

notify pgrst, 'reload schema';

select kind, name, detail from (

  -- Tables, and whether row level security is switched on for each.
  select 1 as ord, 'table' as kind, c.relname::text as name,
         case when c.relrowsecurity then 'RLS on' else 'RLS OFF  <-- problem' end as detail
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'

  union all

  select 2, 'view', c.relname::text, ''
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'v'

  union all

  -- Our functions. security definer vs invoker matters: definer bypasses RLS,
  -- so only the audit trigger, the ref generator and is_member should say so.
  select 3, 'function', p.proname::text,
         case when p.prosecdef then 'security definer' else 'security invoker' end
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('sydney_today','set_internal_ref','current_actor_id',
                       'touch_updated_at','log_invoice_activity','is_member',
                       'mark_invoices_paid','unmark_invoice_paid','void_invoice',
                       'find_duplicate_invoices')

  union all

  select 4, 'policy', (tablename || '.' || policyname)::text, cmd::text
    from pg_policies where schemaname = 'public'

  union all

  select 5, 'trigger', (c.relname || '.' || t.tgname)::text, ''
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and not t.tgisinternal

  union all

  -- The seed. Four people, four businesses.
  select 6, 'person', display_name::text,
         (role || ' · ' || initials || ' · ' || accent ||
          ' · notify=' || notify_on_new_invoice::text ||
          ' · active=' || active::text)::text
    from profiles

  union all

  select 7, 'business', name::text, code::text
    from businesses

  union all

  -- Column-level grant: only notify_on_new_invoice should be updatable.
  select 8, 'grant', ('profiles.' || column_name)::text, privilege_type::text
    from information_schema.column_privileges
   where table_schema = 'public' and table_name = 'profiles'
     and grantee = 'authenticated' and privilege_type = 'UPDATE'

) x
order by ord, name;
