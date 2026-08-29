'use client';

import { useCallback, useMemo, useState } from 'react';
import { Sheet } from '@/components/ui/Sheet';
import { SupplierField } from './SupplierField';
import { useToast } from '@/components/ui/Toast';
import { useBusinesses, useCreateSupplier, useSuppliers } from '@/lib/queries/reference';
import { findDuplicates, useCreateInvoice } from '@/lib/queries/invoices';
import { useCurrentProfile } from '@/lib/queries/session';
import {
  activePreset,
  buildInvoicePayload,
  defaultDueDate,
  invoiceFormSchema,
  type InvoiceFormValues,
} from '@/lib/invoice-form';
import { readLastBusinessId, writeLastBusinessId } from '@/lib/recents';
import { addDays, formatDayWithYear, sydneyToday } from '@/lib/date';
import { formatCents } from '@/lib/money';
import { DUE_PRESETS_DAYS } from '@/lib/constants';
import type { Invoice, Supplier } from '@/lib/types';

/**
 * The screen the whole app is judged on. Spec §1: "Time to log an invoice on a
 * phone, one-handed, from cold app open: under 15 seconds."
 *
 * Four taps and a number for the common case:
 *   business (pre-selected)  ->  supplier (type three letters, tap)
 *   ->  amount  ->  due date (pre-filled from the supplier's terms)  ->  save
 *
 * Everything optional lives behind the disclosure, which is collapsed. Nothing
 * gets added above that line without something else coming out.
 *
 * Form state is plain `useState`, set once, and never derived from query data
 * during render (notes §1.1). The Sheet holds the form guard, so no query
 * anywhere refetches on focus while this is open.
 */

interface AddInvoiceSheetProps {
  open: boolean;
  onClose: () => void;
}

export function AddInvoiceSheet({ open, onClose }: AddInvoiceSheetProps) {
  return open ? <SheetBody onClose={onClose} /> : null;
}

/**
 * Split out so every piece of form state is created fresh on open and thrown
 * away on close. A half-typed invoice from last time reappearing would be
 * worse than an empty form.
 */
