-- ############################################################################
--
--  CATCH-UP 015 — Deli Delights issues an invoice it can print.
--
--  Supabase SQL editor -> New query -> paste the whole file -> Run.
--  Safe to run twice.
--
--  ---------------------------------------------------------------------------
--  WHAT THIS DOES NOT TOUCH
--
--  Nothing about supplier invoices. Not the `invoices` table, not a policy on
--  it, not a total anywhere. This is the OTHER ledger — §17's second one, the
--  one that already holds customers and sales invoices — and the guarantee
--  that has held since it was created still holds: nothing in here can reach
--  what the group owes, because every owed figure is computed from `invoices`
--  and none of this is `invoices`.
--  ---------------------------------------------------------------------------
--
--  Your words: "We add/select a supplier. We add list of products (will be
--  added with prices, also an option to add/edit those). Then all the added
--  products will show an invoice. Then there is an option to export, that
--  exported will be printed."
--
--  One correction to the vocabulary, because it decides which table this lands
--  in: on this flow Deli is SELLING, so the other party is a customer and the
--  record is a `sales_invoice`. Both already exist.
--
--  Two decisions you took, recorded here so nobody re-derives them:
--
--    * a PLAIN invoice, no GST, no tax line, no ABN requirement. There is no
--      tax column below, deliberately — if Deli ever registers, this comment
--      is the place to come back to, and it is a schema change and not an edit.
--    * the APP numbers them, sequentially, per business: DDL-0001.
--
-- ############################################################################


-- ============================================================================
--  1. PRODUCTS
--
--  What Deli sells, and what it costs. Scoped to a business rather than
--  global: the price of a thing is a fact about who is selling it.
-- ============================================================================

