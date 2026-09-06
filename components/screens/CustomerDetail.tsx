'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { Route } from 'next';
import { AppChrome } from '@/components/app/AppChrome';
import { useToast } from '@/components/ui/Toast';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useAllCustomers, useUpdateCustomer } from '@/lib/queries/customers';
import { useCustomerSales, useMarkReceived, useUnmarkReceived } from '@/lib/queries/sales';
import { summariseReceivable } from '@/lib/derive/receivables';
import { useSydneyToday } from '@/hooks/use-sydney-today';
import { formatCents } from '@/lib/money';
import { formatDay, formatDayWithYear } from '@/lib/date';
import { formatDueLabel, URGENCY_COLOUR, URGENCY_TINT, urgencyOf } from '@/lib/derive/urgency';
import type { Customer } from '@/lib/types';

/**
 * One customer. The mirror of SupplierDetail, minus everything about money.
 *
 * SupplierDetail carries an outstanding total, a six-month spend sparkline and
 * a payment history, because a supplier page exists to answer "what do we owe
 * these people". There is no equivalent answer here yet: sales invoices and
 * receipts are their own phase (ARCHITECTURE §17), and inventing a total from
 * nothing would be worse than showing none.
 *
 * So this page is contact details and a deactivate switch, and it says plainly
 * what it does not yet do rather than leaving an empty panel that looks broken.
 */
