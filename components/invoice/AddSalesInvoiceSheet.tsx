'use client';

import { useMemo, useState } from 'react';
import { Sheet } from '@/components/ui/Sheet';
import { useToast } from '@/components/ui/Toast';
import { useCurrentProfile } from '@/lib/queries/session';
import { useBusinesses } from '@/lib/queries/reference';
import { useCreateSalesInvoice } from '@/lib/queries/sales';
import { useAllCustomers, useCreateCustomer } from '@/lib/queries/customers';
import { addDays, sydneyToday } from '@/lib/date';
import { formatCents, parseAmountToCents } from '@/lib/money';
import { DEFAULT_TERMS_DAYS, DUE_PRESETS_DAYS } from '@/lib/constants';
import type { Customer } from '@/lib/types';

/**
 * Recording an invoice Deli Delights has SENT. ARCHITECTURE §17.
 *
 * The mirror of AddInvoiceSheet, and deliberately a separate component rather
 * than a mode on that one. The two share a shape — who, number, dates, amount —
 * and almost nothing else: this one has no supplier type-ahead ranked against
 * the fifteen-second target, no duplicate warning against a supplier's
 * numbering, and no payment run. A `direction` prop threaded through all of
 * that would put a condition inside every branch of the screen the spec cares
 * most about.
 *
 * The words are different too, and on purpose. This is money coming in, so
 * nothing here says "paid" and nothing says "supplier".
 */

interface AddSalesInvoiceSheetProps {
  open: boolean;
  onClose: () => void;
}

export function AddSalesInvoiceSheet({ open, onClose }: AddSalesInvoiceSheetProps) {
  return open ? <SheetBody onClose={onClose} /> : null;
}