create table if not exists products (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid   not null references businesses(id),
  name             text   not null check (length(trim(name)) > 0),
  unit             text,                                  -- 'kg', 'each', 'box'
  unit_price_cents bigint not null check (unit_price_cents >= 0),

  active           boolean not null default true,
  created_by       uuid   not null references profiles(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Zero is allowed on purpose: a sample, a replacement, a line that carries a
-- description and no charge. `invoices.amount_cents` has `> 0` because an
-- invoice for nothing is a mistake; a LINE for nothing is a real thing.

-- One name per business, among the active ones. Mirrors `suppliers_name_ci`,
-- including the `where active` — so a name can be reused after a product is
-- removed, which is the whole reason removing is deactivating.
create unique index if not exists products_name_ci
  on products (business_id, lower(name)) where active;

create index if not exists products_business on products (business_id) where active;

drop trigger if exists products_touch_updated_at on products;
create trigger products_touch_updated_at
  before update on products
  for each row execute function touch_updated_at();


-- ============================================================================
--  2. LINES
--
--  ---------------------------------------------------------------------------
--  THE DESCRIPTION AND THE PRICE ARE COPIED ONTO THE LINE. THIS IS THE POINT.
--
--  The obvious schema is `product_id` plus a quantity, and it is wrong for a
--  document. Raise a product's price next month and every invoice printed last
--  month silently reprints at the new one — a piece of paper you handed
--  somebody would stop agreeing with your copy of it.
--
--  A printed invoice is a claim about a moment. So the line carries what was
--  charged, and `product_id` is kept only to answer "which product was this",
--  nullable, for the one-off line that is not a product at all.
--  ---------------------------------------------------------------------------
--
--  QUANTITY IS INTEGER THOUSANDTHS, for the reason rule 6 makes money integer
--  cents: 1.1 * 3 is 3.3000000000000003, and a line on a customer's invoice
--  cannot fail to add up. 1.5 kg is 1500. `lib/quantity.ts` is the only thing
--  that parses or formats it.
-- ============================================================================

create table if not exists sales_invoice_lines (
  id               uuid primary key default gen_random_uuid(),
  sales_invoice_id uuid not null references sales_invoices(id) on delete cascade,

  -- Order on the page. Unique per invoice so two lines cannot claim one slot
  -- and leave the document's order down to whatever the planner returns.
  position         int  not null check (position >= 0),

  -- Which product, or null for a one-off line. Nullable on purpose, and it is
  -- NOT what the document reads.
  product_id       uuid references products(id),

  -- What the document reads. Both copied at the moment of issue.
  description      text   not null check (length(trim(description)) > 0),
  unit             text,
  quantity_milli   bigint not null check (quantity_milli > 0),
  unit_price_cents bigint not null check (unit_price_cents >= 0),
  line_total_cents bigint not null check (line_total_cents >= 0)
);

create unique index if not exists sales_lines_position
  on sales_invoice_lines (sales_invoice_id, position);

create index if not exists sales_lines_invoice
  on sales_invoice_lines (sales_invoice_id, position);


-- ============================================================================
--  3. NUMBERING
--
--  DDL-0001, and the app decides it.
--
--  The same race-free mechanism `set_internal_ref` has used since migration
--  002, and for the same reason: `select max()` then insert loses the race,
--  and two people composing at once must never produce one number twice. An
--  upsert against a counter table is resolved in ONE statement under
--  Postgres' own row lock.
--
--  Different from the internal ref in one way that matters: this counter is
--  per business and NOT per day. An invoice number a customer will quote back
--  at you should count upward forever, not restart every morning.
-- ============================================================================

create table if not exists sales_invoice_counters (
  business_id uuid not null references businesses(id),
  n           int  not null,
  primary key (business_id)
);

create or replace function set_sales_invoice_number()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_code text;
  v_n    int;
begin
  -- Only when the app did not supply one. A number typed by hand stays.
  if new.invoice_number is not null and trim(new.invoice_number) <> '' then
    return new;
  end if;

  insert into sales_invoice_counters (business_id, n)
  values (new.business_id, 1)
  on conflict (business_id)
    do update set n = sales_invoice_counters.n + 1
  returning n into v_n;

  select code into v_code from businesses where id = new.business_id;

  new.invoice_number := coalesce(v_code, 'INV') || '-' || lpad(v_n::text, 4, '0');
  return new;
end;
$fn$;

drop trigger if exists sales_set_number on sales_invoices;
create trigger sales_set_number
  before insert on sales_invoices
  for each row execute function set_sales_invoice_number();

-- The backstop, exactly as `invoices_internal_ref_unique` is for the other
-- side: if the generator is ever wrong, the insert fails loudly instead of
-- quietly producing two invoices claiming to be the same one.
create unique index if not exists sales_invoice_number_unique
  on sales_invoices (business_id, invoice_number) where invoice_number is not null;


-- ============================================================================
--  4. ONE WRITE, ONE TRANSACTION
--
--  ---------------------------------------------------------------------------
--  THE TOTAL IS COMPUTED HERE AND THE CLIENT'S IS IGNORED.
--
--  A header and its lines that disagree is a document that lies about itself,
--  and it would be handed to a customer. So `amount_cents` is the sum of the
--  lines, computed in this function, and what the app sent is not consulted
--  when there are lines to sum.
--
--  When there are NO lines the app's amount is used — that is the existing
--  "record an invoice we already sent" path, which has worked since
--  migration 009 and is not being taken away.
--
--  That is one branch, in one place, and it is the whole of the difference
--  between the two shapes. Notes §1.3 is about what happens when there are two
--  functions instead: "two paths that built a record, one of them wrong, and
--  it looked like it saved."
--  ---------------------------------------------------------------------------
--
--  THE ARITHMETIC HAS A TWIN in `lib/quantity.ts`, and §6 below proves they
--  agree rather than asserting it.
--
--  Idempotent on the client-generated id, like every other write in this app
--  (notes §1.5): a replay from the offline queue returns the existing row
--  instead of invoicing a customer twice.
-- ============================================================================

create or replace function create_sales_invoice(
  p_invoice jsonb,
  p_lines   jsonb default '[]'::jsonb
)
returns sales_invoices
language plpgsql
security invoker                 -- RLS and auth.uid() both still apply
set search_path = public, pg_temp
as $fn$
declare
  v_id      uuid := (p_invoice ->> 'id')::uuid;
  v_line    jsonb;
  v_total   bigint := 0;
  v_pos     int := 0;
  v_row     sales_invoices;
  v_qty     bigint;
  v_price   bigint;
  v_line_total bigint;
begin
  -- Already there: a replayed write. Hand back what exists and change nothing.
  select * into v_row from sales_invoices where id = v_id;
  if found then
    return v_row;
  end if;

  -- The lines first, so the header can be inserted with a total that is
  -- already true rather than updated into truth a moment later.
  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_qty   := (v_line ->> 'quantity_milli')::bigint;
    v_price := (v_line ->> 'unit_price_cents')::bigint;

    -- The twin of `lineTotalCents`. `numeric` is exact decimal, and `round`
    -- goes half away from zero, which matches Math.round on the positive
    -- values either side is ever given.
    v_line_total := round(v_qty::numeric * v_price / 1000);
    v_total := v_total + v_line_total;
  end loop;

  insert into sales_invoices (
    id, business_id, customer_id, invoice_number,
    invoice_date, due_date, amount_cents, note, created_by
  )
  values (
    v_id,
    (p_invoice ->> 'business_id')::uuid,
    (p_invoice ->> 'customer_id')::uuid,
    nullif(trim(coalesce(p_invoice ->> 'invoice_number', '')), ''),
    (p_invoice ->> 'invoice_date')::date,
    (p_invoice ->> 'due_date')::date,
    -- Lines win. No lines, and the app's amount is used.
    case when jsonb_array_length(p_lines) > 0
         then v_total
         else (p_invoice ->> 'amount_cents')::bigint end,
    nullif(trim(coalesce(p_invoice ->> 'note', '')), ''),
    (p_invoice ->> 'created_by')::uuid
  )
  returning * into v_row;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_qty   := (v_line ->> 'quantity_milli')::bigint;
    v_price := (v_line ->> 'unit_price_cents')::bigint;

    insert into sales_invoice_lines (
      sales_invoice_id, position, product_id,
      description, unit, quantity_milli, unit_price_cents, line_total_cents
    )
    values (
      v_row.id,
      v_pos,
      nullif(v_line ->> 'product_id', '')::uuid,
      v_line ->> 'description',
      nullif(trim(coalesce(v_line ->> 'unit', '')), ''),
      v_qty,
      v_price,
      round(v_qty::numeric * v_price / 1000)
    );
    v_pos := v_pos + 1;
  end loop;

  return v_row;
end;
$fn$;

revoke all     on function create_sales_invoice(jsonb, jsonb) from anon;
grant  execute on function create_sales_invoice(jsonb, jsonb) to   authenticated;


-- ============================================================================
--  5. RLS
--
--  Migration 007's reasoning, unchanged and restated: this is not separating
--  the four of you, it is making sure anybody who is NOT one of you gets
--  nothing. `is_member()` has excluded venue staff since CATCH_UP_010 §2, so
--  writing it the same way as every other policy is what keeps the shops out
--  of Deli's price list without a word about them here.
-- ============================================================================

alter table products             enable row level security;
alter table sales_invoice_lines  enable row level security;
alter table sales_invoice_counters enable row level security;

drop policy if exists member_all on products;
create policy member_all on products
  for all using (is_member()) with check (is_member());

drop policy if exists member_all on sales_invoice_lines;
create policy member_all on sales_invoice_lines
  for all using (is_member()) with check (is_member());

-- The counter gets RLS with NO policy, which denies everybody through the API.
-- The only thing that reads it is the SECURITY DEFINER trigger above — the
-- same arrangement `app_config` uses, and for the same reason: a counter
-- anybody can write is a counter that can be made to repeat itself.
revoke all on sales_invoice_counters from anon, authenticated;
revoke all on products            from anon;
revoke all on sales_invoice_lines from anon;


-- ============================================================================
--  6. CHECK IT WORKED — including that the arithmetic matches the app
--
--  The first query is the schema. The second is the table from
--  `test/unit/quantity.test.ts`, run through Postgres' own arithmetic: every
--  row must say `true`. If one says false, `lineTotalCents` and this file
--  disagree about money and the document would not add up.
-- ============================================================================

select
  (select count(*) from information_schema.tables
     where table_schema = 'public'
       and table_name in ('products', 'sales_invoice_lines',
                          'sales_invoice_counters'))              as tables_present,
  (select count(*) from pg_proc
     where proname in ('create_sales_invoice',
                       'set_sales_invoice_number'))               as functions,
  (select count(*) from pg_trigger where tgname = 'sales_set_number') as number_trigger,
  (select count(*) from pg_policies
     where tablename in ('products', 'sales_invoice_lines'))      as policies,
  (select count(*) from information_schema.columns
     where table_name = 'sales_invoices' and column_name = 'note') as note_column_from_013,
  (select count(*) from products)                                  as products_so_far;

-- Expect ten rows, every `agrees` true.
with agreement(quantity_milli, unit_price_cents, expected_cents) as (
  values (1000::bigint,     1000::bigint, 1000::bigint),   -- 1    x $10.00
         (12000::bigint,     250::bigint, 3000::bigint),   -- 12   x  $2.50
         (1500::bigint,      400::bigint,  600::bigint),   -- 1.5  x  $4.00
         (250::bigint,      1200::bigint,  300::bigint),   -- 0.25 x $12.00
         (2125::bigint,      800::bigint, 1700::bigint),   -- 2.125 x $8.00
         (3000::bigint,       99::bigint,  297::bigint),   -- 3    x  $0.99
         (1500::bigint,        1::bigint,    2::bigint),   -- rounds up
         (500::bigint,         1::bigint,    1::bigint),   -- half, away from zero
         (400::bigint,         1::bigint,    0::bigint),   -- rounds down
         (7777::bigint,      111::bigint,  863::bigint)    -- 863.2..., down
)
select quantity_milli,
       unit_price_cents,
       expected_cents,
       round(quantity_milli::numeric * unit_price_cents / 1000) as postgres_says,
       round(quantity_milli::numeric * unit_price_cents / 1000) = expected_cents as agrees
  from agreement;


-- ############################################################################
--
--  7. AFTERWARDS — nothing to run by hand.
--
--  Products are added from `/products` in the app. The first invoice numbers
--  itself DDL-0001.
--
--  If Deli has been issuing invoices on paper and you want the app's numbering
--  to carry on from where that left off, set the counter once — say the last
--  one you sent was 118:
--
--    insert into sales_invoice_counters (business_id, n)
--    select id, 118 from businesses where code = 'DDL'
--    on conflict (business_id) do update set n = excluded.n;
--
--  The next invoice is then DDL-0119.
--
-- ############################################################################
