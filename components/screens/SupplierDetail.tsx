'use client';

import { useMemo, useState } from 'react';
import type { Route } from 'next';
import { AppChrome } from '@/components/app/AppChrome';
import { InvoiceRow } from '@/components/invoice/InvoiceRow';
import { useToast } from '@/components/ui/Toast';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useSydneyToday } from '@/hooks/use-sydney-today';
import { useTickOff } from '@/hooks/use-tick-off';
import { useProfiles } from '@/lib/queries/session';
import { useSuppliers } from '@/lib/queries/reference';
import {
  useSupplierInvoices,
  useSupplierRange,
  useUpdateSupplier,
  type RangeBasis,
} from '@/lib/queries/history';
import { useAllSuppliers } from '@/lib/queries/history';
import {
  outstandingFor,
  spendByMonth,
  spendTotal,
  startOfMonth,
  summariseRange,
  type MonthSpend,
} from '@/lib/derive/history';
import { formatCents } from '@/lib/money';
import { compareDates, formatDayWithYear, isDateStr } from '@/lib/date';
import { DEFAULT_TERMS_DAYS, SUPPLIER_RANGE_MAX } from '@/lib/constants';

/**
 * One supplier. Spec §7.5.
 *
 * Outstanding, terms, contact, unpaid invoices, payment history, and "rolling
 * 6-month spend (a plain number and a sparkline, not a dashboard)". The
 * sparkline is twelve lines of SVG and no library — it exists to show a shape,
 * and a charting dependency to draw six bars would be the tail wagging the dog.
 *
 * This is also where payment terms finally get somewhere to live. Suppliers
 * created inline from the add-invoice sheet have none, and until now there was
 * no screen to give them any (ARCHITECTURE §18).
 */

function Sparkline({ spend }: { spend: MonthSpend[] }) {
  const peak = Math.max(...spend.map((month) => month.total_cents), 1);

  return (
    <div className="flex h-12 items-end gap-1" role="img" aria-label="Spend over the last 6 months">
      {spend.map((month) => (
        <div key={month.month} className="flex flex-1 flex-col items-center gap-1">
          <div
            className="w-full rounded-t-sm"
            style={{
              // A floor of 2px so an empty month reads as "nothing" rather
              // than as a missing bar.
              height: `${Math.max(2, (month.total_cents / peak) * 40)}px`,
              backgroundColor:
                month.total_cents === 0 ? 'var(--spine-later)' : 'var(--action)',
            }}
          />
          <span className="text-[10px] text-muted">{month.label}</span>
        </div>
      ))}
    </div>
  );
}

