'use client';

import { useCallback, useMemo, useState } from 'react';
import { Sheet } from '@/components/ui/Sheet';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { SupplierField } from './SupplierField';
import { useToast } from '@/components/ui/Toast';
import { optimisticSupplier, useCreateSupplier, useSuppliers } from '@/lib/queries/reference';
import { submitWrite, writeFailureMessage } from '@/lib/offline/submit';
import {
  findVenueDuplicates,
  useCreateVenueInvoice,
  useUpdateVenueInvoice,
} from '@/lib/queries/venue';
import { useCurrentProfile } from '@/lib/queries/session';
import {
  activePreset,
  buildInvoicePayload,
  invoiceFormSchema,
  resolveDueDate,
  type InvoiceFormValues,
} from '@/lib/invoice-form';
import { compareDates, formatDay, formatDayWithYear, sydneyToday } from '@/lib/date';
import { centsToInputValue, formatCents } from '@/lib/money';
import { DUE_PRESETS_DAYS } from '@/lib/constants';
import type { StaffInvoice, Supplier } from '@/lib/types';

/**
 * A venue logging one of its own invoices.
 *
 * ---------------------------------------------------------------------------
 * Why this is a copy of `AddInvoiceSheet` and not a mode inside it
 *
 * That sheet is the screen the whole app is judged on — spec §1's fifteen
 * seconds, measured, met, and described by the client as feeling
 * instantaneous. A role branch inside it would put the app's one measured
 * feature at regression risk for the sake of two accounts, and every later
 * change to the entry path would have to be reasoned about in two audiences at
 * once.
 *
 * So the duplication is deliberate and it is the cheaper mistake. What is
 * NOT duplicated is anything that decides what gets written: `invoiceFormSchema`
 * and `buildInvoicePayload` are imported, because notes §1.3 is about exactly
 * this — the previous app had two paths that built a record, one of them wrong,
 * and it looked like it saved.
 *
 * Three things differ, and each is forced rather than chosen:
 *
 *   1. No business picker. A venue has one venue, and the database enforces it
 *      anyway (`with check (business_id = staff_venue())`). Offering a choice
 *      that the insert would then refuse is the interface promising something
 *      it cannot do.
 *   2. A different duplicate lookup — `find_duplicate_invoices` returns whole
 *      invoice rows, status included, so a venue must not touch it.
 *   3. The toast cannot name the reference, because the write cannot ask for
 *      the row back. See `lib/queries/venue.ts`.
 * ---------------------------------------------------------------------------
 */

const SHORTCUT = 'touch inline-flex items-center rounded-full border px-3 text-xs';

interface AddVenueInvoiceSheetProps {
  open: boolean;
  onClose: () => void;
  /**
   * The invoice being corrected, or null to add a new one.
   *
   * One sheet for both, because notes §1.3 is about exactly what happens when
   * there are two: the previous app built a record on one path and a copy on
   * the other, wrote back only the copy for new records, and silently
   * discarded every edit — with a success toast. There is one form here and
   * one `buildInvoicePayload`, and the only difference is which mutation the
   * result is handed to.
   */
  editing?: StaffInvoice | null;
}

export function AddVenueInvoiceSheet({ open, onClose, editing }: AddVenueInvoiceSheetProps) {
  return open ? (
    /*
     * Keyed on the invoice, so switching from adding to correcting — or from
     * one invoice to another — rebuilds every field rather than leaving the
     * last one's amount sitting in the box.
     */
    <SheetBody key={editing?.id ?? 'new'} onClose={onClose} editing={editing ?? null} />
  ) : null;
}

interface Warning {
  key: string;
  node: React.ReactNode;
}

