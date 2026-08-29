import { z } from 'zod';
import { addDays, isDateStr, type DateStr } from './date';
import { MAX_AMOUNT_CENTS, parseAmountToCents } from './money';
import { DEFAULT_TERMS_DAYS } from './constants';
import type { Supplier } from './types';

/**
 * The add/edit invoice form: its shape, its validation, and the one function
 * that turns it into something the database will accept.
 *
 * ---------------------------------------------------------------------------
 * Notes §1.3, quoted because it is the entire reason this file exists:
 *
 *   "In the previous app the equivalent code built a copy of the record, and
 *   only wrote that copy back for *new* records — so every edit to an existing
 *   one was silently discarded and the old values were sent to the server. It
 *   looked like it saved. It even showed a success toast."
 *
 * So there is exactly one `buildInvoicePayload`. Creating calls it. Editing
 * calls it. There is no `if (isNew)` branch that writes in one arm and not the
 * other, because there is no branch at all — the only difference between the
 * two is that creating supplies an id, and that is the caller's job.
 * ---------------------------------------------------------------------------
 */

export const invoiceFormSchema = z.object({
  // Presence, not format. Whether these point at rows that exist is the
  // database's job — they are foreign keys, and it is the only thing that can
  // actually answer that. Checking UUID shape here would add no safety and
  // would report "choose a supplier" for something that is not that problem.
  business_id: z.string().min(1, 'Choose which business this is for.'),
  supplier_id: z.string().min(1, 'Choose a supplier.'),

  /** What was typed, not cents. Parsed once, here, by parseAmountToCents. */
  amount: z
    .string()
    .min(1, 'Enter the amount.')
    .refine((value) => parseAmountToCents(value) !== null, {
      message: 'That amount doesn’t look right. Use digits, like 5220.00',
    }),

  due_date: z.string().refine(isDateStr, 'Choose a due date.'),
  invoice_date: z.string().refine(isDateStr, 'Choose an invoice date.'),

  invoice_number: z.string().max(60, 'That invoice number is too long.').optional(),
  note: z.string().max(1000, 'That note is too long.').optional(),
});

export type InvoiceFormValues = z.infer<typeof invoiceFormSchema>;

/** Exactly the columns a client is allowed to write. */
export interface InvoiceWrite {
  id?: string;
  business_id: string;
  supplier_id: string;
  invoice_number: string | null;
  invoice_date: DateStr;
  due_date: DateStr;
  amount_cents: number;
  created_by: string;
}

/**
 * Form values -> database row. The single path for both create and edit.
 *
 * `internal_ref` is deliberately absent: it is stamped by a database trigger,
 * because two people entering at the same moment must not be able to collide
 * (notes §2). The client never invents one.
 */
export function buildInvoicePayload(
  values: InvoiceFormValues,
  context: { actorId: string; id?: string },
): InvoiceWrite {
  const amountCents = parseAmountToCents(values.amount);

  // The schema already rejected this, so reaching here means validation was
  // skipped. Throwing is right: silently writing a wrong number is how a
  // ledger stops being trustworthy.
  if (amountCents === null) {
    throw new Error(`buildInvoicePayload: unparseable amount ${JSON.stringify(values.amount)}`);
  }

  const invoiceNumber = values.invoice_number?.trim();

  return {
    ...(context.id ? { id: context.id } : {}),
    business_id: values.business_id,
    supplier_id: values.supplier_id,
    invoice_number: invoiceNumber ? invoiceNumber : null,
    invoice_date: values.invoice_date,
    due_date: values.due_date,
    amount_cents: amountCents,
    created_by: context.actorId,
  };
}

/* -------------------------------------------------------------------------- */

/**
 * The due date a supplier's terms imply.
 *
 * Counted from the INVOICE date, not from today. "14 day terms" is a fact
 * about the invoice — fourteen days from the date printed on it — and the two
 * only coincide when the docket arrives the day it was written. An invoice
 * that turns up three days late is already three days into its terms, and
 * counting from today would quietly give it three extra days to pay.
 *
 * Spec §7.3: the supplier's own term is what makes four taps enough for the
 * common case.
 */
export function defaultDueDate(supplier: Supplier | null, invoiceDate: DateStr): DateStr {
  return addDays(invoiceDate, supplier?.default_terms_days ?? DEFAULT_TERMS_DAYS);
}

/** Which of the +7 / +14 / +30 pills is currently the chosen one, if any. */
export function activePreset(
  dueDate: DateStr,
  invoiceDate: DateStr,
  presets: readonly number[],
): number | null {
  for (const days of presets) {
    if (addDays(invoiceDate, days) === dueDate) return days;
  }
  return null;
}

/**
 * Resolve the due date from whichever the person last expressed.
 *
 * Two ways to say it, and they behave differently when the invoice date moves:
 *
 *   a term  ("14 days", from a supplier or a preset) — follows the invoice
 *            date, because that is what a term means
 *   a date  (picked directly)                        — stays put, because a
 *            date someone typed is not a guess to be overruled
 */
export function resolveDueDate(options: {
  invoiceDate: DateStr;
  termDays: number | null;
  explicitDueDate: DateStr | null;
}): DateStr {
  if (options.explicitDueDate) return options.explicitDueDate;
  return addDays(options.invoiceDate, options.termDays ?? DEFAULT_TERMS_DAYS);
}

/**
 * Blank form, ready to type into.
 *
 * Notes §1.1: these are `defaultValues` handed to react-hook-form once, at
 * mount. Form state is never re-derived from query data on render, which is
 * what makes a background refetch unable to wipe what somebody has typed.
 */
export function emptyInvoiceForm(options: {
  today: DateStr;
  businessId: string;
}): InvoiceFormValues {
  return {
    business_id: options.businessId,
    supplier_id: '',
    amount: '',
    invoice_date: options.today,
    due_date: addDays(options.today, DEFAULT_TERMS_DAYS),
    invoice_number: '',
    note: '',
  };
}

export { MAX_AMOUNT_CENTS };
