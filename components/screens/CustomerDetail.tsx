'use client';

import { useState } from 'react';
import type { Route } from 'next';
import { AppChrome } from '@/components/app/AppChrome';
import { useToast } from '@/components/ui/Toast';
import { useAllCustomers, useUpdateCustomer } from '@/lib/queries/customers';
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
  const updateCustomer = useUpdateCustomer();

  const [editing, setEditing] = useState(false);

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

  return (
    <AppChrome back={{ href: '/customers' as Route, label: 'Customers' }}>
      <header className="mb-4">
        <h1 className="text-h1 text-ink">{customer.name}</h1>
        {!customer.active ? (
          <p className="mt-1 text-sm text-muted">
            Deactivated — hidden when choosing a customer, and every record kept.
          </p>
        ) : null}
      </header>

      <section className="mb-4 rounded-sm border border-edge bg-card p-4">
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

      <section className="rounded-sm border border-edge bg-card p-4">
        <p className="text-xs uppercase tracking-widest text-muted">Sales</p>
        <p className="mt-2 text-sm text-muted">
          Sales invoices and receipts aren’t built yet, so there is nothing owed to show here.
          When they arrive they will total separately from what the group owes suppliers — money
          in and money out never mix.
        </p>
      </section>
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
  const [active, setActive] = useState(customer.active);

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
          active,
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

      <label className="mb-4 flex items-center gap-2 text-sm text-ink">
        <input
          type="checkbox"
          checked={active}
          onChange={(event) => setActive(event.target.checked)}
          className="size-4"
        />
        Active
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
