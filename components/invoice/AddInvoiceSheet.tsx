'use client';

import { useCallback, useMemo, useState } from 'react';
import { Sheet } from '@/components/ui/Sheet';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { SupplierField } from './SupplierField';
import { useToast } from '@/components/ui/Toast';
import { useBusinesses, useCreateSupplier, useSuppliers } from '@/lib/queries/reference';
import { findDuplicates, useCreateInvoice } from '@/lib/queries/invoices';
import { useCurrentProfile, useProfiles } from '@/lib/queries/session';
import {
  activePreset,
  buildInvoicePayload,
  defaultDueDate,
  invoiceFormSchema,
  type InvoiceFormValues,
} from '@/lib/invoice-form';
import { readLastBusinessId, writeLastBusinessId } from '@/lib/recents';
import { addDays, compareDates, formatDay, formatDayWithYear, sydneyToday } from '@/lib/date';
import { formatCents } from '@/lib/money';
import { DUE_PRESETS_DAYS } from '@/lib/constants';
import type { Invoice, Supplier } from '@/lib/types';

/**
 * The screen the whole app is judged on. Spec §1: "Time to log an invoice on a
 * phone, one-handed, from cold app open: under 15 seconds."
 *
 * Everything is on one screen. There is no disclosure and nothing to scroll
 * past: business, supplier, invoice number, amount, and the two dates side by
 * side. The earlier version hid the invoice number and the invoice date behind
 * a "More" chevron, and hiding a field people fill in most of the time costs
 * more taps than showing it costs space.
 *
 * Order matters and is deliberate — supplier, number, amount, dates — because
 * it is the order the information appears on a docket you are holding.
 *
 * Form state is plain `useState`, set once, never derived from query data
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

/** One thing that looks odd enough to ask about before saving. */
interface Warning {
  key: string;
  node: React.ReactNode;
}

/**
 * Split out so every piece of form state is created fresh on open and thrown
 * away on close. A half-typed invoice from last time reappearing would be
 * worse than an empty form.
 */