export function CustomerDetail({ id }: { id: string }) {
  const toast = useToast();
  const { data: customers = [], isLoading, isError } = useAllCustomers();
  const { data: sales = [] } = useCustomerSales(id);
  const updateCustomer = useUpdateCustomer();
  const markReceived = useMarkReceived();
  const unmarkReceived = useUnmarkReceived();
  const today = useSydneyToday();

  const owed = useMemo(
    () => (today ? summariseReceivable(sales, today) : null),
    [sales, today],
  );
  const outstanding = sales.filter((row) => row.status === 'outstanding');
  const settled = sales.filter((row) => row.status !== 'outstanding');

  const [editing, setEditing] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const customer = customers.find((entry) => entry.id === id) ?? null;

  if (!customer) {
    // "No such customer" and "the list never loaded" are different facts, and
    // only one of them is the person's problem to act on.
    return (
      <AppChrome back={{ href: '/customers' as Route, label: 'Customers' }}>
        <h1 className="text-h2 text-ink">
          {isError ? 'Couldn’t load customers' : isLoading ? 'Loading…' : 'No such customer'}
        </h1>
      </AppChrome>
    );
  }

  const { id: customerId, name: customerName } = customer;

  /** Remove is deactivate. Rule 5 — the sales invoices reference this row. */
  async function setActive(active: boolean) {
    try {
      await updateCustomer.mutateAsync({ id: customerId, active });
      setConfirmingRemove(false);
      toast.show(
        active
          ? `${customerName} is back on the list.`
          : `${customerName} removed. Every invoice kept.`,
      );
    } catch (error) {
      toast.show(error instanceof Error ? error.message : 'Couldn’t save that.', 'problem');
    }
  }

  return (
    <AppChrome back={{ href: '/customers' as Route, label: 'Customers' }}>
      <header className="mb-4">
        <h1 className="text-h1 text-ink">{customer.name}</h1>
        {!customer.active ? (
          <p className="mt-1 text-sm text-muted">
            Removed from the list. Every invoice sent to them is kept.
          </p>
        ) : null}

        {/* The mirror of the supplier page, and it had the same gap: Edit was
            buried in a panel and Remove was a checkbox called "Active". */}
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setEditing((open) => !open)}
            aria-expanded={editing}
            className="touch rounded-full border border-hairline bg-card px-4 text-sm text-ink"
          >
            {editing ? 'Cancel editing' : 'Edit details'}
          </button>

          {customer.active ? (
            <button
              type="button"
              onClick={() => setConfirmingRemove(true)}
              className="touch rounded-full border px-4 text-sm"
              style={{ borderColor: 'var(--hairline)', color: 'var(--muted)' }}
            >
              Remove customer
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void setActive(true)}
              disabled={updateCustomer.isPending}
              className="touch rounded-full border border-action bg-action-bg px-4 text-sm text-action disabled:opacity-40"
            >
              {updateCustomer.isPending ? 'Restoring…' : 'Restore customer'}
            </button>
          )}
        </div>
      </header>

      <section className="mb-4 rounded-sm border border-edge bg-card p-4">
        <p className="mb-2 text-xs uppercase tracking-widest text-muted">Details</p>

        {editing ? (
          <CustomerForm
            customer={customer}
            busy={updateCustomer.isPending}
            onSave={async (changes) => {
              try {
                await updateCustomer.mutateAsync({ id: customer.id, ...changes });
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
            <Fact label="Contact">{customer.contact_name || '—'}</Fact>
            <Fact label="Phone">{customer.contact_phone || '—'}</Fact>
            <Fact label="Email">{customer.contact_email || '—'}</Fact>
            {customer.notes ? <Fact label="Notes">{customer.notes}</Fact> : null}
          </dl>
        )}
      </section>

      <section className="mb-4 rounded-sm border border-edge bg-card p-4">
        <p className="text-xs uppercase tracking-widest text-muted">Owes us</p>
        <p className="money mt-1 text-total text-ink" style={{ textAlign: 'left' }}>
          {formatCents(owed?.total_cents ?? 0)}
        </p>
        <p className="mt-1 text-sm text-muted">
          {!owed || owed.invoice_count === 0
            ? 'Nothing outstanding.'
            : `across ${owed.invoice_count} invoice${owed.invoice_count === 1 ? '' : 's'}${
                owed.oldest_due ? ` · oldest due ${formatDayWithYear(owed.oldest_due)}` : ''
              }`}
        </p>
        {owed && owed.overdue_count > 0 ? (
          <p className="mt-1 text-sm" style={{ color: 'var(--spine-overdue)' }}>
            {formatCents(owed.overdue_cents)} past due.
          </p>
        ) : null}
      </section>

      {/*
        The way in to building one. It sits under "Owes us" because that is the
        figure it changes, and the flow the client described starts here:
        choose who it is for, then the products, then print.

        The customer travels in the query string. It went without one at first,
        so a link that said "for this customer" landed on a screen asking who
        it was for -- which is the link not working, and was reported as
        exactly that.
      */}
      <Link
        href={`/sales/new?customer=${customer.id}` as Route}
        className="touch mb-4 flex items-center justify-center rounded-sm border border-action bg-action-bg text-sm text-action"
      >
        + New invoice for this customer
      </Link>

      {outstanding.length > 0 ? (
        <section className="mb-4">
          <h2 className="text-h2 mb-2 text-ink">Outstanding</h2>
          <ul className="overflow-hidden rounded-sm border border-edge bg-card">
            {outstanding.map((row) => {
              const urgency = today ? urgencyOf(row.due_date, today) : 'later';
              return (
                <li
                  key={row.id}
                  className="flex h-row items-center gap-3 border-b border-hairline px-3 last:border-b-0"
                >
                  <span className="min-w-0 flex-1">
                    {/* The number is the link, because the number is what a
                        customer quotes back and what the document is headed
                        with. */}
                    <Link
                      href={`/sales/${row.id}/print` as Route}
                      className="block truncate text-sm text-action underline-offset-2 hover:underline"
                    >
                      {row.invoice_number ? `#${row.invoice_number}` : 'No invoice number'}
                    </Link>
                    <span className="figure-date block truncate text-xs text-muted">
                      Sent {formatDay(row.invoice_date)}
                    </span>
                  </span>
                  {today ? (
                    <span
                      className="shrink-0 rounded-sm px-1.5 py-0.5 text-[11px]"
                      style={{
                        backgroundColor: URGENCY_TINT[urgency],
                        color: URGENCY_COLOUR[urgency],
                      }}
                    >
                      {formatDueLabel(row.due_date, today)}
                    </span>
                  ) : null}
                  <span className="money shrink-0 text-sm text-ink">
                    {formatCents(row.amount_cents)}
                  </span>
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        const result = await markReceived.mutateAsync({ ids: [row.id] });
                        toast.show(
                          result.received.length === 0
                            ? 'Already recorded by someone else.'
                            : `Received ${formatCents(row.amount_cents)}.`,
                          result.received.length === 0 ? 'queued' : 'done',
                        );
                      } catch {
                        toast.show('Couldn’t record that. Try again.', 'problem');
                      }
                    }}
                    className="touch shrink-0 rounded-full px-3 text-xs font-medium"
                    style={{ backgroundColor: 'var(--paid-bg)', color: 'var(--paid)' }}
                  >
                    Received
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <section className="rounded-sm border border-edge bg-card p-4">
        <p className="mb-2 text-xs uppercase tracking-widest text-muted">Received</p>
        {settled.length === 0 ? (
          <p className="text-sm text-muted">Nothing received yet.</p>
        ) : (
          <ul>
            {settled.slice(0, 30).map((row) => (
              <li
                key={row.id}
                className="flex items-center gap-3 border-b border-hairline py-2 last:border-b-0"
              >
                <span className="min-w-0 flex-1 truncate text-sm text-ink">
                  {row.invoice_number ? `#${row.invoice_number}` : 'No invoice number'}
                </span>
                <span className="money shrink-0 text-sm text-muted line-through">
                  {formatCents(row.amount_cents)}
                </span>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await unmarkReceived.mutateAsync(row.id);
                      toast.show('Put back to outstanding.');
                    } catch {
                      toast.show('Couldn’t undo that.', 'problem');
                    }
                  }}
                  className="touch shrink-0 rounded-full px-3 text-xs font-medium"
                  style={{ backgroundColor: 'var(--action-bg)', color: 'var(--action)' }}
                >
                  Undo
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ConfirmDialog
        open={confirmingRemove}
        title={`Remove ${customer.name}?`}
        points={[
          <>They stop appearing when anybody records a sales invoice.</>,
          <>
            Every invoice already sent to them is kept, and this page stays where it is. Nothing
            is deleted, and you can put them back from here.
          </>,
        ]}
        question="Remove them?"
        confirmLabel="Remove customer"
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
      <dd className="min-w-0 break-words text-right text-sm text-ink">{children}</dd>
    </div>
  );
}

function CustomerForm({
  customer,
  busy,
  onSave,
}: {
  customer: Customer;
  busy: boolean;
  onSave: (changes: Partial<Customer>) => void;
}) {
  const [name, setName] = useState(customer.name);
  const [contact, setContact] = useState(customer.contact_name ?? '');
  const [phone, setPhone] = useState(customer.contact_phone ?? '');
  const [email, setEmail] = useState(customer.contact_email ?? '');
  const [notes, setNotes] = useState(customer.notes ?? '');

  const field =
    'touch w-full rounded-sm border border-hairline bg-card px-3 text-base text-ink outline-none focus:border-action';

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSave({
          name: name.trim(),
          contact_name: contact.trim() || null,
          contact_phone: phone.trim() || null,
          contact_email: email.trim() || null,
          notes: notes.trim() || null,
        });
      }}
    >
      <label className="mb-3 block">
        <span className="mb-1 block text-xs uppercase tracking-widest text-muted">Name</span>
        <input
          aria-label="Name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          className={field}
          required
        />
      </label>

      <label className="mb-3 block">
        <span className="mb-1 block text-xs uppercase tracking-widest text-muted">Contact</span>
        <input
          aria-label="Contact"
          value={contact}
          onChange={(event) => setContact(event.target.value)}
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
          onChange={(event) => setPhone(event.target.value)}
          className={field}
        />
      </label>

      <label className="mb-3 block">
        <span className="mb-1 block text-xs uppercase tracking-widest text-muted">Email</span>
        <input
          aria-label="Email"
          type="email"
          inputMode="email"
          autoCapitalize="none"
          autoCorrect="off"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className={field}
        />
      </label>

      <label className="mb-3 block">
        <span className="mb-1 block text-xs uppercase tracking-widest text-muted">Notes</span>
        <textarea
          aria-label="Notes"
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          rows={3}
          className="w-full rounded-sm border border-hairline bg-card px-3 py-2 text-base text-ink outline-none focus:border-action"
        />
      </label>

      <button
        type="submit"
        disabled={busy || name.trim() === ''}
        className="touch w-full rounded-full bg-action px-4 text-base font-medium text-action-text disabled:opacity-40"
      >
        {busy ? 'Saving…' : 'Save customer'}
      </button>
    </form>
  );
}
