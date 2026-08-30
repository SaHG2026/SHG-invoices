'use client';

import { useMemo, useState } from 'react';
import type { Route } from 'next';
import { AppChrome } from '@/components/app/AppChrome';
import { InvoiceRow } from '@/components/invoice/InvoiceRow';
import { useToast } from '@/components/ui/Toast';
import { useSydneyToday } from '@/hooks/use-sydney-today';
import { useTickOff } from '@/hooks/use-tick-off';
import { useProfiles } from '@/lib/queries/session';
import { useSuppliers } from '@/lib/queries/reference';
import { useSupplierInvoices, useUpdateSupplier } from '@/lib/queries/history';
import { useAllSuppliers } from '@/lib/queries/history';
import { outstandingFor, spendByMonth, spendTotal, type MonthSpend } from '@/lib/derive/history';
import { formatCents } from '@/lib/money';
import { formatDayWithYear } from '@/lib/date';
import { DEFAULT_TERMS_DAYS } from '@/lib/constants';

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
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const supplier = all.find((s) => s.id === id) ?? active.find((s) => s.id === id) ?? null;

  const outstanding = useMemo(() => outstandingFor(invoices), [invoices]);
  const spend = useMemo(
    () => (today ? spendByMonth(invoices, today) : []),
    [invoices, today],
  );

  const unpaid = invoices.filter((invoice) => invoice.status === 'unpaid');
  const settled = invoices.filter((invoice) => invoice.status !== 'unpaid');

  if (!supplier) {
    return (
      <AppChrome back={{ href: '/suppliers' as Route, label: 'Suppliers' }}>
        <h1 className="text-h2 text-ink">{isLoading ? 'Loading…' : 'No such supplier'}</h1>
      </AppChrome>
    );
  }

  return (
    <AppChrome back={{ href: '/suppliers' as Route, label: 'Suppliers' }}>
      <header className="mb-4">
        <h1 className="text-h1 text-ink">{supplier.name}</h1>
        {!supplier.active ? (
          <p className="mt-1 text-sm text-muted">
            Deactivated — hidden when adding an invoice, and every invoice kept.
          </p>
        ) : null}
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

      <section className="mb-6 rounded-sm border border-edge bg-card p-4">
        <div className="mb-2 flex items-center justify-between gap-3">
          <p className="text-xs uppercase tracking-widest text-muted">Details</p>
          <button
            type="button"
            onClick={() => setEditing((open) => !open)}
            className="touch text-sm text-action"
          >
            {editing ? 'Cancel' : 'Edit'}
          </button>
        </div>

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
  supplier: { name: string; default_terms_days: number | null; contact_name: string | null; contact_phone: string | null; active: boolean };
  busy: boolean;
  onSave: (changes: Record<string, unknown>) => void;
}) {
  const [name, setName] = useState(supplier.name);
  const [terms, setTerms] = useState(supplier.default_terms_days?.toString() ?? '');
  const [contact, setContact] = useState(supplier.contact_name ?? '');
  const [phone, setPhone] = useState(supplier.contact_phone ?? '');
  const [active, setActive] = useState(supplier.active);

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
          active,
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

      <label className="mb-4 flex items-center gap-2 text-sm text-ink">
        <input
          type="checkbox"
          checked={active}
          onChange={(e) => setActive(e.target.checked)}
          className="size-4"
        />
        Active
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
