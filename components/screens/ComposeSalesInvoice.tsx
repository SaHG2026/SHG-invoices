'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { AppChrome } from '@/components/app/AppChrome';
import { useToast } from '@/components/ui/Toast';
import { useSydneyToday } from '@/hooks/use-sydney-today';
import { useCurrentProfile } from '@/lib/queries/session';
import { useBusinesses } from '@/lib/queries/reference';
import { useCustomers } from '@/lib/queries/customers';
import { useProducts, useCreateProduct, useUpdateProduct } from '@/lib/queries/products';
import { useCreateSalesInvoice, type NewSalesLine } from '@/lib/queries/sales';
import { submitWrite, writeFailureMessage } from '@/lib/offline/submit';
import { addDays, formatDay, isDateStr, type DateStr } from '@/lib/date';
import { centsToInputValue, formatCents, parseAmountToCents } from '@/lib/money';
import {
  formatQuantity,
  lineTotalCents,
  parseQuantityToMilli,
  sumLineTotals,
} from '@/lib/quantity';
import { DEFAULT_TERMS_DAYS, DUE_PRESETS_DAYS } from '@/lib/constants';
import type { Product } from '@/lib/types';

/**
 * Build an invoice Deli will print and hand over.
 *
 * The client's flow, in order: *"We add/select a supplier. We add list of
 * products. Then all the added products will show an invoice. Then there is an
 * option to export, that exported will be printed."*
 *
 * ---------------------------------------------------------------------------
 * A screen, not a sheet, and that is the one structural decision here.
 *
 * `AddInvoiceSheet` is a sheet because it is one record entered in fifteen
 * seconds with a keyboard up. This is the opposite job: several lines, each
 * with three fields, checked against a docket, with a total that has to be
 * read before anybody commits. A sheet would put that behind a keyboard on a
 * 360px phone and the running total — the thing being watched — would be the
 * first casualty.
 * ---------------------------------------------------------------------------
 *
 * ===========================================================================
 * The price list is the screen. Round E.
 *
 * The first version of this screen asked you to add an empty row, then pick a
 * product into it from a dropdown, then type a quantity — three taps and a
 * scroll per item, and the dropdown hid the list of what Deli actually sells
 * behind a native picker. The report was that it did not work, which is the
 * right verdict on an interface where the thing you came to do is not on
 * screen when you arrive.
 *
 * So the price list itself is the body of the screen: every product, one row
 * each, with a stepper. **Quantity is the only state a row has** — a product
 * with a quantity is on the invoice, a product on zero is not. There is no
 * second "added" flag that could disagree with it, which is the shape lesson
 * from HANDOFF §8: make the broken state unrepresentable rather than keeping
 * the two in step.
 *
 * A pencil on each row opens the two edits somebody actually wants mid-docket
 * — the price *on this invoice*, and the price *in the list* — and they are
 * labelled separately because they are different acts with different reach.
 * ===========================================================================
 *
 * The running total is `useMemo` over the same array the lines render, which
 * is rule 4 in the place it matters most: this figure is going on a piece of
 * paper. And the database recomputes it from the lines it is sent and ignores
 * what this screen said (CATCH_UP_015 §4) — so the number on the document is
 * the sum of the document, not a claim about it.
 */

/** One line as it is being edited, before anything is parsed. */
interface DraftLine {
  key: string;
  productId: string | null;
  description: string;
  unit: string;
  /** What was typed. Parsed at the edge, once, like every amount in this app. */
  quantity: string;
  price: string;
}

function emptyLine(): DraftLine {
  return { key: crypto.randomUUID(), productId: null, description: '', unit: '', quantity: '1', price: '' };
}

/** A product's line, ready to price. Quantity starts at one of it. */
function lineForProduct(product: Product): DraftLine {
  return {
    key: crypto.randomUUID(),
    productId: product.id,
    description: product.name,
    unit: product.unit ?? '',
    quantity: '1',
    // Copied, not linked. The line keeps this price forever; changing the
    // product later never reaches an invoice already issued.
    price: centsToInputValue(product.unit_price_cents),
  };
}

/**
 * Step a typed quantity up or down by whole units.
 *
 * Works in thousandths and formats back out, rather than on the string, so
 * "1.5" plus one is "2.5" and never 1.5000000000000002 — the reason
 * `lib/quantity.ts` exists at all. Unparseable text steps from zero, which is
 * the only answer that cannot make the total wrong.
 */
function step(quantity: string, by: number): string {
  const current = parseQuantityToMilli(quantity) ?? 0;
  const next = current + by * 1000;
  return next <= 0 ? '0' : formatQuantity(next);
}

