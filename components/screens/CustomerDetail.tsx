'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { Route } from 'next';
import { AppChrome } from '@/components/app/AppChrome';
import { useToast } from '@/components/ui/Toast';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { SalesInvoiceRowItem } from '@/components/invoice/SalesInvoiceRowItem';
import { useAllCustomers, useUpdateCustomer } from '@/lib/queries/customers';
import { useCustomerSales } from '@/lib/queries/sales';
import { summariseReceivable } from '@/lib/derive/receivables';
import { useSydneyToday } from '@/hooks/use-sydney-today';
import { formatCents, sumCents } from '@/lib/money';
import { formatDayWithYear } from '@/lib/date';
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
  const today = useSydneyToday();

  const owed = useMemo(
    () => (today ? summariseReceivable(sales, today) : null),
    [sales, today],
  );
  const outstanding = sales.filter((row) => row.status === 'outstanding');
  const settled = sales.filter((row) => row.status !== 'outstanding');
  /* Rule 4: the figure on the History header is the sum of the rows inside
     it, not a second query that could disagree with them. */
  const receivedTotal = useMemo(() => sumCents(settled), [settled]);

  const [editing, setEditing] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  /*
   * Both closed by default, and both remember nothing.
   *
   * This page is opened to answer "what do they owe us", and the two panels
   * above that figure are reference material. A remembered open state would
   * mean the answer starts below the fold for whoever last went looking for a
   * phone number.
   */
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

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

  /*
   * What the folded Details row says about itself.
   *
   * A collapsed panel with a generic label is a panel nobody opens, because
   * there is no way to tell whether it holds anything. This says the useful
   * part -- a phone number is what somebody came for -- and says plainly when
   * there is nothing behind it, so the tap is never wasted.
   */
  const contactSummary =
    [customer.contact_name, customer.contact_phone, customer.contact_email]
      .filter((entry) => entry && entry.trim() !== '')
      .join(' · ') || 'No contact details yet';

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
            onClick={() => {
              // Opening the editor opens the panel holding it. Otherwise
              // "Edit details" appears to do nothing at all.
              setEditing((open) => !open);
              setDetailsOpen(true);
            }}
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

      {/*
        Details, folded away.

        The client: *"hide the contact, phone and email within the details"*.
        Three rows reading "—" was the top third of the screen saying
        nothing, and pushing the money below the fold on the page whose whole
        purpose is the money. Open it when you need to ring somebody.

        His aside — *"contact is essentially phone, no?"* — is fair,
        and the answer is nearly yes: Contact is a person's NAME, the one you
        ask for when you ring. The label now says so, because a field whose
        meaning has to be guessed is a field that gets filled in wrongly.
      */}
      <section className="mb-4 overflow-hidden rounded-sm border border-edge bg-card">
        <button
          type="button"
          onClick={() => setDetailsOpen((open) => !open)}
          aria-expanded={detailsOpen}
          className="flex h-row w-full items-center gap-3 px-4 text-left active:bg-pressed"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-xs uppercase tracking-widest text-muted">Details</span>
            {!detailsOpen ? (
              <span className="block truncate text-sm text-ink">{contactSummary}</span>
            ) : null}
          </span>
          <span
            aria-hidden
            className="shrink-0 text-xs text-muted"
            style={{ transform: detailsOpen ? 'rotate(90deg)' : undefined }}
          >
            &rsaquo;
          </span>
        </button>

        {detailsOpen ? (
          <div className="panel-in border-t border-hairline px-4 py-3">
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
                <Fact label="Contact name">{customer.contact_name || '—'}</Fact>
                <Fact label="Phone">{customer.contact_phone || '—'}</Fact>
                <Fact label="Email">{customer.contact_email || '—'}</Fact>
                {customer.notes ? <Fact label="Notes">{customer.notes}</Fact> : null}
              </dl>
            )}
          </div>
        ) : null}
      </section>

      {/*
        What has come back, under the details.

        Asked for: *"underneath the details, add in the history of this
        particular customer to see past payments received"*. It was at the
        very bottom of the page, under the outstanding list, which is the
        wrong way round — "have they ever actually paid us" is a question
        you ask BEFORE deciding what to do about what they owe.
      */}
      <section className="mb-4 overflow-hidden rounded-sm border border-edge bg-card">
        <button
          type="button"
          onClick={() => setHistoryOpen((open) => !open)}
          aria-expanded={historyOpen}
          className="flex h-row w-full items-center gap-3 px-4 text-left active:bg-pressed"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-xs uppercase tracking-widest text-muted">History</span>
            <span className="block truncate text-sm text-ink">
              {settled.length === 0
                ? 'Nothing received yet'
                : `${formatCents(receivedTotal)} received · ${settled.length} invoice${
                    settled.length === 1 ? '' : 's'
                  }`}
            </span>
          </span>
          <span
            aria-hidden
            className="shrink-0 text-xs text-muted"
            style={{ transform: historyOpen ? 'rotate(90deg)' : undefined }}
          >
            &rsaquo;
          </span>
        </button>

        {historyOpen ? (
          settled.length === 0 ? (
            <p className="panel-in border-t border-hairline px-4 py-3 text-sm text-muted">
              Nothing received from {customer.name} yet.
            </p>
          ) : (
            <ul className="panel-in border-t border-hairline">
              {settled.slice(0, 50).map((row) => (
                <SalesInvoiceRowItem key={row.id} row={row} today={today} />
              ))}
            </ul>
          )
        ) : null}
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
        The way in to building one. It sits under "Owes us" because that is
        the figure it changes, and the flow the client described starts here:
        choose who it is for, then the products, then print.

        The customer travels in the query string. It went without one at
        first, so a link that said "for this customer" landed on a screen
        asking who it was for — which is the link not working, and was
        reported as exactly that.
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
          {/*
            Every row opens into its own bill.

            The "Received" button used to sit on the row itself, and was asked
            about directly: *"not sure why there is received in there. Remove
            that."* It was a one-tap way to write off money on whichever row
            you happened to be looking at, sitting exactly where a chevron
            belongs — so the row read as a control rather than as
            something you could open. Marking one received now happens inside
            the invoice, after you have seen what is on it.
          */}
          <ul className="overflow-hidden rounded-sm border border-edge bg-card">
            {outstanding.map((row) => (
              <SalesInvoiceRowItem key={row.id} row={row} today={today} />
            ))}
          </ul>
        </section>
      ) : null}

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
        {/* "Contact name", not "Contact". The client asked whether contact was
            essentially the phone number, which is what a field labelled by its
            role rather than its content invites. This one holds the name of
            the person you ask for when you ring. */}
        <span className="mb-1 block text-xs uppercase tracking-widest text-muted">
          Contact name
        </span>
        <input
          aria-label="Contact name"
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