export function SupplierDetail({ id }: { id: string }) {
  const toast = useToast();
  const today = useSydneyToday();
  const { tickOff, undo } = useTickOff();
  const { data: people = [] } = useProfiles();
  const { data: active = [] } = useSuppliers();
  const { data: all = [] } = useAllSuppliers();
  const { data: invoices = [], isLoading } = useSupplierInvoices(id);
  const updateSupplier = useUpdateSupplier();

  const [editing, setEditing] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [rangeFrom, setRangeFrom] = useState('');
  const [rangeTo, setRangeTo] = useState('');
  const [rangeBasis, setRangeBasis] = useState<RangeBasis>('due');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const supplier = all.find((s) => s.id === id) ?? active.find((s) => s.id === id) ?? null;

  const outstanding = useMemo(() => outstandingFor(invoices), [invoices]);
  const spend = useMemo(
    () => (today ? spendByMonth(invoices, today) : []),
    [invoices, today],
  );

  const unpaid = invoices.filter((invoice) => invoice.status === 'unpaid');
  const settled = invoices.filter((invoice) => invoice.status !== 'unpaid');

  /*
   * The range fields default to this month so far, and are overridden the
   * moment anybody types. Held as "" rather than as the resolved dates so a
   * `today` that arrives after first render fills them in — `useSydneyToday`
   * reads the clock in an effect, so the first render genuinely has no today.
   */
  const from = rangeFrom || (today ? startOfMonth(today) : '');
  const to = rangeTo || today || '';
  const backwards = isDateStr(from) && isDateStr(to) && compareDates(from, to) > 0;

  const range = useSupplierRange(id, from, to, rangeBasis);
  const rangeSummary = useMemo(
    () => summariseRange(range.data?.rows ?? []),
    [range.data],
  );

  if (!supplier) {
    return (
      <AppChrome back={{ href: '/suppliers' as Route, label: 'Suppliers' }}>
        <h1 className="text-h2 text-ink">{isLoading ? 'Loading…' : 'No such supplier'}</h1>
      </AppChrome>
    );
  }

  /**
   * Remove is deactivate, and it always has been. Rule 5: nothing is ever
   * deleted, because every invoice this supplier has ever been on references
   * it forever and a hole in that is not recoverable.
   *
   * What changed is that the word matches the intent and the consequence is
   * stated before it happens, instead of a checkbox called "Active" whose
   * meaning you had to already know.
   */
  const { id: supplierId, name: supplierName } = supplier;

  async function setActive(active: boolean) {
    try {
      await updateSupplier.mutateAsync({ id: supplierId, active });
      setConfirmingRemove(false);
      toast.show(
        active
          ? `${supplierName} is back on the list.`
          : `${supplierName} removed. Every invoice kept.`,
      );
    } catch (error) {
      toast.show(error instanceof Error ? error.message : 'Couldn’t save that.', 'problem');
    }
  }

  const restore = () => setActive(true);

  return (
    <AppChrome back={{ href: '/suppliers' as Route, label: 'Suppliers' }}>
      <header className="mb-4">
        <h1 className="text-h1 text-ink">{supplier.name}</h1>
        {!supplier.active ? (
          <p className="mt-1 text-sm text-muted">
            Removed from the add-invoice list. Every invoice it has ever been on is kept.
          </p>
        ) : null}

        {/*
          The two things you can do to a supplier, said out loud, directly
          under its name.

          Both existed already — Edit was a 14px word inside a panel four
          scrolls down, and Remove was a checkbox labelled "Active". Neither is
          a control somebody finds while looking for one, which is why this was
          reported as missing rather than as buried. Nothing new can be done
          here; it can now be seen.
        */}
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setEditing((open) => !open)}
            aria-expanded={editing}
            className="touch rounded-full border border-hairline bg-card px-4 text-sm text-ink"
          >
            {editing ? 'Cancel editing' : 'Edit details'}
          </button>

          {supplier.active ? (
            <button
              type="button"
              onClick={() => setConfirmingRemove(true)}
              className="touch rounded-full border px-4 text-sm"
              style={{ borderColor: 'var(--hairline)', color: 'var(--muted)' }}
            >
              Remove supplier
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void restore()}
              disabled={updateSupplier.isPending}
              className="touch rounded-full border border-action bg-action-bg px-4 text-sm text-action disabled:opacity-40"
            >
              {updateSupplier.isPending ? 'Restoring…' : 'Restore supplier'}
            </button>
          )}
        </div>
      </header>

      <section className="mb-4 rounded-sm border border-edge bg-card p-4">
        <p className="text-xs uppercase tracking-widest text-muted">Outstanding</p>
        <p className="money mt-1 text-total text-ink" style={{ textAlign: 'left' }}>
          {formatCents(outstanding.total_cents)}
        </p>
        <p className="mt-1 text-sm text-muted">
          {outstanding.count === 0
            ? 'Nothing outstanding.'
            : `across ${outstanding.count} invoice${outstanding.count === 1 ? '' : 's'}${
                outstanding.oldest_due
                  ? ` · oldest due ${formatDayWithYear(outstanding.oldest_due)}`
                  : ''
              }`}
        </p>
      </section>

      <section className="mb-4 rounded-sm border border-edge bg-card p-4">
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <p className="text-xs uppercase tracking-widest text-muted">Last 6 months</p>
          <p className="money text-h2 text-ink">{formatCents(spendTotal(spend))}</p>
        </div>
        {spend.length > 0 ? <Sparkline spend={spend} /> : null}
      </section>

      {/*
        Between two dates. Asked for after real use.

        Two figures, not one. "Total pending between two dates" is about money
        still to go; the settled figure is beside it because the same range
        answers "and how much did we already pay them", and a single number
        that mixed the two would answer neither.

        The basis is a visible choice, not a default hidden in a comment: "what
        falls due in October" and "what they billed us in October" are
        different questions, and which one is on screen is written on it.
      */}
      <section className="mb-4 rounded-sm border border-edge bg-card p-4">
        <p className="mb-2 text-xs uppercase tracking-widest text-muted">Between two dates</p>

        <div className="mb-3 grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs text-muted">From</span>
            <input
              type="date"
              aria-label="From date"
              value={from}
              max={to || undefined}
              onChange={(event) => setRangeFrom(event.target.value)}
              className="figure-date touch w-full rounded-sm border border-hairline bg-card px-3 text-base text-ink outline-none focus:border-action"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-muted">To</span>
            <input
              type="date"
              aria-label="To date"
              value={to}
              min={from || undefined}
              onChange={(event) => setRangeTo(event.target.value)}
              className="figure-date touch w-full rounded-sm border border-hairline bg-card px-3 text-base text-ink outline-none focus:border-action"
            />
          </label>
        </div>

        <div role="group" aria-label="Count by" className="mb-3 flex flex-wrap gap-2">
          {(
            [
              { key: 'due', label: 'By due date' },
              { key: 'invoice', label: 'By invoice date' },
            ] as const
          ).map((option) => (
            <button
              key={option.key}
              type="button"
              onClick={() => setRangeBasis(option.key)}
              aria-pressed={rangeBasis === option.key}
              className={`touch rounded-full border px-3 text-sm ${
                rangeBasis === option.key
                  ? 'border-action bg-action-bg text-action'
                  : 'border-hairline bg-card text-ink'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>

        {backwards ? (
          <p role="alert" className="text-sm text-overdue">
            The first date is after the second.
          </p>
        ) : range.isLoading ? (
          <p className="text-sm text-muted">Adding it up…</p>
        ) : range.isError ? (
          <p className="text-sm text-overdue">Couldn’t read that range. Try again.</p>
        ) : range.data?.truncated ? (
          /* A refused answer can be narrowed. A short one gets written down. */
          <p className="text-sm text-muted">
            That range covers more than {SUPPLIER_RANGE_MAX} invoices, which is more than this can
            total honestly. Narrow the dates.
          </p>
        ) : (
          <>
            <dl className="grid grid-cols-2 gap-3">
              <div>
                <dt className="text-xs uppercase tracking-widest text-muted">Still pending</dt>
                <dd className="money mt-1 text-h2 text-ink" style={{ textAlign: 'left' }}>
                  {formatCents(rangeSummary.pending.total_cents)}
                </dd>
                <dd className="mt-0.5 text-xs text-muted">
                  {rangeSummary.pending.count} invoice
                  {rangeSummary.pending.count === 1 ? '' : 's'}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-widest text-muted">Already paid</dt>
                <dd className="money mt-1 text-h2 text-muted" style={{ textAlign: 'left' }}>
                  {formatCents(rangeSummary.settled.total_cents)}
                </dd>
                <dd className="mt-0.5 text-xs text-muted">
                  {rangeSummary.settled.count} invoice
                  {rangeSummary.settled.count === 1 ? '' : 's'}
                </dd>
              </div>
            </dl>

            {rangeSummary.voided_count > 0 || rangeSummary.awaiting_count > 0 ? (
              <p className="mt-2 text-xs text-muted">
                {[
                  rangeSummary.voided_count > 0 ? `${rangeSummary.voided_count} voided` : '',
                  rangeSummary.awaiting_count > 0
                    ? `${rangeSummary.awaiting_count} waiting for review`
                    : '',
                ]
                  .filter(Boolean)
                  .join(' · ')}
                {' in this range, counted in neither figure.'}
              </p>
            ) : null}

            {/*
              The invoices the figures are made of, listed under them. Rule 4
              holds inside a panel: a total nobody can open is a total nobody
              can check.
            */}
            {(range.data?.rows.length ?? 0) === 0 ? (
              <p className="mt-3 text-sm text-muted">Nothing in that range.</p>
            ) : (
              <ul className="mt-3 overflow-hidden rounded-sm border border-hairline">
                {(range.data?.rows ?? []).map((invoice) => (
                  <li
                    key={invoice.id}
                    className="flex h-row items-center gap-3 border-b border-hairline px-3 last:border-b-0"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-ink">
                        {invoice.invoice_number ? `#${invoice.invoice_number}` : invoice.internal_ref}
                      </span>
                      <span className="figure-date block truncate text-xs text-muted">
                        {formatDayWithYear(
                          rangeBasis === 'due' ? invoice.due_date : invoice.invoice_date,
                        )}
                        {' · '}
                        {invoice.business.code}
                        {invoice.status === 'unpaid'
                          ? invoice.approved_at === null
                            ? ' · waiting for review'
                            : ' · pending'
                          : invoice.status === 'paid'
                            ? ' · paid'
                            : ' · void'}
                      </span>
                    </span>
                    <span
                      className={`money shrink-0 text-sm ${
                        invoice.status === 'unpaid' ? 'text-ink' : 'text-muted line-through'
                      }`}
                    >
                      {formatCents(invoice.amount_cents)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      <section className="mb-6 rounded-sm border border-edge bg-card p-4">
        {/* One Edit control, in the header. Two of them is two things to keep
            in step, and the buried one is the one that was never found. */}
        <p className="mb-2 text-xs uppercase tracking-widest text-muted">Details</p>

        {editing ? (
          <SupplierForm
            supplier={supplier}
            busy={updateSupplier.isPending}
            onSave={async (changes) => {
              try {
                await updateSupplier.mutateAsync({ id: supplier.id, ...changes });
                setEditing(false);
                toast.show('Saved.');
              } catch (error) {
                toast.show(
                  error instanceof Error ? error.message : 'Couldn’t save that.',
                  'problem',
                );
              }
            }}
          />
        ) : (
          <dl>
            <Fact label="Payment terms">
              {supplier.default_terms_days !== null
                ? `${supplier.default_terms_days} days`
                : `Not set — using ${DEFAULT_TERMS_DAYS} days`}
            </Fact>
            <Fact label="Contact">{supplier.contact_name || '—'}</Fact>
            <Fact label="Phone">{supplier.contact_phone || '—'}</Fact>
            {supplier.notes ? <Fact label="Notes">{supplier.notes}</Fact> : null}
          </dl>
        )}
      </section>

      {unpaid.length > 0 ? (
        <section className="mb-6">
          <h2 className="text-h2 mb-2 text-ink">Unpaid</h2>
          <ul className="overflow-hidden rounded-sm border border-edge bg-card">
            {unpaid.map((invoice) => (
              <InvoiceRow
                key={invoice.id}
                invoice={invoice}
                today={today ?? invoice.due_date}
                people={people}
                expanded={expandedId === invoice.id}
                onToggle={() =>
                  setExpandedId((current) => (current === invoice.id ? null : invoice.id))
                }
                onMarkPaid={() => void tickOff(invoice)}
                onUndo={() => void undo(invoice.id)}
              />
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <h2 className="text-h2 mb-2 text-ink">Payment history</h2>
        {settled.length === 0 ? (
          <p className="rounded-sm border border-edge bg-card p-4 text-sm text-muted">
            Nothing settled yet.
          </p>
        ) : (
          <ul className="overflow-hidden rounded-sm border border-edge bg-card">
            {settled.slice(0, 50).map((invoice) => {
              const payer = people.find((person) => person.id === invoice.paid_by);
              return (
                <li
                  key={invoice.id}
                  className={invoice.status === 'void' ? 'opacity-60 [&_*]:line-through' : ''}
                >
                  <ul>
                    <InvoiceRow
                      invoice={payer ? { ...invoice, created_by: payer.id } : invoice}
                      today={today ?? invoice.due_date}
                      people={people}
                      expanded={expandedId === invoice.id}
                      onToggle={() =>
                        setExpandedId((current) => (current === invoice.id ? null : invoice.id))
                      }
                      showSpine={false}
                    />
                  </ul>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <ConfirmDialog
        open={confirmingRemove}
        title={`Remove ${supplier.name}?`}
        points={[
          <>It stops appearing when anybody adds an invoice.</>,
          <>
            Every invoice it has ever been on is kept, and this page stays where it is. Nothing
            is deleted, and you can put it back from here.
          </>,
        ]}
        question="Remove it?"
        confirmLabel="Remove supplier"
        onConfirm={() => void setActive(false)}
        onCancel={() => setConfirmingRemove(false)}
      />
    </AppChrome>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-hairline py-2 last:border-b-0">
      <dt className="shrink-0 text-xs uppercase tracking-widest text-muted">{label}</dt>
      <dd className="min-w-0 text-right text-sm text-ink">{children}</dd>
    </div>
  );
}

function SupplierForm({
  supplier,
  busy,
  onSave,
}: {
  supplier: {
    name: string;
    default_terms_days: number | null;
    contact_name: string | null;
    contact_phone: string | null;
  };
  busy: boolean;
  onSave: (changes: Record<string, unknown>) => void;
}) {
  const [name, setName] = useState(supplier.name);
  const [terms, setTerms] = useState(supplier.default_terms_days?.toString() ?? '');
  const [contact, setContact] = useState(supplier.contact_name ?? '');
  const [phone, setPhone] = useState(supplier.contact_phone ?? '');

  const field =
    'touch w-full rounded-sm border border-hairline bg-card px-3 text-base text-ink outline-none focus:border-action';

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const parsed = terms.trim() === '' ? null : Number(terms);
        onSave({
          name: name.trim(),
          // Terms drive the due date on every future invoice, so a nonsense
          // value is worse than none.
          default_terms_days:
            parsed !== null && Number.isInteger(parsed) && parsed > 0 && parsed <= 365
              ? parsed
              : null,
          contact_name: contact.trim() || null,
          contact_phone: phone.trim() || null,
        });
      }}
    >
      <label className="mb-3 block">
        <span className="mb-1 block text-xs uppercase tracking-widest text-muted">Name</span>
        <input
          aria-label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={field}
          required
        />
      </label>

      <label className="mb-3 block">
        <span className="mb-1 block text-xs uppercase tracking-widest text-muted">
          Payment terms (days)
        </span>
        {/*
          An explicit aria-label, because the hint below sits inside the same
          label element — without it a screen reader announces the field as
          "Payment terms (days) Sets the due date automatically, counted from
          the invoice date", which is a sentence, not a field name.
        */}
        <input
          aria-label="Payment terms (days)"
          type="text"
          inputMode="numeric"
          value={terms}
          onChange={(e) => setTerms(e.target.value)}
          placeholder={`Blank means ${DEFAULT_TERMS_DAYS} days`}
          className={field}
        />
        <span className="mt-1 block text-xs text-muted">
          Sets the due date automatically, counted from the invoice date.
        </span>
      </label>

      <label className="mb-3 block">
        <span className="mb-1 block text-xs uppercase tracking-widest text-muted">Contact</span>
        <input
          aria-label="Contact"
          value={contact}
          onChange={(e) => setContact(e.target.value)}
          className={field}
        />
      </label>

      <label className="mb-3 block">
        <span className="mb-1 block text-xs uppercase tracking-widest text-muted">Phone</span>
        <input
          aria-label="Phone"
          type="tel"
          inputMode="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          className={field}
        />
      </label>

      <button
        type="submit"
        disabled={busy || name.trim() === ''}
        className="touch w-full rounded-full bg-action px-4 text-base font-medium text-action-text disabled:opacity-40"
      >
        {busy ? 'Saving…' : 'Save supplier'}
      </button>
    </form>
  );
}
