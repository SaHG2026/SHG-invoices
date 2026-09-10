/**
 * Domain types.
 *
 * These are hand-written and describe the shape the UI works with. Once the
 * Supabase project exists, `npm run db:types` generates `lib/db-types.ts`
 * from the live schema, and these are checked against it. Two files, but only
 * one source of truth: the database.
 */

import type { DateStr, TimeStr, Timestamp } from './date';

export type InvoiceStatus = 'unpaid' | 'paid' | 'void';

/**
 * `staff` is a permission. `owner` is now a second one, for exactly one thing.
 *
 * `manager`, `owner` and `builder` see the same invoices; what separates them
 * is that **only an owner may move a bill between paid and unpaid** (and only
 * an owner may change anybody's role). That is enforced inside four RPCs by
 * `is_owner()`, CATCH_UP_019 §5 — the app hides the buttons, the database
 * refuses the call, and the second one is the real boundary.
 *
 * `manager` is what `member` was called until CATCH_UP_019. Renamed rather
 * than joined by a fifth value: two names for one tier is the shape problem
 * this project keeps meeting.
 *
 * `staff` was the FIRST permission, and CATCH_UP_010 took that
 * decision deliberately, against migration 005's standing warning that the
 * day role started deciding what somebody could read or write, it had to move
 * into a policy. It did move: `is_manager_or_above()`, `staff_venue()` and the
 * `staff_invoices` view are where it lives now. Nothing in this file or any
 * component is the enforcement layer (notes §2).
 *
 * `builder` is Rabindra, who maintains the app and does not run the
 * businesses (ARCHITECTURE §28.2). It keeps him out of the lists of people and
 * out of every notification, and it changes nothing about his access — which
 * is exactly why it is here and not `active = false`: `is_manager_or_above()` tests
 * `active`, so deactivating him would lock him out of the app he maintains.
 *
 * `staff` is a venue — GroceryMate Parramatta or Hurstville — not a person.
 * One shared login per shop, which is why `lib/staff.ts` exists and why the
 * attribution chip renders these differently.
 */
/**
 * `assistant` is the fourth tier, CATCH_UP_022 and §52.
 *
 * A person who works across all four businesses, may LOG a bill, and may not
 * act on one: no review, no edit, no void, no paid/unpaid, no suppliers,
 * customers or products, and nothing of Deli's receivables.
 *
 * It is NOT `staff`, and the distinction is the reason it needed a new value.
 * `staff` is a venue and must have a `business_id`; an assistant is a person
 * and must not have one. One name for two tiers is the shape problem this
 * project keeps removing, inverted.
 *
 * Enforced by its own policies, never by this type. `is_assistant()` guards a
 * SELECT and an INSERT and nothing else, so there is no UPDATE policy an
 * assistant can reach — the absence is the tier.
 */
export type ProfileRole = 'manager' | 'owner' | 'builder' | 'staff' | 'assistant';

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
   * One of two fields a person may change about themselves. Enforced by an RLS
   * policy (which row) plus a column-level grant (which field), because RLS
   * alone cannot restrict columns.
   */
  notify_on_new_invoice: boolean;
  /**
   * A daily reminder to check today's invoices, at a Sydney wall-clock time.
   *
   * Null means off, and there is deliberately no separate enabled flag: a time
   * plus a boolean is two values describing three states when two are real,
   * and the pair can disagree. "On, at null o'clock" is a state somebody would
   * eventually write a branch for.
   *
   * In the column grant alongside `notify_on_new_invoice` (CATCH_UP_014 §1).
   * `reminder_last_sent_on` is not, and is not on this type either — it is the
   * job's bookkeeping, and a person who could clear it could make the reminder
   * send again.
   */
  reminder_time: TimeStr | null;
  /**
   * Job title, shown under the name in Settings. Null for the shops.
   *
   * Not derived from `role`, which cannot tell Milan from Sujan — both are
   * `member`, and `role` decides what a screen shows and what a policy allows,
   * not what somebody's job is.
   *
   * Not in the `self_update` grant either: a title is a fact about the company
   * and nobody appoints themselves.
   */
  title: string | null;
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
  /**
   * What goes on an invoice this business issues. CATCH_UP_020, §47.
   *
   * Free text, printed exactly as typed, newlines and all. Not street/suburb/
   * postcode and not BSB/account: an address is not the same shape in two
   * countries and a bank line is not the same shape in two banks, so a form of
   * named fields decides both on Deli's behalf and gets one of them wrong.
   *
   * Null means not set, and the document prints no heading at all for it —
   * a heading with nothing under it reads as something that failed to load
   * (the rule CATCH_UP_017 set for the missing due date). Only the database
   * can produce these, and `set_business_document` turns blank into null, so
   * '' and null cannot both mean empty.
   *
   * Read LIVE by the document rather than copied onto each invoice. §47.1 has
   * the argument: a price is a term that was agreed, a bank account is a
   * routing instruction, and reprinting an unpaid invoice must not name an
   * account that has closed.
   */
  contact_block: string | null;
  bank_details: string | null;
}

