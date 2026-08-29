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