/**
 * Whether what was typed means "none of this".
 *
 * `parseQuantityToMilli` answers null for BOTH "0" and "1." — a settled zero
 * and somebody halfway through typing 1.5 — and those must be treated
 * oppositely: one takes the row off the invoice, the other must leave it
 * exactly where it is. Nothing downstream can tell them apart, so they are
 * separated here, once.
 */
function meansNone(quantity: string): boolean {
  const cleaned = quantity.trim().replace(/[\s ,]/g, '');
  return cleaned === '' || /^0*(?:\.0*)?$/.test(cleaned);
}

export function ComposeSalesInvoice({
  businessCode = 'DDL',
  customerId: initialCustomerId = '',
}: {
  businessCode?: string;
  /** Pre-chosen when you arrived from a customer's page. */
  customerId?: string;
}) {
  const toast = useToast();
  const router = useRouter();
  const today = useSydneyToday();
  const { data: profile } = useCurrentProfile();
  const { data: businesses = [] } = useBusinesses();
  const { data: customers = [] } = useCustomers();
  const createInvoice = useCreateSalesInvoice();
  const createProduct = useCreateProduct();
  const updateProduct = useUpdateProduct();

  const business = businesses.find(
    (entry) => entry.code.toLowerCase() === businessCode.toLowerCase(),
  );
  const { data: products = [], isLoading: productsLoading } = useProducts(business?.id ?? null);

  const [customerId, setCustomerId] = useState(initialCustomerId);
  /*
   * `DateStr | null`, not `string`, and that type is the whole fix.
   *
   * See the note above `issuedOn`. A date input hands back '' when it is
   * cleared, and '' reached `addDays`, which threw and took the screen with
   * it. Typing these as nullable makes TypeScript refuse every unguarded call
   * -- the branch cannot be forgotten because it cannot compile.
   */
  const [invoiceDate, setInvoiceDate] = useState<DateStr | null>(null);
  const [dueDate, setDueDate] = useState<DateStr | null>(null);
  /*
   * Off by default, and that default is the point.
   *
   * The client: *"we don't want to issue due dates yet."* Deli is invoicing
   * before it has agreed terms with anybody, so an invented due date would
   * print a deadline nobody set AND make the invoice go overdue on a day that
   * means nothing -- which reaches "Owes us", the past-due figure and the
   * chasing. Recorded as an absence rather than hidden (CATCH_UP_017).
   */
  const [dueDateOn, setDueDateOn] = useState(false);
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  /** Which product row has its pencil open. One at a time, like the price list. */
  const [editingProductId, setEditingProductId] = useState<string | null>(null);
  const [addingProduct, setAddingProduct] = useState(false);

  /*
   * ==========================================================================
   * NULL until the effect runs, and that is not a formality.
   *
   * `useSydneyToday` returns null on the FIRST render by design -- the server
   * cannot know what day it is where the phone is standing, so the date
   * arrives one frame later. This screen used to fold that into `|| ''` and
   * then hand the empty string to `addDays`, which asserts 'YYYY-MM-DD' and
   * throws. The whole screen died on arrival, every time, before a pixel of
   * it was painted: "This screen didn't load".
   *
   * The entire test suite mocked `useSydneyToday` to return a real date, so
   * the first render every phone actually performed was the one state no test
   * could reach. `test/unit/sales-invoice.test.tsx` now renders it.
   *
   * Kept as `DateStr | null` rather than guarded at each call, because there
   * were three calls and the next person adds a fourth. Null is what it is,
   * the type says so, and `tsc` refuses to let it reach `addDays`.
   * ==========================================================================
   */
  const issuedOn: DateStr | null = invoiceDate ?? today;
  /*
   * The switch decides whether there IS one; the field decides what it is.
   * Off is null all the way through to the row, so nothing downstream has to
   * ask whether a stored date was meant.
   */
  const dueOn: DateStr | null = !dueDateOn
    ? null
    : (dueDate ?? (issuedOn === null ? null : addDays(issuedOn, DEFAULT_TERMS_DAYS)));

  /**
   * Every line that is complete enough to charge for, and what it comes to.
   *
   * Incomplete lines are skipped rather than treated as zero: a half-typed row
   * at the bottom is somebody still working, not a line worth nothing, and
   * counting it would make the total flicker downward as they type.
   */
  const priced = useMemo(
    () =>
      lines.map((line) => {
        const quantityMilli = parseQuantityToMilli(line.quantity);
        /*
         * A BLANK price is not a price of zero.
         *
         * Blank means somebody is still typing, and a line still being typed
         * must not join the total — it would make the figure flicker downward
         * as they work. A typed 0 is different and is allowed: a sample, a
         * replacement, a line that carries a description and no charge.
         */
        const unitPriceCents =
          line.price.trim() === '' ? null : parseAmountToCents(line.price, { allowZero: true });
        const complete =
          line.description.trim() !== '' && quantityMilli !== null && unitPriceCents !== null;

        return {
          line,
          quantityMilli,
          unitPriceCents,
          complete,
          line_total_cents:
            complete && quantityMilli !== null && unitPriceCents !== null
              ? (lineTotalCents(quantityMilli, unitPriceCents) ?? 0)
              : 0,
        };
      }),
    [lines],
  );

  const chargeable = priced.filter((entry) => entry.complete);
  const total = sumLineTotals(chargeable);

  /**
   * The lines that are not a product — the "anything else" section.
   *
   * Derived from the one array rather than kept in a second one, so a free
   * line and a product line can never disagree about what is on the invoice.
   * The index here is what numbers them on screen and in their labels.
   */
  const freeLines = priced.filter((entry) => entry.line.productId === null);

  /** What the price list shows, filtered. Removed products are not choices. */
  const visibleProducts = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle
      ? products.filter((product) => product.name.toLowerCase().includes(needle))
      : products;
  }, [products, query]);

  function update(key: string, changes: Partial<DraftLine>) {
    setLines((current) =>
      current.map((line) => (line.key === key ? { ...line, ...changes } : line)),
    );
  }

  /** The line this product is on, or null when it is not on the invoice. */
  function lineOf(productId: string): DraftLine | null {
    return lines.find((line) => line.productId === productId) ?? null;
  }

  /**
   * Move a product's quantity. The one control on the row, and the only place
   * "is this on the invoice" is decided.
   *
   * Stepping up from nothing creates the line; stepping down to zero removes
   * it. There is deliberately no third state — a line sitting at zero would
   * print as a row charging nothing.
   */
  function setQuantity(product: Product, quantity: string) {
    const milli = parseQuantityToMilli(quantity);

    setLines((current) => {
      const existing = current.find((line) => line.productId === product.id);

      if (meansNone(quantity)) {
        return current.filter((line) => line.productId !== product.id);
      }

      if (milli === null) {
        // Mid-typing ("1." on the way to "1.5"). Keep the text, keep the row.
        // Nothing is charged for it meanwhile: `priced` skips it as incomplete.
        return existing
          ? current.map((line) =>
              line.productId === product.id ? { ...line, quantity } : line,
            )
          : current;
      }

      return existing
        ? current.map((line) => (line.productId === product.id ? { ...line, quantity } : line))
        : [...current, { ...lineForProduct(product), quantity }];
    });
  }

  /** Save a change to the price list itself. Reaches the next invoice, not this one. */
  async function saveProduct(product: Product, changes: Partial<Product>) {
    try {
      await updateProduct.mutateAsync({ id: product.id, ...changes });
      setEditingProductId(null);
      toast.show(`Saved ${(changes.name ?? product.name).trim()} to the price list.`);
    } catch (caught) {
      toast.show(caught instanceof Error ? caught.message : 'Couldn’t save that.', 'problem');
    }
  }

  /** Add something the price list did not have, and put one of it on the invoice. */
  async function addProduct(name: string, unit: string, price: string) {
    if (!profile || !business) return;

    const trimmed = name.trim();
    const cents = parseAmountToCents(price, { allowZero: true });
    if (trimmed === '') return;
    if (cents === null && price.trim() !== '') {
      toast.show('That price doesn’t look right. Use digits, like 4.50', 'problem');
      return;
    }

    const id = crypto.randomUUID();
    const outcome = await submitWrite(createProduct, {
      id,
      business_id: business.id,
      name: trimmed,
      unit: unit.trim() || null,
      unit_price_cents: cents ?? 0,
      created_by: profile.id,
    });

    if (outcome.kind === 'failed') {
      toast.show(writeFailureMessage(outcome.error, 'Couldn’t add that product.'), 'problem');
      return;
    }

    /*
     * Put it on the invoice from the values typed, not by waiting for the
     * product list to come back. Queued offline it never will, and the point
     * of adding it here was to charge for it now.
     */
    setLines((current) => [
      ...current,
      {
        ...lineForProduct({
          id,
          business_id: business.id,
          name: trimmed,
          unit: unit.trim() || null,
          unit_price_cents: cents ?? 0,
          active: true,
        }),
      },
    ]);
    setAddingProduct(false);
    setQuery('');
    toast.show(
      outcome.kind === 'queued'
        ? `Added ${trimmed} — the price list will catch up when you’re back online.`
        : `Added ${trimmed}.`,
    );
  }

  async function save() {
    setError(null);
    if (!profile || !business) return;

    if (customerId === '') {
      setError('Choose who this invoice is for.');
      return;
    }
    if (chargeable.length === 0) {
      setError('Add at least one line with a description, a quantity and a price.');
      return;
    }
    if (issuedOn === null) {
      // Only reachable by clearing the field outright. An invoice with no date
      // on it is not an invoice. A due date is a different matter — see the
      // switch; null is a legitimate answer there and goes through as null.
      setError('Give it a date.');
      return;
    }

    const payload: NewSalesLine[] = chargeable.map((entry) => ({
      product_id: entry.line.productId,
      description: entry.line.description.trim(),
      unit: entry.line.unit.trim() || null,
      quantity_milli: entry.quantityMilli!,
      unit_price_cents: entry.unitPriceCents!,
    }));

    // Decided here so a replayed offline write is a no-op rather than a second
    // invoice for the same money — notes §1.5, and it matters more on this
    // side: a duplicated receivable is a customer chased twice.
    const id = crypto.randomUUID();

    const outcome = await submitWrite(createInvoice, {
      id,
      business_id: business.id,
      customer_id: customerId,
      // Null: the database numbers it, DDL-0001, race-free (CATCH_UP_015 §3).
      invoice_number: null,
      invoice_date: issuedOn,
      due_date: dueOn,
      // Ignored, because there are lines. Sent because the input requires it
      // and the no-lines path is the same function.
      amount_cents: total,
      note: note.trim() || null,
      created_by: profile.id,
      lines: payload,
    });

    if (outcome.kind === 'failed') {
      toast.show(
        writeFailureMessage(outcome.error, 'Couldn’t save that invoice. Nothing was written.'),
        'problem',
      );
      return;
    }

    if (outcome.kind === 'queued') {
      /*
       * Deliberately does NOT go to the document.
       *
       * The invoice number is stamped by the database, so offline it does not
       * exist yet — the print view would render an invoice with no number on
       * it, which is the one field a customer quotes back at you. Saying so
       * and staying put is the honest version.
       */
      toast.show('Saved — it will send, and be numbered, when you’re back online.', 'queued');
      router.push('/customers' as Route);
      return;
    }

    toast.show(`Invoice ${outcome.data.invoice_number ?? ''} — ${formatCents(total)}`.trim());
    router.push(`/sales/${id}/print` as Route);
  }

  const busy = createInvoice.isPending;
  const field =
    'touch w-full rounded-sm border border-hairline bg-card px-3 text-base text-ink outline-none focus:border-action';

  return (
    <AppChrome back={{ href: '/customers' as Route, label: 'Customers' }} add="none">
      <h1 className="text-h1 mb-3 text-ink">New invoice</h1>

      <label className="mb-4 block">
        <span className="mb-1 block text-xs uppercase tracking-widest text-muted">Customer</span>
        <select
          value={customerId}
          onChange={(event) => setCustomerId(event.target.value)}
          aria-label="Customer"
          className={field}
        >
          <option value="">Choose a customer</option>
          {customers.map((customer) => (
            <option key={customer.id} value={customer.id}>
              {customer.name}
            </option>
          ))}
        </select>
      </label>

      <div className="mb-4 grid grid-cols-2 gap-3">
        <label className="block">
          <span className="mb-1 block text-xs uppercase tracking-widest text-muted">Date</span>
          <input
            type="date"
            aria-label="Invoice date"
            value={issuedOn ?? ''}
            /* Cleared, or half-typed, is null -- never a string nothing can
               parse. Validated at the edge, once, like every other input. */
            onChange={(event) =>
              setInvoiceDate(isDateStr(event.target.value) ? event.target.value : null)
            }
            className={`figure-date ${field}`}
          />
        </label>

        {/*
          The switch sits where the second date used to, so the row still reads
          as "the two things about timing" -- and the field appears underneath
          only once there is a date to put in it. An input that is present but
          meaningless is the state this switch exists to remove.
        */}
        <div className="block">
          <span className="mb-1 block text-xs uppercase tracking-widest text-muted">Due date</span>
          <button
            type="button"
            role="switch"
            aria-checked={dueDateOn}
            aria-label="Give this invoice a due date"
            onClick={() => setDueDateOn((on) => !on)}
            className={`touch flex w-full items-center justify-between gap-2 rounded-sm border px-3 text-sm ${
              dueDateOn ? 'border-action text-ink' : 'border-hairline text-muted'
            }`}
            style={dueDateOn ? { backgroundColor: 'var(--action-bg)' } : undefined}
          >
            <span className="min-w-0 truncate">{dueDateOn ? 'On' : 'None'}</span>
            <span
              aria-hidden
              className="flex h-6 w-10 shrink-0 items-center rounded-full px-0.5"
              style={{
                backgroundColor: dueDateOn ? 'var(--action)' : 'var(--pressed)',
                justifyContent: dueDateOn ? 'flex-end' : 'flex-start',
              }}
            >
              <span
                className="block size-5 rounded-full"
                style={{ backgroundColor: 'var(--card)' }}
              />
            </span>
          </button>
        </div>
      </div>

      {dueDateOn ? (
        <div className="mb-6">
          <label className="mb-1 block">
            <span className="mb-1 block text-xs uppercase tracking-widest text-muted">Due</span>
            <input
              type="date"
              aria-label="Due date"
              value={dueOn ?? ''}
              onChange={(event) =>
                setDueDate(isDateStr(event.target.value) ? event.target.value : null)
              }
              className={`figure-date ${field}`}
            />
          </label>
          <span className="figure-date mb-2 block text-xs text-muted">
            {dueOn ? formatDay(dueOn) : ' '}
          </span>

          <div className="flex gap-1">
            {DUE_PRESETS_DAYS.map((days) => {
              // Computed once, inside the guard, rather than twice outside it.
              const preset = issuedOn === null ? null : addDays(issuedOn, days);
              return (
                <button
                  key={days}
                  type="button"
                  disabled={preset === null}
                  onClick={() => setDueDate(preset)}
                  aria-label={`Due in ${days} days`}
                  className={`touch rounded-full border px-3 text-xs disabled:opacity-40 ${
                    preset !== null && dueOn === preset
                      ? 'border-action bg-action text-action-text'
                      : 'border-hairline bg-card text-muted'
                  }`}
                >
                  {days}d
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <p className="mb-6 text-xs text-muted">
          No due date on this one. It will show as owing, never as overdue.
        </p>
      )}

      {/* ---------------------------------------------------------------- *
        The price list, as the body of the screen.
       * ---------------------------------------------------------------- */}
      <h2 className="text-h2 mb-2 text-ink">Products</h2>

      <div className="mb-2 flex items-center rounded-sm border border-hairline bg-card">
        <span aria-hidden className="pl-3 text-sm text-muted">
          &#9906;
        </span>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find a product"
          aria-label="Search products"
          className="touch min-w-0 flex-1 bg-transparent px-2 text-base text-ink outline-none"
        />
      </div>

      {!business ? (
        <p className="mb-4 rounded-sm border border-edge bg-card p-4 text-sm text-muted">
          No such business, so there is no price list to show.
        </p>
      ) : productsLoading ? (
        <p className="mb-4 text-sm text-muted">Loading the price list…</p>
      ) : visibleProducts.length === 0 ? (
        <p className="mb-3 rounded-sm border border-edge bg-card p-4 text-sm text-muted">
          {query
            ? `No product matches “${query}”. Add it below, or put it on as a one-off line.`
            : 'No products yet. Add the first one below.'}
        </p>
      ) : (
        <ul className="mb-3 overflow-hidden rounded-sm border border-edge bg-card">
          {visibleProducts.map((product) => {
            const line = lineOf(product.id);
            const on = line !== null;
            const priceCents =
              line && line.price.trim() !== ''
                ? parseAmountToCents(line.price, { allowZero: true })
                : product.unit_price_cents;
            const milli = line ? parseQuantityToMilli(line.quantity) : null;

            return (
              <li key={product.id} className="border-b border-hairline last:border-b-0">
                {/*
                  Two lines, not one, and that is a 360px decision.

                  On one line the stepper, the pencil and the cross take 244px
                  of a 375px screen and the NAME gets what is left -- measured
                  at 66px, enough for "Momo (..." and not enough to tell
                  "Sliced Swiss Browns" from "Flat White Mushrooms". A price
                  list you cannot read is not a price list. So the name owns a
                  full-width line and the controls own the one beneath it.
                */}
                <div
                  className="px-3 py-2"
                  style={on ? { backgroundColor: 'var(--action-bg)' } : undefined}
                >
                  <div className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
                      {product.name}
                    </span>
                    {/* The line total, only once there is one. */}
                    {on && milli !== null && priceCents !== null ? (
                      <span className="money shrink-0 text-sm font-medium text-action">
                        {formatCents(lineTotalCents(milli, priceCents) ?? 0)}
                      </span>
                    ) : null}
                  </div>

                  {/*
                    gap-1, not gap-2, and it is load-bearing.

                    `touch` sets a 44px minimum on every control here, so this
                    row spends 224px of a 375px phone before the unit and price
                    get a pixel -- and at gap-2 they got 54px for something
                    needing 58, which truncated "kg $14.50" to "kg $14...".
                    Losing the price off a price list is losing the point of
                    it. The four pixels come out of the gaps, never out of the
                    targets.
                  */}
                  <div className="mt-1 flex items-center gap-1">
                    <span className="min-w-0 flex-1 truncate text-xs text-muted">
                      {product.unit ? product.unit : 'each'}
                      {' · '}
                      <span className="money">{formatCents(priceCents ?? 0)}</span>
                    </span>

                    <button
                      type="button"
                      onClick={() => setQuantity(product, step(line?.quantity ?? '0', -1))}
                      aria-label={`One less ${product.name}`}
                      disabled={!on}
                      className="touch flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-hairline bg-card text-h2 text-ink disabled:opacity-30"
                    >
                      &minus;
                    </button>

                    {/*
                      The figure, and the field. One element, not a label plus
                      a hidden input: a quantity you can read but not correct
                      is what sends somebody back to the top of the screen to
                      start the row again. It is also the only way to enter
                      1.5 kg, which a stepper cannot reach.
                    */}
                    <input
                      value={line?.quantity ?? '0'}
                      inputMode="decimal"
                      onChange={(event) => setQuantity(product, event.target.value)}
                      onFocus={(event) => event.currentTarget.select()}
                      aria-label={`Quantity of ${product.name}`}
                      className={`money touch w-12 shrink-0 rounded-sm border bg-card text-center text-base outline-none focus:border-action ${
                        on ? 'border-hairline font-medium text-ink' : 'border-transparent text-muted'
                      }`}
                      style={{ textAlign: 'center' }}
                    />

                    <button
                      type="button"
                      onClick={() => setQuantity(product, step(line?.quantity ?? '0', 1))}
                      aria-label={`One more ${product.name}`}
                      className="touch flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-hairline bg-card text-h2 text-ink"
                    >
                      +
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        setEditingProductId((current) =>
                          current === product.id ? null : product.id,
                        )
                      }
                      aria-expanded={editingProductId === product.id}
                      aria-label={`Edit ${product.name}`}
                      className="touch flex h-11 w-7 shrink-0 items-center justify-center text-sm text-muted"
                    >
                      &#9998;
                    </button>

                    {/* Only when there is something to take off. A control
                        that does nothing is a control people stop trusting. */}
                    {on ? (
                      <button
                        type="button"
                        onClick={() => setQuantity(product, '')}
                        aria-label={`Take ${product.name} off this invoice`}
                        className="touch flex h-11 w-7 shrink-0 items-center justify-center text-sm text-muted"
                      >
                        &#10005;
                      </button>
                    ) : (
                      <span aria-hidden className="w-7 shrink-0" />
                    )}
                  </div>
                </div>

                {editingProductId === product.id ? (
                  <ProductRowEditor
                    product={product}
                    linePrice={line?.price ?? null}
                    busy={updateProduct.isPending}
                    onLinePrice={(value) => {
                      // Only meaningful once it is on the invoice; putting it
                      // on is the same act as pricing it.
                      if (line) update(line.key, { price: value });
                      else setLines((current) => [...current, { ...lineForProduct(product), price: value }]);
                    }}
                    onSaveToList={(changes) => void saveProduct(product, changes)}
                    onClose={() => setEditingProductId(null)}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {addingProduct ? (
        <NewProductForm
          busy={createProduct.isPending}
          onCancel={() => setAddingProduct(false)}
          onAdd={(name, unit, price) => void addProduct(name, unit, price)}
        />
      ) : (
        <button
          type="button"
          onClick={() => setAddingProduct(true)}
          disabled={!business}
          className="touch mb-6 w-full rounded-sm border border-hairline bg-card text-sm text-action disabled:opacity-40"
        >
          + Add a new product
        </button>
      )}

      {/* ---------------------------------------------------------------- *
        Anything the price list does not have.
       * ---------------------------------------------------------------- */}
      <h2 className="text-h2 mb-1 text-ink">Other lines</h2>
      <p className="mb-2 text-sm text-muted">
        A delivery charge, a one-off, anything not on the price list. Nothing typed here is saved
        to the list.
      </p>

      <ul className="mb-3 flex flex-col gap-2">
        {freeLines.map((entry, index) => (
          <li key={entry.line.key} className="rounded-sm border border-edge bg-card p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-xs uppercase tracking-widest text-muted">
                Line {index + 1}
              </span>
              {freeLines.length > 1 ? (
                <button
                  type="button"
                  onClick={() =>
                    setLines((current) => current.filter((line) => line.key !== entry.line.key))
                  }
                  className="touch px-2 text-sm text-muted"
                >
                  Remove
                </button>
              ) : null}
            </div>

            <input
              aria-label={`Description for line ${index + 1}`}
              value={entry.line.description}
              onChange={(event) => update(entry.line.key, { description: event.target.value })}
              placeholder="Description"
              className={`mb-2 ${field}`}
            />

            <div className="flex items-center gap-2">
              <input
                aria-label={`Quantity for line ${index + 1}`}
                value={entry.line.quantity}
                inputMode="decimal"
                onChange={(event) => update(entry.line.key, { quantity: event.target.value })}
                placeholder="1"
                className="money touch w-16 shrink-0 rounded-sm border border-hairline bg-card px-2 text-base text-ink outline-none focus:border-action"
                style={{ textAlign: 'left' }}
              />
              <input
                aria-label={`Unit for line ${index + 1}`}
                value={entry.line.unit}
                onChange={(event) => update(entry.line.key, { unit: event.target.value })}
                placeholder="kg"
                className="touch w-16 shrink-0 rounded-sm border border-hairline bg-card px-2 text-base text-ink outline-none focus:border-action"
              />
              <span aria-hidden className="shrink-0 text-sm text-muted">
                &times;
              </span>
              <div className="flex min-w-0 flex-1 items-center rounded-sm border border-hairline bg-card">
                <span className="money pl-2 text-base text-muted" style={{ textAlign: 'left' }}>
                  $
                </span>
                <input
                  aria-label={`Price for line ${index + 1}`}
                  value={entry.line.price}
                  inputMode="decimal"
                  onChange={(event) => update(entry.line.key, { price: event.target.value })}
                  placeholder="0.00"
                  className="money touch w-full bg-transparent px-1 text-base text-ink outline-none"
                  style={{ textAlign: 'left' }}
                />
              </div>
              <span className="money w-20 shrink-0 text-right text-sm text-ink">
                {entry.complete ? formatCents(entry.line_total_cents) : '—'}
              </span>
            </div>
          </li>
        ))}
      </ul>

      <button
        type="button"
        onClick={() => setLines((current) => [...current, emptyLine()])}
        className="touch mb-4 w-full rounded-sm border border-hairline bg-card text-sm text-action"
      >
        + Add another line
      </button>

      <label className="mb-4 block">
        <span className="mb-1 block text-xs uppercase tracking-widest text-muted">Note</span>
        <textarea
          rows={2}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Anything to record about this one? Optional."
          className="w-full rounded-sm border border-hairline bg-card px-3 py-2 text-base text-ink outline-none focus:border-action"
        />
      </label>

      {error ? (
        <p
          role="alert"
          className="mb-3 rounded-sm px-3 py-2 text-sm"
          style={{ backgroundColor: 'var(--spine-overdue-bg)', color: 'var(--spine-overdue)' }}
        >
          {error}
        </p>
      ) : null}

      {/*
        The total, and the button, fixed at the bottom.

        Spec §7.4 makes the same argument for the pending list: watching the
        number change is the point of the screen, so it stays on screen while
        you scroll. It is truer here, because this figure is about to be
        printed.
      */}
      <div
        className="fixed inset-x-0 bottom-0 z-30 border-t border-edge bg-card"
        style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
      >
        <div className="mx-auto flex max-w-[560px] items-center gap-3 px-4 py-3">
          <span className="min-w-0 flex-1">
            <span className="block text-xs uppercase tracking-widest text-muted">
              {chargeable.length} line{chargeable.length === 1 ? '' : 's'}
            </span>
            <span className="money block text-h2 text-ink">{formatCents(total)}</span>
          </span>
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy}
            className="touch shrink-0 rounded-full bg-action px-5 text-base font-medium text-action-text disabled:opacity-40"
          >
            {busy ? 'Saving…' : 'Save & print'}
          </button>
        </div>
      </div>

      <div aria-hidden className="h-24" />
    </AppChrome>
  );
}

/**
 * The pencil, open.
 *
 * Two edits, named separately, because they reach different distances. The
 * first changes what this customer is charged on this piece of paper. The
 * second changes what the next invoice suggests, and nothing already issued
 * (CATCH_UP_015 §2). Putting them under one "Save" would make the second one
 * happen by accident, and a price list quietly rewritten by somebody fixing
 * one docket is the kind of thing nobody notices for a month.
 */
function ProductRowEditor({
  product,
  linePrice,
  busy,
  onLinePrice,
  onSaveToList,
  onClose,
}: {
  product: Product;
  linePrice: string | null;
  busy: boolean;
  onLinePrice: (value: string) => void;
  onSaveToList: (changes: Partial<Product>) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(product.name);
  const [unit, setUnit] = useState(product.unit ?? '');
  const [listPrice, setListPrice] = useState(centsToInputValue(product.unit_price_cents));

  const field =
    'touch w-full min-w-0 rounded-sm border border-hairline bg-card px-3 text-base text-ink outline-none focus:border-action';

  const listChanged =
    name.trim() !== product.name ||
    (unit.trim() || null) !== (product.unit ?? null) ||
    parseAmountToCents(listPrice, { allowZero: true }) !== product.unit_price_cents;

  return (
    <div className="border-t border-hairline px-3 py-3">
      <p className="mb-1 text-xs uppercase tracking-widest text-muted">On this invoice</p>
      <div className="mb-4 flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center rounded-sm border border-hairline bg-card">
          <span className="money pl-3 text-base text-muted" style={{ textAlign: 'left' }}>
            $
          </span>
          <input
            value={linePrice ?? centsToInputValue(product.unit_price_cents)}
            inputMode="decimal"
            onChange={(event) => onLinePrice(event.target.value)}
            aria-label={`Price of ${product.name} on this invoice`}
            className="money touch w-full bg-transparent px-2 text-base text-ink outline-none"
            style={{ textAlign: 'left' }}
          />
        </div>
        <span className="shrink-0 text-xs text-muted">per {product.unit || 'each'}</span>
      </div>

      <p className="mb-1 text-xs uppercase tracking-widest text-muted">In the price list</p>
      <div className="mb-2 flex gap-2">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          aria-label={`Name of ${product.name} in the price list`}
          autoCapitalize="words"
          className={`flex-[2] ${field}`}
        />
        <input
          value={unit}
          onChange={(event) => setUnit(event.target.value)}
          placeholder="kg"
          aria-label={`Unit of ${product.name} in the price list`}
          className={`flex-1 ${field}`}
        />
      </div>
      <div className="flex gap-2">
        <div className="flex min-w-0 flex-1 items-center rounded-sm border border-hairline bg-card">
          <span className="money pl-3 text-base text-muted" style={{ textAlign: 'left' }}>
            $
          </span>
          <input
            value={listPrice}
            inputMode="decimal"
            onChange={(event) => setListPrice(event.target.value)}
            aria-label={`Price of ${product.name} in the price list`}
            className="money touch w-full bg-transparent px-2 text-base text-ink outline-none"
            style={{ textAlign: 'left' }}
          />
        </div>
        <button
          type="button"
          disabled={busy || !listChanged || name.trim() === ''}
          onClick={() =>
            onSaveToList({
              name: name.trim(),
              unit: unit.trim() || null,
              unit_price_cents: parseAmountToCents(listPrice, { allowZero: true }) ?? 0,
            })
          }
          className="touch shrink-0 rounded-full bg-action px-4 text-sm text-action-text disabled:opacity-40"
        >
          {busy ? 'Saving…' : 'Save to list'}
        </button>
      </div>

      <button
        type="button"
        onClick={onClose}
        className="touch mt-2 w-full text-sm text-muted"
      >
        Done
      </button>
    </div>
  );
}

/** Add something to the price list without leaving the invoice. */
function NewProductForm({
  busy,
  onAdd,
  onCancel,
}: {
  busy: boolean;
  onAdd: (name: string, unit: string, price: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [unit, setUnit] = useState('');
  const [price, setPrice] = useState('');

  const field =
    'touch min-w-0 rounded-sm border border-hairline bg-card px-3 text-base text-ink outline-none focus:border-action';

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onAdd(name, unit, price);
      }}
      className="mb-6 rounded-sm border border-edge bg-card p-3"
    >
      <p className="mb-2 text-xs uppercase tracking-widest text-muted">New product</p>
      <div className="mb-2 flex gap-2">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Product"
          aria-label="New product name"
          autoCapitalize="words"
          className={`flex-[2] ${field}`}
        />
        <input
          value={unit}
          onChange={(event) => setUnit(event.target.value)}
          placeholder="kg"
          aria-label="New product unit"
          className={`flex-1 ${field}`}
        />
      </div>
      <div className="flex gap-2">
        <div className="flex min-w-0 flex-1 items-center rounded-sm border border-hairline bg-card">
          <span className="money pl-3 text-base text-muted" style={{ textAlign: 'left' }}>
            $
          </span>
          <input
            value={price}
            onChange={(event) => setPrice(event.target.value)}
            placeholder="0.00"
            aria-label="New product price"
            inputMode="decimal"
            className="money touch w-full bg-transparent px-2 text-base text-ink outline-none"
            style={{ textAlign: 'left' }}
          />
        </div>
        <button
          type="submit"
          disabled={busy || name.trim() === ''}
          className="touch shrink-0 rounded-full bg-action px-5 text-sm text-action-text disabled:opacity-40"
        >
          {busy ? 'Adding…' : 'Add'}
        </button>
        <button type="button" onClick={onCancel} className="touch shrink-0 px-2 text-sm text-muted">
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Exported for the tests: what a line reads as once priced. */
export { formatQuantity };
