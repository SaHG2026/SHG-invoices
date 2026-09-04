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

/**
 * `member`, `owner` and `builder` are not permissions. Those three have
 * identical access to every invoice, and `role` only decides what a screen
 * shows them.
 *
 * `staff` IS a permission, and it is the only one. CATCH_UP_010 took that
 * decision deliberately, against migration 005's standing warning that the
 * day role started deciding what somebody could read or write, it had to move
 * into a policy. It did move: `is_member()`, `staff_venue()` and the
 * `staff_invoices` view are where it lives now. Nothing in this file or any
 * component is the enforcement layer (notes §2).
 *
 * `builder` is Rabindra, who maintains the app and does not run the
 * businesses (ARCHITECTURE §28.2). It keeps him out of the lists of people and
 * out of every notification, and it changes nothing about his access — which
 * is exactly why it is here and not `active = false`: `is_member()` tests
 * `active`, so deactivating him would lock him out of the app he maintains.
 *
 * `staff` is a venue — GroceryMate Parramatta or Hurstville — not a person.
 * One shared login per shop, which is why `lib/staff.ts` exists and why the
 * attribution chip renders these differently.
 */
export type ProfileRole = 'member' | 'owner' | 'builder' | 'staff';

export interface Profile {
  id: string;
  display_name: string;
  initials: string;
  /**
   * Which person-accent slot this profile uses: 'person-1' .. 'person-4'.
   *
   * A slot name, not a colour. Colours live only in app/globals.css — storing
   * a hex here would put four of them outside the one file that is allowed to
   * contain any, and a repaint would silently miss the chips.
   */
  accent: string;
  role: ProfileRole;
  /**
   * The one field a person may change about themselves. Enforced by an RLS
   * policy (which row) plus a column-level grant (which field), because RLS
   * alone cannot restrict columns.
   */
  notify_on_new_invoice: boolean;
  active: boolean;
  /**
   * The venue a `staff` profile belongs to, and null for everybody else.
   *
   * The database will not let those two facts disagree: `profiles_staff_has_venue`
   * in CATCH_UP_010 requires staff to have one and forbids everyone else from
   * having one, so "staff with no venue" and "owner tied to Hurstville" are
   * both unrepresentable rather than merely unexpected.
   *
   * Not in the `self_update` column grant, so nobody can move themselves.
   */
  business_id: string | null;
}

/** One row per person per device. Written from Phase 7 onward. */
export interface PushSubscription {
  id: string;
  profile_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
  created_at: Timestamp;
  last_used_at: Timestamp | null;
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

/**
 * Somebody Deli Delights sells to. ARCHITECTURE §17.
 *
 * The mirror of Supplier, and deliberately a separate table rather than a
 * direction flag on the same one. §17 gives the reasoning in full; the short
 * version is that "what leaves the account this week" is the screen the whole
 * design is built around, and a direction flag would put a condition inside
 * every answer it gives.
 *
 * Note what is NOT here: an amount, a balance, or anything owing. This record
 * carries who a customer is and nothing about money, which is what makes it
 * impossible for a customer to show up in an owed or pending total. Sales
 * invoices and receipts are their own tables, in their own phase.
 */
export interface Customer {
  id: string;
  name: string;
  contact_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
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

/**
 * An invoice Deli Delights has SENT. ARCHITECTURE §17.
 *
 * The mirror of Invoice, in the other direction, and deliberately its own type
 * over its own table. Note the vocabulary: `received`, not `paid`. You do not
 * pay an invoice you issued, and a shared word is how two directions end up
 * sharing a code path.
 *
 * Nothing here is ever summed into what the group owes. That is not a rule
 * anybody has to keep — every owed and pending figure in the app is derived
 * from the `invoices` array, and these are not in it.
 */
export type SalesStatus = 'outstanding' | 'received' | 'void';

export interface SalesInvoice {
  id: string;
  business_id: string;
  customer_id: string;

  /** Ours — we issued it. */
  invoice_number: string | null;
  invoice_date: DateStr;
  due_date: DateStr;
  amount_cents: number;

  status: SalesStatus;
  received_at: Timestamp | null;
  received_by: string | null;
  payment_ref: string | null;
  void_reason: string | null;

  created_by: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** A sales invoice with its customer resolved, as the lists render it. */
export interface SalesInvoiceRow extends SalesInvoice {
  customer: Pick<Customer, 'id' | 'name'>;
}

/**
 * One row of `staff_invoices` — what a venue account is allowed to see.
 *
 * Deliberately NOT `Omit<Invoice, 'status' | ...>`. Derived-by-subtraction
 * would mean a column added to `Invoice` later arrives here silently, and the
 * whole point of this type is that its fields were chosen one at a time. If
 * `status`, `paid_at`, `paid_by` or `payment_ref` ever appear below, the view
 * has been changed and CATCH_UP_010 §3 has been undone.
 *
 * The supplier's name is joined in by the view rather than looked up here:
 * staff can read `suppliers`, but one round trip is one round trip.
 */
export interface StaffInvoice {
  id: string;
  business_id: string;
  supplier_id: string;
  supplier_name: string;
  invoice_number: string | null;
  internal_ref: string;
  invoice_date: DateStr;
  due_date: DateStr;
  amount_cents: number;
  created_at: Timestamp;
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

/* -------------------------------------------------------------------------- */

/** What the audit trigger records. Spec §5. */
export type ActivityAction = 'created' | 'edited' | 'paid' | 'unpaid' | 'voided';

export interface ActivityEntry {
  id: number;
  entity_type: string;
  entity_id: string;
  action: ActivityAction;
  actor_id: string;
  /**
   * Changed fields as `{ field: { from, to } }` for edits, or a snapshot of the
   * invoice for a creation. Written by the database trigger, never the client
   * — notes §2: "the client will forget".
   */
  detail: Record<string, unknown> | null;
  created_at: Timestamp;
}

export interface InvoiceNote {
  id: string;
  invoice_id: string;
  author_id: string;
  body: string;
  created_at: Timestamp;
}

/**
 * One entry in the invoice detail stream. Spec §7.6: notes and system events
 * in a single chronological stream, "distinguished by weight not by tabs".
 */
export type StreamItem =
  | { kind: 'activity'; at: Timestamp; actorId: string; entry: ActivityEntry }
  | { kind: 'note'; at: Timestamp; actorId: string; note: InvoiceNote };