/** Split out so every field is created fresh on open and thrown away on close. */
function SheetBody({ onClose, editing }: { onClose: () => void; editing: StaffInvoice | null }) {
  const toast = useToast();
  const { data: profile } = useCurrentProfile();
  const { data: suppliers = [] } = useSuppliers();
  const createInvoice = useCreateVenueInvoice();
  const updateInvoice = useUpdateVenueInvoice();
  const createSupplier = useCreateSupplier();

  const today = useMemo(() => sydneyToday(), []);

  /*
   * Set once, at mount, and never re-derived from query data during render
   * (notes §1.1). That is what makes a background refetch unable to wipe what
   * somebody has half-typed into a correction.
   */
  const [supplier, setSupplier] = useState<Supplier | null>(
    () => suppliers.find((s) => s.id === editing?.supplier_id) ?? null,
  );
  const [invoiceNumber, setInvoiceNumber] = useState(editing?.invoice_number ?? '');
  const [amount, setAmount] = useState(
    editing ? centsToInputValue(editing.amount_cents) : '',
  );
  const [invoiceDate, setInvoiceDate] = useState<string>(editing?.invoice_date ?? today);
  const [termDays, setTermDays] = useState<number | null>(null);
  /*
   * An invoice being corrected has a due date somebody already chose, so it is
   * held as an explicit date rather than a term. Re-deriving it from the
   * supplier's terms would silently move a date that was picked on purpose.
   */
  const [explicitDueDate, setExplicitDueDate] = useState<string | null>(
    editing?.due_date ?? null,
  );

  const dueDate = resolveDueDate({ invoiceDate, termDays, explicitDueDate });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [warnings, setWarnings] = useState<Warning[] | null>(null);
  const [checking, setChecking] = useState(false);

  /*
   * The venue, from the signed-in profile, and from nowhere else.
   *
   * Not from a URL, not from "the last one you used", not from a picker. The
   * database will refuse anything else — CATCH_UP_010's `with check` compares
   * against `staff_venue()`, read from the caller's own JWT — so taking it
   * from any other source could only ever produce a write that fails.
   */
  const venueId = profile?.business_id ?? '';

  const values: InvoiceFormValues = {
    business_id: venueId,
    supplier_id: supplier?.id ?? '',
    amount,
    due_date: dueDate,
    invoice_date: invoiceDate,
    invoice_number: invoiceNumber,
    note: '',
  };

  const chosenPreset = activePreset(dueDate, invoiceDate, DUE_PRESETS_DAYS);

  const chooseSupplier = useCallback((next: Supplier) => {
    setSupplier(next);
    setTermDays(next.default_terms_days);
    setExplicitDueDate(null);
    setErrors((current) => ({ ...current, supplier_id: '' }));
  }, []);

  /**
   * Add a supplier without leaving the sheet.
   *
   * A venue may insert into `suppliers` but not update them (CATCH_UP_010 §4),
   * which is exactly what this needs: the id is decided here so the supplier
   * can be selected immediately rather than after a round trip, and offline
   * that round trip never completes at all.
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
   * Everything worth stopping for. Warnings, never blocks — spec §6.
   *
   * The duplicate check matters more here than anywhere else in the app. One
   * login is shared by whoever is on shift, so the person entering this
   * invoice genuinely cannot see what the last shift did, and there is no
   * activity feed for them to look it up in.
   */
  async function collectWarnings(parsed: InvoiceFormValues): Promise<Warning[]> {
    const found: Warning[] = [];

    if (compareDates(parsed.due_date, today) < 0) {
      found.push({
        key: 'past-due',
        node: (
          <>
            The due date <strong>{formatDayWithYear(parsed.due_date)}</strong> has already passed.
          </>
        ),
      });
    }

    if (invoiceNumber.trim() !== '' && supplier) {
      try {
        const duplicates = await findVenueDuplicates(parsed.supplier_id, invoiceNumber);
        for (const existing of duplicates.filter((d) => d.id !== editing?.id).slice(0, 3)) {
          found.push({
            key: existing.id,
            node: (
              <>
                <span className="block">
                  This shop has already logged <strong>{existing.supplier_name}</strong> invoice{' '}
                  <strong>{existing.invoice_number}</strong>, dated{' '}
                  <strong>{formatDayWithYear(existing.invoice_date)}</strong>.
                </span>
                <span className="mt-1 block text-sm text-muted">
                  <span className="money" style={{ textAlign: 'left' }}>
                    {formatCents(existing.amount_cents)}
                  </span>
                  {/*
                    No "entered by" and no reference, unlike the sheet the four
                    use. Both would have to come off the invoice row, which a
                    venue cannot read — and "entered by" would always say this
                    same shop anyway, so it identifies nobody.
                  */}
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

    /*
     * A venue account with no venue cannot happen — `profiles_staff_has_venue`
     * makes it unrepresentable in the database. This is here for the one case
     * that survives that: the profile query has not landed yet, and somebody
     * has tapped Save inside the first few hundred milliseconds.
     */
    if (venueId === '') {
      toast.show('Still loading your shop. Try that again in a second.', 'problem');
      return;
    }

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

    if (!supplier) return;

    /*
     * One payload builder for both paths — notes §1.3, and the reason it is
     * quoted twice in this file. Correcting reuses `created_by` from the
     * original because a venue may not reassign it (the `with check` requires
     * it to still be `auth.uid()` afterwards), and it is the same account
     * either way.
     */
    const id = editing?.id ?? crypto.randomUUID();
    const built = buildInvoicePayload(parsed.data, { actorId: profile.id, id });

    onClose();

    if (editing) {
      const { id: _id, created_by: _by, ...changes } = built;
      const corrected = await submitWrite(updateInvoice, {
        id: editing.id,
        payload: changes,
        supplierName: supplier.name,
      });

      if (corrected.kind === 'queued') {
        /*
         * Said plainly, because a queued correction can still be refused. The
         * five minutes is measured by the database against `created_at`, so an
         * edit made in a dead spot and sent twenty minutes later will not
         * apply — and promising otherwise is the one thing this app never does.
         */
        toast.show('Correction saved — it will send when you’re back online.', 'queued');
        return;
      }
      if (corrected.kind === 'failed') {
        toast.show(
          writeFailureMessage(
            corrected.error,
            'Couldn’t change that. The five minutes may have passed — ask head office.',
          ),
          'problem',
        );
        return;
      }
      toast.show(`Corrected · ${formatCents(built.amount_cents)} to ${supplier.name}`);
      return;
    }

    // Generated before sending, so a replayed offline write conflicts on the
    // primary key instead of creating a second invoice (notes §1.5).
    const payload = { ...built, id };

    const outcome = await submitWrite(createInvoice, {
      payload,
      supplierName: supplier.name,
    });

    /*
     * Three outcomes, three sentences — lib/offline/submit.ts has the account
     * of why this must not be a try/catch. The saved case cannot name the
     * reference the way the four's sheet does, because the write never asked
     * for the row back; it says the amount and the supplier instead, which is
     * what the person just typed and can check against the paper in their hand.
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

    toast.show(`Saved · ${formatCents(payload.amount_cents)} to ${supplier.name}`);
  }

  const busy = checking || createInvoice.isPending || updateInvoice.isPending;
  const fieldClass =
    'touch w-full rounded-sm border bg-card px-3 text-base text-ink outline-none focus:border-action';

  return (
    <>
      <Sheet
        open
        title={editing ? 'Correct invoice' : 'New invoice'}
        onClose={onClose}
        footer={
          <button
            type="button"
            onClick={() => save()}
            disabled={busy}
            className="touch w-full rounded-full bg-action px-4 text-base font-medium text-action-text disabled:opacity-40"
          >
            {busy ? 'Saving…' : editing ? 'Save correction' : 'Save invoice'}
          </button>
        }
      >
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
            htmlFor="venue-invoice-number"
          >
            Invoice number
          </label>
          <input
            id="venue-invoice-number"
            type="text"
            autoComplete="off"
            autoCapitalize="characters"
            placeholder="Optional"
            value={invoiceNumber}
            onChange={(event) => setInvoiceNumber(event.target.value)}
            className={`${fieldClass} border-hairline`}
          />
        </div>

        {/* type="text" with inputMode="decimal" — notes §4: type="number" brings
            spinners, changes value on scroll, and fights locale separators. */}
        <div className="mb-4">
          <label
            className="mb-1 block text-xs uppercase tracking-widest text-muted"
            htmlFor="venue-amount"
          >
            Amount
          </label>
          <div
            className={`flex items-center rounded-sm border bg-card ${errors.amount ? 'border-overdue' : 'border-hairline'}`}
          >
            <span className="money pl-3 text-base text-muted" style={{ textAlign: 'left' }}>
              $
            </span>
            <input
              id="venue-amount"
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

        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="mb-1 flex items-center justify-between gap-1.5">
              <label
                className="text-xs uppercase tracking-widest text-muted"
                htmlFor="venue-invoice-date"
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
              id="venue-invoice-date"
              type="date"
              value={invoiceDate}
              onChange={(event) => setInvoiceDate(event.target.value)}
              className={`figure-date ${fieldClass} border-hairline`}
            />
            <p className="figure-date mt-1 text-xs text-muted">{formatDay(invoiceDate)}</p>
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between gap-1.5">
              <label
                className="text-xs uppercase tracking-widest text-muted"
                htmlFor="venue-due-date"
              >
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
              id="venue-due-date"
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
        question={editing ? 'Save it anyway?' : 'Enter it anyway?'}
        confirmLabel={editing ? 'Save anyway' : 'Enter anyway'}
        onConfirm={() => {
          setWarnings(null);
          void save(true);
        }}
        onCancel={() => setWarnings(null)}
      />
    </>
  );
}
