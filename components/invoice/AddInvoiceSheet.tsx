'use client';

import { useCallback, useMemo, useState } from 'react';
import { Sheet } from '@/components/ui/Sheet';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { SupplierField } from './SupplierField';
import { BusinessMark } from '@/components/ui/BusinessMark';
import { useToast } from '@/components/ui/Toast';
import {
  optimisticSupplier,
  useBusinesses,
  useCreateSupplier,
  useSuppliers,
} from '@/lib/queries/reference';
import { submitWrite, writeFailureMessage } from '@/lib/offline/submit';
import { findDuplicates, useCreateInvoice } from '@/lib/queries/invoices';
import { useCurrentProfile, useProfiles } from '@/lib/queries/session';
import {
  activePreset,
  buildInvoicePayload,
  invoiceFormSchema,
  resolveDueDate,
  type InvoiceFormValues,
} from '@/lib/invoice-form';
import { usePathname } from 'next/navigation';
import { readLastBusinessId, writeLastBusinessId } from '@/lib/recents';
import { businessIdForPath } from '@/lib/scope';
import { compareDates, formatDay, formatDayWithYear, sydneyToday } from '@/lib/date';
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

/**
 * The small shortcut pills beside a field label — Today, and 7d/14d/30d.
 *
 * A real 44px height, not a compact pill with an invisible extended hit area.
 * The clever version was tried first and measured 21px in the browser: the
 * pseudo-element never picked up its inset, and a target that is only 44px in
 * theory is 21px in the hand. Notes §4 puts the floor at 44px because "a 32px
 * pill is a rage-inducing miss rate at arm's length", and a rule you cannot
 * verify is not being followed.
 *
 * The heading line is taller for it. That is the correct trade.
 */
