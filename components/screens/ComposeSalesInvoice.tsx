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
import { useProducts } from '@/lib/queries/products';
import { useCreateSalesInvoice, type NewSalesLine } from '@/lib/queries/sales';
import { submitWrite, writeFailureMessage } from '@/lib/offline/submit';
import { addDays, formatDay } from '@/lib/date';
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

export function ComposeSalesInvoice({ businessCode = 'DDL' }: { businessCode?: string }) {
  const toast = useToast();
  const router = useRouter();
  const today = useSydneyToday();
  const { data: profile } = useCurrentProfile();
  const { data: businesses = [] } = useBusinesses();
  const { data: customers = [] } = useCustomers();
  const createInvoice = useCreateSalesInvoice();

  const business = businesses.find(
    (entry) => entry.code.toLowerCase() === businessCode.toLowerCase(),
  );
  const { data: products = [] } = useProducts(business?.id ?? null);

  const [customerId, setCustomerId] = useState('');
  const [invoiceDate, setInvoiceDate] = useState<string>('');
  const [dueDate, setDueDate] = useState<string>('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);
  const [error, setError] = useState<string | null>(null);

  // `today` arrives in an effect, so the first render genuinely has none.
  const issuedOn = invoiceDate || today || '';
  const dueOn = dueDate || (issuedOn ? addDays(issuedOn, DEFAULT_TERMS_DAYS) : '');

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

  function update(key: string, changes: Partial<DraftLine>) {
    setLines((current) =>
      current.map((line) => (line.key === key ? { ...line, ...changes } : line)),
    );
  }

  /** Choosing a product fills the line in — that is the whole point of the list. */
  function choose(key: string, product: Product) {
    update(key, {
      productId: product.id,
      description: product.name,
      unit: product.unit ?? '',
      // Copied, not linked. The line keeps this price forever; changing the
      // product later never reaches an invoice already issued.
      price: centsToInputValue(product.unit_price_cents),
    });
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

  return (
    <AppChrome back={{ href: '/customers' as Route, label: 'Customers' }}>
      <h1 className="text-h1 mb-3 text-ink">New invoice</h1>

      <label className="mb-4 block">
        <span className="mb-1 block text-xs uppercase tracking-widest text-muted">Customer</span>
        <select
          value={customerId}
          onChange={(event) => setCustomerId(event.target.value)}
          aria-label="Customer"
          className="touch w-full rounded-sm border border-hairline bg-card px-3 text-base text-ink outline-none focus:border-action"
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
            value={issuedOn}
            onChange={(event) => setInvoiceDate(event.target.value)}
            className="figure-date touch w-full rounded-sm border border-hairline bg-card px-3 text-base text-ink outline-none focus:border-action"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs uppercase tracking-widest text-muted">Due</span>
          <input
            type="date"
            aria-label="Due date"
            value={dueOn}
            onChange={(event) => setDueDate(event.target.value)}
            className="figure-date touch w-full rounded-sm border border-hairline bg-card px-3 text-base text-ink outline-none focus:border-action"
          />
          <span className="figure-date mt-1 block text-xs text-muted">
            {dueOn ? formatDay(dueOn) : ' '}
          </span>
        </label>
      </div>

      <div className="mb-4 flex gap-1">
        {DUE_PRESETS_DAYS.map((days) => (
          <button
            key={days}
            type="button"
            onClick={() => setDueDate(addDays(issuedOn, days))}
            aria-label={`Due in ${days} days`}
            className={`touch rounded-full border px-3 text-xs ${
              dueOn === addDays(issuedOn, days)
                ? 'border-action bg-action text-action-text'
                : 'border-hairline bg-card text-muted'
            }`}
          >
            {days}d
          </button>
        ))}
      </div>

      <h2 className="text-h2 mb-2 text-ink">Lines</h2>

      <ul className="mb-3 flex flex-col gap-2">
        {priced.map((entry, index) => (
          <li key={entry.line.key} className="rounded-sm border border-edge bg-card p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-xs uppercase tracking-widest text-muted">
                Line {index + 1}
              </span>
              {lines.length > 1 ? (
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

            {products.length > 0 ? (
              <select
                aria-label={`Product for line ${index + 1}`}
                value={entry.line.productId ?? ''}
                onChange={(event) => {
                  const product = products.find((item) => item.id === event.target.value);
                  if (product) choose(entry.line.key, product);
                  else update(entry.line.key, { productId: null });
                }}
                className="touch mb-2 w-full rounded-sm border border-hairline bg-card px-3 text-base text-ink outline-none focus:border-action"
              >
                <option value="">Pick a product, or type below</option>
                {products.map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.name}
                    {product.unit ? ` (per ${product.unit})` : ''} ·{' '}
                    {formatCents(product.unit_price_cents)}
                  </option>
                ))}
              </select>
            ) : null}

            <input
              aria-label={`Description for line ${index + 1}`}
              value={entry.line.description}
              onChange={(event) =>
                update(entry.line.key, { description: event.target.value, productId: null })
              }
              placeholder="Description"
              className="touch mb-2 w-full rounded-sm border border-hairline bg-card px-3 text-base text-ink outline-none focus:border-action"
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

/** Exported for the tests: what a line reads as once priced. */
export { formatQuantity };