function SheetBody({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const { data: profile } = useCurrentProfile();
  const { data: allProfiles = [] } = useProfiles();
  const { data: businesses = [] } = useBusinesses();
  const { data: suppliers = [] } = useSuppliers();
  const createInvoice = useCreateInvoice();
  const createSupplier = useCreateSupplier();

  const today = useMemo(() => sydneyToday(), []);

  const [businessId, setBusinessId] = useState<string>(
    () => readLastBusinessId() ?? businesses[0]?.id ?? '',
  );
  const [supplier, setSupplier] = useState<Supplier | null>(null);
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [amount, setAmount] = useState('');
  const [invoiceDate, setInvoiceDate] = useState<string>(today);
  const [dueDate, setDueDate] = useState<string>(() => defaultDueDate(null, today));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [warnings, setWarnings] = useState<Warning[] | null>(null);
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

  /**
   * Everything worth stopping for, gathered before saving.
   *
   * Both cases are warnings, never blocks. Spec §6 says so for duplicates —
   * "suppliers restart numbering" — and a due date already past is often
   * correct too, because invoices arrive late.
   */
  async function collectWarnings(parsed: InvoiceFormValues): Promise<Warning[]> {
    const found: Warning[] = [];

    if (compareDates(parsed.due_date, today) < 0) {
      found.push({
        key: 'past-due',
        node: (
          <>
            The due date <strong>{formatDayWithYear(parsed.due_date)}</strong> has already passed.
            It will show as overdue straight away.
          </>
        ),
      });
    }

    if (invoiceNumber.trim() !== '' && supplier) {
      try {
        const duplicates = await findDuplicates(parsed.supplier_id, invoiceNumber);
        for (const existing of duplicates.slice(0, 3)) {
          // Spec §6 asks for the amount and who entered it; the client asked
          // for the supplier, the number and when it was logged. All five fit,
          // and each of them is a different way of recognising "oh, that one".
          const enteredBy = allProfiles.find((person) => person.id === existing.created_by);
          found.push({
            key: existing.id,
            node: (
              <>
                <span className="block">
                  Duplicate entry found for <strong>{supplier.name}</strong> with invoice number{' '}
                  <strong>{existing.invoice_number}</strong>, logged{' '}
                  <strong>{formatDayWithYear(existing.invoice_date)}</strong>.
                </span>
                <span className="mt-1 block text-sm text-mute">
                  <span className="money" style={{ textAlign: 'left' }}>
                    {formatCents(existing.amount_cents)}
                  </span>
                  {' · '}
                  {existing.internal_ref}
                  {enteredBy ? ` · entered by ${enteredBy.display_name}` : ''}
                </span>
              </>
            ),
          });
        }
      } catch {
        // A failed duplicate check must not stop a legitimate save. The
        // warning is a courtesy; losing the invoice is not.
      }
    }

    return found;
  }

  async function save(skipChecks = false) {
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

    if (!skipChecks) {
      setChecking(true);
      const found = await collectWarnings(parsed.data);
      setChecking(false);
      if (found.length > 0) {
        setWarnings(found);
        return;
      }
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
  const fieldClass =
    'touch w-full rounded-sm border bg-card px-3 text-base text-ink outline-none focus:border-slate';

  return (
    <>
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
        {/* Business — last used is pre-selected, so this is usually already right. */}
        <div className="mb-4 flex flex-wrap gap-2">
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
            placeholder="Optional"
            value={invoiceNumber}
            onChange={(event) => setInvoiceNumber(event.target.value)}
            className={`${fieldClass} border-hair`}
          />
        </div>

        {/* Amount. type="text" with inputMode="decimal" — notes §4: type="number"
            brings spinners, changes value on scroll, and fights locale separators. */}
        <div className="mb-4">
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

        {/*
          The two dates, side by side. Invoice date is today unless changed;
          due date follows the supplier's terms unless changed. The shortcuts
          sit on the due-date heading line, because that is the one that moves
          and it keeps the pickers aligned underneath each other.
        */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="mb-1 flex h-6 items-center">
              <label
                className="text-xs uppercase tracking-widest text-mute"
                htmlFor="invoice-date"
              >
                Date
              </label>
            </div>
            <input
              id="invoice-date"
              type="date"
              value={invoiceDate}
              onChange={(event) => setInvoiceDate(event.target.value)}
              className={`figure-date ${fieldClass} border-hair`}
            />
            <p className="figure-date mt-1 text-xs text-mute">{formatDay(invoiceDate)}</p>
          </div>

          <div>
            <div className="mb-1 flex h-6 items-center justify-between gap-1">
              <label className="text-xs uppercase tracking-widest text-mute" htmlFor="due-date">
                Due
              </label>
              <div className="flex gap-1">
                {DUE_PRESETS_DAYS.map((days) => {
                  const isChosen = chosenPreset === days;
                  const isSupplierTerm = supplier?.default_terms_days === days;
                  return (
                    <button
                      key={days}
                      type="button"
                      onClick={() => setDueDate(addDays(today, days))}
                      aria-pressed={isChosen}
                      aria-label={`Due in ${days} days`}
                      className={`rounded-sm border px-2 py-0.5 text-xs ${
                        isChosen
                          ? 'border-ink bg-ink text-snow'
                          : isSupplierTerm
                            ? 'border-slate bg-card text-slate'
                            : 'border-hair bg-card text-mute'
                      }`}
                    >
                      {days}d
                    </button>
                  );
                })}
              </div>
            </div>
            <input
              id="due-date"
              type="date"
              value={dueDate}
              onChange={(event) => setDueDate(event.target.value)}
              className={`figure-date ${fieldClass} ${errors.due_date ? 'border-brick' : 'border-hair'}`}
            />
            <p className="figure-date mt-1 text-xs text-mute">{formatDay(dueDate)}</p>
          </div>
        </div>
      </Sheet>

      <ConfirmDialog
        open={warnings !== null}
        title="Check this first"
        points={(warnings ?? []).map((warning) => warning.node)}
        question="Enter it anyway?"
        confirmLabel="Enter anyway"
        onConfirm={() => {
          setWarnings(null);
          void save(true);
        }}
        onCancel={() => setWarnings(null)}
      />
    </>
  );
}