export interface Supplier {
  id: string;
  name: string;
  default_terms_days: number | null;
  contact_name: string | null;
  contact_phone: string | null;
  notes: string | null;
  active: boolean;
  /**
   * The single "Supplier not listed" row, and nothing else.
   *
   * A venue can no longer create a supplier (CATCH_UP_013 §5), so when a
   * delivery arrives from somebody not yet on the list it files the invoice
   * against this row and writes the real name in the note. Review picks those
   * up first and moving the invoice onto a real supplier is part of approving
   * it.
   *
   * A flag rather than a match on the name: a name is a string somebody can
   * edit, and renaming this row must not quietly turn it into an ordinary
   * supplier that four businesses start filing against.
   */
  is_placeholder: boolean;
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

  /**
   * When one of the four accepted this invoice into the ledger.
   *
   * Null means it is waiting for review, which happens only to invoices a
   * venue entered — `stamp_approval` approves everybody else's on insert, so
   * there is no path where one of the four's own entry arrives unapproved.
   *
   * Deliberately not a fourth value on `status`. That column means where the
   * money is; this is a different fact about the same row, and one enum
   * holding both would have twelve combinations where four are real.
   *
   * **Nothing unapproved reaches an owed total.** `onlyOwed` in
   * lib/derive/select.ts is the single place that rule lives.
   */
  approved_at: Timestamp | null;
  approved_by: string | null;

  created_by: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/**
 * Something Deli sells, and what it costs.
 *
 * Scoped to a business rather than global: the price of a thing is a fact
 * about who is selling it, and Majheri's idea of what a box of tomatoes costs
 * is not Deli's.
 */
export interface Product {
  id: string;
  business_id: string;
  name: string;
  /** 'kg', 'each', 'box' — free text, because a unit is whatever it says. */
  unit: string | null;
  unit_price_cents: number;
  active: boolean;
}

/**
 * One line of an invoice Deli has issued.
 *
 * ---------------------------------------------------------------------------
 * The description and the price are COPIES, and that is the whole design.
 *
 * The obvious schema is a product id and a quantity. Raise a product's price
 * next month and every invoice printed last month silently reprints at the new
 * one — a piece of paper somebody is holding would stop agreeing with your
 * copy of it. A printed invoice is a claim about a moment.
 *
 * `product_id` is kept only to answer "which product was this", and is null
 * for a one-off line that is not a product at all.
 * ---------------------------------------------------------------------------
 *
 * `quantity_milli` is integer thousandths, for the reason rule 6 makes money
 * integer cents. 1.5 kg is 1500. `lib/quantity.ts` is the only thing that
 * parses or formats it.
 */
export interface SalesInvoiceLine {
  id: string;
  sales_invoice_id: string;
  /** Order on the page, from 0. Unique per invoice. */
  position: number;
  product_id: string | null;
  description: string;
  unit: string | null;
  quantity_milli: number;
  unit_price_cents: number;
  /** Computed by the database, never by the client. CATCH_UP_015 §4. */
  line_total_cents: number;
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
  /**
   * Null when none was issued, and that is an ordinary state.
   *
   * Deli issues invoices before it has agreed terms with anybody, so the
   * compose screen offers a due date behind a switch that is off (CATCH_UP_017).
   * An invented due date is worse than none: it would go overdue on a day
   * nobody agreed to, and drive the chasing from a number that means nothing.
   *
   * Nullable here rather than guarded at each call site, so `tsc` finds every
   * place that assumed a date -- the same device that fixed the compose screen
   * crash in §39.8. The payables side stays NOT NULL: a bill sent to US always
   * has a date on it.
   */
  due_date: DateStr | null;
  amount_cents: number;

  status: SalesStatus;
  received_at: Timestamp | null;
  received_by: string | null;
  payment_ref: string | null;
  void_reason: string | null;

  /**
   * A column, not a second notes table.
   *
   * A payables invoice is something several people talk about over a
   * fortnight, which is what `invoice_notes` is for. A sales invoice is a
   * document you issue once, and giving it a thread would be symmetry for its
   * own sake.
   */
  note: string | null;

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
  /**
   * Whether THIS account entered it — CATCH_UP_018.
   *
   * A boolean, not `created_by`. The question a shop screen has is "may I
   * offer Edit on this row", and `created_by` would answer it by handing over
   * the user id of whichever of the four entered each invoice. The comparison
   * happens in the view, where the answer is already known.
   *
   * Required, not optional. An optional flag would be `undefined` wherever
   * somebody forgot to select it, and `undefined` is falsy — so the button
   * would silently stop being offered on rows a shop CAN edit, which is the
   * same defect this fixes pointing the other way.
   */
  is_mine: boolean;
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
export type ActivityAction =
  | 'created'
  | 'edited'
  | 'paid'
  | 'unpaid'
  | 'voided'
  /**
   * One of the four let a venue's invoice into the ledger.
   *
   * A named action rather than an 'edited' with a diff, because "who let this
   * in" is the thing people will look up, and the audit trigger discards an
   * edit whose tracked fields did not move — which an approval's never do.
   */
  | 'approved';

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
