/**
 * Domain types.
 *
 * These are hand-written and describe the shape the UI works with. Once the
 * Supabase project exists, `npm run db:types` generates `lib/db-types.ts`
 * from the live schema, and these are checked against it. Two files, but only
 * one source of truth: the database.
 */

import type { DateStr, Timestamp } from './date';

export type InvoiceStatus = 'unpaid' | 'paid' | 'void';

export interface Profile {
  id: string;
  display_name: string;
  initials: string;
  /** Hex, for the attribution chip. Mani gold, Milan slate, Sujan chilli. */
  accent: string;
  active: boolean;
}

export interface Business {
  id: string;
  name: string;
  /** 'GMH' | 'GMP' | 'MJR' | 'DDL' — used in internal refs. */
  code: string;
  sort_order: number;
  active: boolean;
}

export interface Supplier {
  id: string;
  name: string;
  default_terms_days: number | null;
  contact_name: string | null;
  contact_phone: string | null;
  notes: string | null;
  active: boolean;
}

export interface Invoice {
  id: string;
  business_id: string;
  supplier_id: string;

  invoice_number: string | null;
  /** Always generated server-side, e.g. 'GMH-260828-03'. */
  internal_ref: string;
  invoice_date: DateStr;
  due_date: DateStr;
  amount_cents: number;

  status: InvoiceStatus;
  paid_at: Timestamp | null;
  paid_by: string | null;
  payment_ref: string | null;
  void_reason: string | null;

  created_by: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** An invoice with its supplier and business resolved, as the lists render it. */
export interface InvoiceRow extends Invoice {
  supplier: Pick<Supplier, 'id' | 'name'>;
  business: Pick<Business, 'id' | 'code' | 'name'>;
}

/**
 * Spec §6: unpaid invoices sharing a supplier AND a due date collapse into
 * one row, because that is how they will actually be paid — one transfer.
 */
export interface PaymentRun {
  /** Stable key: `${supplier_id}:${due_date}`. */
  key: string;
  supplier: Pick<Supplier, 'id' | 'name'>;
  due_date: DateStr;
  invoices: InvoiceRow[];
  total_cents: number;
}