function SheetBody({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const { data: profile } = useCurrentProfile();
  const { data: businesses = [] } = useBusinesses();
  const { data: customers = [] } = useAllCustomers();
  const createSalesInvoice = useCreateSalesInvoice();
  const createCustomer = useCreateCustomer();

  const today = useMemo(() => sydneyToday(), []);

  const [customerId, setCustomerId] = useState('');
  const [newCustomerName, setNewCustomerName] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [invoiceDate, setInvoiceDate] = useState(today);
  const [dueDate, setDueDate] = useState(() => addDays(today, DEFAULT_TERMS_DAYS));
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);

  /*
   * Deli Delights is the only business that sells, so it is not a choice.
   * Offering four buttons where three of them are wrong is a question with one
   * right answer, which is not a question.
   */
  const deliDelights = businesses.find((business) => business.code === 'DDL') ?? null;

  const active = customers.filter((customer) => customer.active);
  const amountCents = parseAmountToCents(amount);

  const field =
    'touch w-full rounded-sm border border-hairline bg-card px-3 text-base text-ink outline-none focus:border-action';

  async function addCustomerInline() {
    if (!profile || newCustomerName.trim() === '') return;
    const name = newCustomerName.trim();
    try {
      const created: Customer = await createCustomer.mutateAsync({ name, actorId: profile.id });
      setCustomerId(created.id);
      setNewCustomerName('');
      toast.show(`Added ${name}.`);
    } catch (problem) {
      toast.show(
        problem instanceof Error ? problem.message : 'Couldn’t add that customer.',
        'problem',
      );
    }
  }

  async function save() {
    setError(null);

    if (!profile) return;
    if (!deliDelights) {
      setError('Deli Delights is missing from the businesses list.');
      return;
    }
    if (customerId === '') {
      setError('Choose who this invoice is for.');
      return;
    }
    if (amountCents === null || amountCents <= 0) {
      setError('Enter an amount, like 1250.00');
      return;
    }

    try {
      await createSalesInvoice.mutateAsync({
        // Generated here so a retry is a no-op rather than a second invoice
        // for the same money — notes §1.5.
        id: crypto.randomUUID(),
        business_id: deliDelights.id,
        customer_id: customerId,
        invoice_number: invoiceNumber.trim() || null,
        invoice_date: invoiceDate,
        due_date: dueDate,
        amount_cents: amountCents,
        created_by: profile.id,
      });

      toast.show(`Recorded ${formatCents(amountCents)} owed to us.`);
      onClose();
    } catch (problem) {
      toast.show(
        problem instanceof Error && problem.message.includes('sales_invoices')
          ? 'The sales table isn’t there yet — run CATCH_UP_005.sql in Supabase.'
          : 'Couldn’t save that. Check your connection and try again.',
        'problem',
      );
    }
  }

  const busy = createSalesInvoice.isPending;

  return (
    <Sheet
      open
      title="Invoice a customer"
      onClose={onClose}
      footer={
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy}
          className="touch w-full rounded-full bg-action px-4 text-base font-medium text-action-text disabled:opacity-40"
        >
          {busy ? 'Saving…' : 'Save invoice'}
        </button>
      }
    >
      <div className="mb-4">
        <label className="mb-1 block text-xs uppercase tracking-widest text-muted" htmlFor="customer">
          Customer
        </label>
        <select
          id="customer"
          value={customerId}
          onChange={(event) => setCustomerId(event.target.value)}
          className={field}
        >
          <option value="">Choose a customer…</option>
          {active.map((customer) => (
            <option key={customer.id} value={customer.id}>
              {customer.name}
            </option>
          ))}
        </select>

        {active.length === 0 ? (
          /* No customers yet is the common first run, and sending somebody
             away to another screen to come back is how a flow gets abandoned. */
          <div className="mt-2 flex gap-2">
            <input
              value={newCustomerName}
              onChange={(event) => setNewCustomerName(event.target.value)}
              aria-label="New customer name"
              placeholder="Or add one now"
              autoCapitalize="words"
              className={field}
            />
            <button
              type="button"
              onClick={() => void addCustomerInline()}
              disabled={newCustomerName.trim() === '' || createCustomer.isPending}
              className="touch shrink-0 rounded-full bg-action px-4 text-sm text-action-text disabled:opacity-40"
            >
              + Add
            </button>
          </div>
        ) : null}
      </div>

      <div className="mb-4">
        <label
          className="mb-1 block text-xs uppercase tracking-widest text-muted"
          htmlFor="sales-number"
        >
          Invoice number
        </label>
        <input
          id="sales-number"
          value={invoiceNumber}
          onChange={(event) => setInvoiceNumber(event.target.value)}
          placeholder="Optional"
          autoCapitalize="characters"
          className={field}
        />
      </div>

      <div className="mb-4">
        <label
          className="mb-1 block text-xs uppercase tracking-widest text-muted"
          htmlFor="sales-amount"
        >
          Amount
        </label>
        <div className="flex items-center rounded-sm border border-hairline bg-card">
          <span className="pl-3 text-base text-muted">$</span>
          <input
            id="sales-amount"
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder="0.00"
            className="touch min-w-0 flex-1 bg-transparent px-2 text-base text-ink outline-none"
          />
        </div>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3">
        <label className="block">
          <span className="mb-1 block text-xs uppercase tracking-widest text-muted">Date sent</span>
          <input
            type="date"
            value={invoiceDate}
            onChange={(event) => {
              setInvoiceDate(event.target.value);
              // Terms run from the invoice date, never from today — the bug
              // b966cfd fixed on the payables side, not repeated here.
              setDueDate(addDays(event.target.value, DEFAULT_TERMS_DAYS));
            }}
            className={field}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs uppercase tracking-widest text-muted">Due</span>
          <input
            type="date"
            value={dueDate}
            onChange={(event) => setDueDate(event.target.value)}
            className={field}
          />
        </label>
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        {DUE_PRESETS_DAYS.map((days) => (
          <button
            key={days}
            type="button"
            onClick={() => setDueDate(addDays(invoiceDate, days))}
            aria-pressed={dueDate === addDays(invoiceDate, days)}
            className={`touch rounded-full border px-3 text-sm ${
              dueDate === addDays(invoiceDate, days)
                ? 'border-action bg-action text-action-text'
                : 'border-hairline bg-card text-ink'
            }`}
          >
            {days}d
          </button>
        ))}
      </div>

      {error ? (
        <p
          className="rounded-sm px-3 py-2 text-sm"
          style={{ backgroundColor: 'var(--spine-overdue-bg)', color: 'var(--spine-overdue)' }}
        >
          {error}
        </p>
      ) : null}
    </Sheet>
  );
}