function SheetBody({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const { data: profile } = useCurrentProfile();
  const { data: businesses = [] } = useBusinesses();
  const { data: suppliers = [] } = useSuppliers();
  const createInvoice = useCreateInvoice();
  const createSupplier = useCreateSupplier();

  const today = useMemo(() => sydneyToday(), []);

  const [businessId, setBusinessId] = useState<string>(
    () => readLastBusinessId() ?? businesses[0]?.id ?? '',
  );
  const [supplier, setSupplier] = useState<Supplier | null>(null);
  const [amount, setAmount] = useState('');
  const [dueDate, setDueDate] = useState<string>(() => defaultDueDate(null, today));
  const [invoiceDate, setInvoiceDate] = useState<string>(today);
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [showMore, setShowMore] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [duplicates, setDuplicates] = useState<Invoice[] | null>(null);
  const [checking, setChecking] = useState(false);

  // The business list can arrive after first render; adopt the first one only
  // if nothing has been chosen yet.
  const effectiveBusinessId = businessId || businesses[0]?.id || '';

  const values: InvoiceFormValues = {
    business_id: effectiveBusinessId,
    supplier_id: supplier?.id ?? '',
    amount,
    due_date: dueDate,
    invoice_date: invoiceDate,
    invoice_number: invoiceNumber,
    note: '',
  };

  const chosenPreset = activePreset(dueDate, today, DUE_PRESETS_DAYS);

  /** Picking a supplier re-dates the invoice to that supplier's own terms. */
  const chooseSupplier = useCallback(
    (next: Supplier) => {
      setSupplier(next);
      setDueDate(defaultDueDate(next, today));
      setErrors((current) => ({ ...current, supplier_id: '' }));
    },
    [today],
  );

  async function onCreateSupplier(name: string) {
    if (!profile) return;
    try {
      const created = await createSupplier.mutateAsync({ name, actorId: profile.id });
      chooseSupplier(created);
    } catch (error) {
      toast.show(error instanceof Error ? error.message : 'Couldn’t add that supplier.', 'problem');
    }
  }

  async function save(skipDuplicateCheck = false) {
    if (!profile) return;

    const parsed = invoiceFormSchema.safeParse(values);
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0]);
        next[field] ??= issue.message;
      }
      setErrors(next);
      return;
    }
    setErrors({});

    // Spec §6: a warning, never a block. Checked here rather than on every
    // keystroke so it costs nothing until the moment it matters.
    if (!skipDuplicateCheck && invoiceNumber.trim() !== '') {
      setChecking(true);
      try {
        const found = await findDuplicates(parsed.data.supplier_id, invoiceNumber);
        if (found.length > 0) {
          setDuplicates(found);
          setChecking(false);
          return;
        }
      } catch {
        // A failed duplicate check must not stop a legitimate save. The
        // warning is a courtesy; losing the invoice is not.
      }
      setChecking(false);
    }

    const business = businesses.find((b) => b.id === parsed.data.business_id);
    if (!business || !supplier) return;

    // Generated before sending, so a replayed offline write conflicts on the
    // primary key instead of creating a second invoice (notes §1.5).
    const id = crypto.randomUUID();
    const payload = { ...buildInvoicePayload(parsed.data, { actorId: profile.id, id }), id };

    writeLastBusinessId(business.id);
    onClose();

    try {
      const saved = await createInvoice.mutateAsync({
        payload,
        supplier: { id: supplier.id, name: supplier.name },
        business: { id: business.id, code: business.code, name: business.name },
      });

      toast.show(
        saved?.internal_ref
          ? `Saved · ${saved.internal_ref}`
          : `Saved · ${formatCents(payload.amount_cents)} to ${supplier.name}`,
      );
    } catch {
      // networkMode 'offlineFirst' means an offline write is paused, not lost.
      // Saying "saved" would be a lie; saying nothing would be worse.
      toast.show('Saved — will send when you’re back online.', 'queued');
    }
  }

  const busy = checking || createInvoice.isPending;

  return (
    <Sheet
      open
      title="New invoice"
      onClose={onClose}
      footer={
        <button
          type="button"
          onClick={() => save()}
          disabled={busy}
          className="touch w-full rounded-sm bg-gold px-4 text-base font-medium text-ink disabled:opacity-40"
        >
          {busy ? 'Saving…' : 'Save invoice'}
        </button>
      }
    >
      {duplicates ? (
        <DuplicateWarning
          duplicates={duplicates}
          onSaveAnyway={() => {
            setDuplicates(null);
            void save(true);
          }}
          onCancel={() => setDuplicates(null)}
        />
      ) : null}

      {/* Business — last used is pre-selected, so this is usually already right. */}
      <div className="mb-5 flex flex-wrap gap-2">
        {businesses.map((business) => {
          const isChosen = business.id === effectiveBusinessId;
          return (
            <button
              key={business.id}
              type="button"
              onClick={() => setBusinessId(business.id)}
              aria-pressed={isChosen}
              className={`touch rounded-sm border px-4 text-sm ${
                isChosen ? 'border-ink bg-ink text-snow' : 'border-hair bg-card text-ink'
              }`}
            >
              {business.code}
            </button>
          );
        })}
      </div>

      <SupplierField
        suppliers={suppliers}
        selected={supplier}
        onSelect={chooseSupplier}
        onCreate={onCreateSupplier}
        creating={createSupplier.isPending}
        error={errors.supplier_id}
      />

      {/* Amount. type="text" with inputMode="decimal" — notes §4: type="number"
          brings spinners, changes value on scroll, and fights locale separators. */}
      <div className="mb-5">
        <label className="mb-1 block text-xs uppercase tracking-widest text-mute" htmlFor="amount">
          Amount
        </label>
        <div
          className={`flex items-center rounded-sm border bg-card ${errors.amount ? 'border-brick' : 'border-hair'}`}
        >
          <span className="money pl-3 text-base text-mute" style={{ textAlign: 'left' }}>
            $
          </span>
          <input
            id="amount"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            className="money touch w-full bg-transparent px-2 text-base text-ink outline-none"
            style={{ textAlign: 'left' }}
          />
        </div>
        {errors.amount ? (
          <p role="alert" className="mt-1 text-sm text-brick">
            {errors.amount}
          </p>
        ) : null}
      </div>

      {/* Due date. The supplier's own terms are already applied. */}
      <div className="mb-5">
        <span className="mb-1 block text-xs uppercase tracking-widest text-mute">Due</span>
        <div className="flex flex-wrap gap-2">
          {DUE_PRESETS_DAYS.map((days) => {
            const isChosen = chosenPreset === days;
            const isSupplierTerm = supplier?.default_terms_days === days;
            return (
              <button
                key={days}
                type="button"
                onClick={() => setDueDate(addDays(today, days))}
                aria-pressed={isChosen}
                className={`touch rounded-sm border px-4 text-sm ${
                  isChosen
                    ? 'border-ink bg-ink text-snow'
                    : isSupplierTerm
                      ? 'border-slate bg-card text-slate'
                      : 'border-hair bg-card text-ink'
                }`}
              >
                +{days}d
              </button>
            );
          })}
          <label className="touch flex items-center rounded-sm border border-hair bg-card px-3 text-sm text-ink">
            <span className="sr-only">Pick a due date</span>
            <input
              type="date"
              value={dueDate}
              onChange={(event) => setDueDate(event.target.value)}
              className="figure-date bg-transparent text-sm text-ink outline-none"
            />
          </label>
        </div>
        <p className="figure-date mt-2 text-sm text-ink">{formatDayWithYear(dueDate)}</p>
        {errors.due_date ? (
          <p role="alert" className="mt-1 text-sm text-brick">
            {errors.due_date}
          </p>
        ) : null}
      </div>

      {/* Everything optional, collapsed. Spec §7.3. */}
      <button
        type="button"
        onClick={() => setShowMore((current) => !current)}
        aria-expanded={showMore}
        className="touch flex w-full items-center text-left text-sm text-slate"
      >
        <span className="mr-2">{showMore ? '⌃' : '⌄'}</span>
        Invoice number, date
      </button>

      {showMore ? (
        <div className="mt-3 border-t border-hair pt-4">
          <div className="mb-4">
            <label
              className="mb-1 block text-xs uppercase tracking-widest text-mute"
              htmlFor="invoice-number"
            >
              Invoice number
            </label>
            <input
              id="invoice-number"
              type="text"
              autoComplete="off"
              autoCapitalize="characters"
              value={invoiceNumber}
              onChange={(event) => setInvoiceNumber(event.target.value)}
              className="touch w-full rounded-sm border border-hair bg-card px-3 text-base text-ink outline-none focus:border-slate"
            />
          </div>

          <div>
            <label
              className="mb-1 block text-xs uppercase tracking-widest text-mute"
              htmlFor="invoice-date"
            >
              Invoice date
            </label>
            <input
              id="invoice-date"
              type="date"
              value={invoiceDate}
              onChange={(event) => setInvoiceDate(event.target.value)}
              className="figure-date touch w-full rounded-sm border border-hair bg-card px-3 text-base text-ink outline-none focus:border-slate"
            />
            <p className="figure-date mt-1 text-sm text-mute">{formatDayWithYear(invoiceDate)}</p>
          </div>
        </div>
      ) : null}
    </Sheet>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * Spec §6: "show an inline warning naming the existing invoice, its amount and
 * who entered it. Offer 'Save anyway' and 'Open the existing one'. Never
 * silently block."
 */
function DuplicateWarning({
  duplicates,
  onSaveAnyway,
  onCancel,
}: {
  duplicates: Invoice[];
  onSaveAnyway: () => void;
  onCancel: () => void;
}) {
  return (
    <div role="alert" className="mb-5 border-l-[3px] border-gold bg-snow p-3">
      <p className="text-sm font-medium text-ink">
        {duplicates.length === 1
          ? 'That invoice number is already logged for this supplier.'
          : `That invoice number is already logged ${duplicates.length} times for this supplier.`}
      </p>

      <ul className="mt-2">
        {duplicates.slice(0, 3).map((invoice) => (
          <li key={invoice.id} className="figure-date py-1 text-sm text-mute">
            <span className="money mr-2 text-ink" style={{ textAlign: 'left' }}>
              {formatCents(invoice.amount_cents)}
            </span>
            {invoice.internal_ref}
          </li>
        ))}
      </ul>

      <p className="mt-2 text-sm text-mute">
        Suppliers do restart their numbering, so this may be fine.
      </p>

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={onSaveAnyway}
          className="touch flex-1 rounded-sm border border-ink bg-ink px-3 text-sm text-snow"
        >
          Save anyway
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="touch flex-1 rounded-sm border border-hair bg-card px-3 text-sm text-ink"
        >
          Go back
        </button>
      </div>
    </div>
  );
}