const SHORTCUT = 'touch inline-flex items-center rounded-full border px-3 text-xs';

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

  const pathname = usePathname();
  const today = useMemo(() => sydneyToday(), []);

  /*
   * Which business this invoice is for, in order of what the person most
   * likely means:
   *
   *   1. what they have just tapped in this sheet
   *   2. the business they are standing in — adding from inside Majheri means
   *      Majheri, not wherever they were yesterday
   *   3. the last one they used on this device, from the dashboard
   *   4. the first business, so the field is never empty
   *
   * Held as "have they chosen yet" rather than as the id itself, so a late
   * businesses query or a navigation cannot leave a stale pre-selection behind.
   */
  const [chosenBusinessId, setChosenBusinessId] = useState<string | null>(null);
  const lastUsedBusinessId = useMemo(() => readLastBusinessId(), []);
  const scopeBusinessId = useMemo(
    () => businessIdForPath(pathname ?? '', businesses),
    [pathname, businesses],
  );
  const [supplier, setSupplier] = useState<Supplier | null>(null);
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [amount, setAmount] = useState('');
  const [invoiceDate, setInvoiceDate] = useState<string>(today);

  /*
   * The due date is expressed one of two ways, never both.
   *
   *   termDays        — "14 days", from the supplier's own terms or a preset.
   *                     Follows the invoice date, because that is what a term
   *                     means: 14 days from the date on the docket.
   *   explicitDueDate — a date picked directly. Stays where it was put.
   *
   * Holding it this way is what makes changing the invoice date do the right
   * thing. Storing only the resolved date would mean either overwriting a date
   * somebody typed, or leaving a term stale after the invoice date moved.
   */
  const [termDays, setTermDays] = useState<number | null>(null);
  const [explicitDueDate, setExplicitDueDate] = useState<string | null>(null);

  const dueDate = resolveDueDate({ invoiceDate, termDays, explicitDueDate });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [warnings, setWarnings] = useState<Warning[] | null>(null);
  const [checking, setChecking] = useState(false);

  // The business list can arrive after first render; adopt the first one only
  // if nothing has been chosen yet.
  const effectiveBusinessId =
    chosenBusinessId ?? scopeBusinessId ?? lastUsedBusinessId ?? businesses[0]?.id ?? '';

  const values: InvoiceFormValues = {
    business_id: effectiveBusinessId,
    supplier_id: supplier?.id ?? '',
    amount,
    due_date: dueDate,
    invoice_date: invoiceDate,
    invoice_number: invoiceNumber,
    note: '',
  };

  const chosenPreset = activePreset(dueDate, invoiceDate, DUE_PRESETS_DAYS);

  /** Picking a supplier re-dates the invoice to that supplier's own terms. */
  const chooseSupplier = useCallback((next: Supplier) => {
    setSupplier(next);
    // Adopt their terms, and drop any date picked before they were chosen —
    // their terms are a better guess than the fallback that produced it.
    setTermDays(next.default_terms_days);
    setExplicitDueDate(null);
    setErrors((current) => ({ ...current, supplier_id: '' }));
  }, []);

  /**
   * Add a supplier without leaving the sheet — spec 7.3.
   *
   * The id is decided here rather than by the database, which is what lets the
   * supplier be chosen immediately instead of after a round trip. Offline that
   * round trip never completes, so the old version of this function stopped the
   * entry flow dead at a dock with no signal; now the supplier is selected
   * whether the write went or is waiting, and the invoice that follows queues
   * behind it in order.
   */
  async function onCreateSupplier(name: string) {
    if (!profile) return;

    const created = optimisticSupplier(crypto.randomUUID(), name);
    const outcome = await submitWrite(createSupplier, {
      id: created.id,
      name,
      actorId: profile.id,
    });

    if (outcome.kind === 'failed') {
      toast.show(writeFailureMessage(outcome.error, 'Couldn’t add that supplier.'), 'problem');
      return;
    }

    chooseSupplier(created);
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
                <span className="mt-1 block text-sm text-muted">
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

    const outcome = await submitWrite(createInvoice, {
      payload,
      supplier: { id: supplier.id, name: supplier.name },
      business: { id: business.id, code: business.code, name: business.name },
    });

    /*
     * Three outcomes, three sentences. lib/offline/submit.ts has the account of
     * why this used to be a try/catch and why that was wrong twice: an offline
     * write never reached the catch at all, and everything that did reach it
     * — an RLS refusal, a bad payload — was told it had been saved.
     */
    if (outcome.kind === 'queued') {
      toast.show('Saved — will send when you’re back online.', 'queued');
      return;
    }

    if (outcome.kind === 'failed') {
      toast.show(
        writeFailureMessage(outcome.error, 'Couldn’t save that invoice. Nothing was written.'),
        'problem',
      );
      return;
    }

    toast.show(
      outcome.data?.internal_ref
        ? `Saved · ${outcome.data.internal_ref}`
        : `Saved · ${formatCents(payload.amount_cents)} to ${supplier.name}`,
    );
  }

  const busy = checking || createInvoice.isPending;
  const fieldClass =
    'touch w-full rounded-sm border bg-card px-3 text-base text-ink outline-none focus:border-action';

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
            className="touch w-full rounded-full bg-action px-4 text-base font-medium text-action-text disabled:opacity-40"
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
                onClick={() => setChosenBusinessId(business.id)}
                aria-pressed={isChosen}
                className={`touch flex items-center gap-2 rounded-full border pl-2 pr-4 text-sm transition-colors duration-150 ${
                  isChosen ? 'border-action bg-action text-action-text' : 'border-hairline bg-card text-ink'
                }`}
              >
                <BusinessMark business={business} size="sm" />
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
            className="mb-1 block text-xs uppercase tracking-widest text-muted"
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
            className={`${fieldClass} border-hairline`}
          />
        </div>

        {/* Amount. type="text" with inputMode="decimal" — notes §4: type="number"
            brings spinners, changes value on scroll, and fights locale separators. */}
        <div className="mb-4">
          <label className="mb-1 block text-xs uppercase tracking-widest text-muted" htmlFor="amount">
            Amount
          </label>
          <div
            className={`flex items-center rounded-sm border bg-card ${errors.amount ? 'border-overdue' : 'border-hairline'}`}
          >
            <span className="money pl-3 text-base text-muted" style={{ textAlign: 'left' }}>
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
            <p role="alert" className="mt-1 text-sm text-overdue">
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
            <div className="mb-1 flex items-center justify-between gap-1.5">
              <label
                className="text-xs uppercase tracking-widest text-muted"
                htmlFor="invoice-date"
              >
                Date
              </label>
              <button
                type="button"
                onClick={() => setInvoiceDate(today)}
                aria-pressed={invoiceDate === today}
                className={`${SHORTCUT} ${
                  invoiceDate === today
                    ? 'border-action bg-action text-action-text'
                    : 'border-hairline bg-card text-muted'
                }`}
              >
                Today
              </button>
            </div>
            <input
              id="invoice-date"
              type="date"
              value={invoiceDate}
              onChange={(event) => setInvoiceDate(event.target.value)}
              className={`figure-date ${fieldClass} border-hairline`}
            />
            <p className="figure-date mt-1 text-xs text-muted">{formatDay(invoiceDate)}</p>
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between gap-1.5">
              <label className="text-xs uppercase tracking-widest text-muted" htmlFor="due-date">
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
                      onClick={() => {
                        setTermDays(days);
                        setExplicitDueDate(null);
                      }}
                      aria-pressed={isChosen}
                      aria-label={`Due in ${days} days`}
                      className={`${SHORTCUT} ${
                        isChosen
                          ? 'border-action bg-action text-action-text'
                          : isSupplierTerm
                            ? 'border-action bg-action-bg text-action'
                            : 'border-hairline bg-card text-muted'
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
              onChange={(event) => setExplicitDueDate(event.target.value)}
              className={`figure-date ${fieldClass} ${errors.due_date ? 'border-overdue' : 'border-hairline'}`}
            />
            <p className="figure-date mt-1 text-xs text-muted">{formatDay(dueDate)}</p>
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
