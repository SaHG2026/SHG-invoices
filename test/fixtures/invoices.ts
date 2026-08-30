/**
 * A deterministic 200-invoice fixture.
 *
 * Spec §9 quality floor asks for a 200-invoice list; notes §6 asks for a
 * render pass over realistic data. Same generator serves both, and it also
 * seeds the dev database, so what the tests exercise is what the phone shows.
 *
 * Deterministic on purpose: a failing test must reproduce. The PRNG below is
 * a mulberry32, seeded, so `makeInvoices(200)` is byte-identical every run.
 */

import { addDays, type DateStr } from '@/lib/date';
import type { Business, InvoiceRow, Profile, Supplier } from '@/lib/types';

/** The reference "today" the fixtures are built around. */
export const FIXTURE_TODAY: DateStr = '2026-08-28';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const BUSINESSES: Business[] = [
  { id: 'b-gmh', name: 'GroceryMate Hurstville', code: 'GMH', sort_order: 1, active: true },
  { id: 'b-gmp', name: 'GroceryMate Parramatta', code: 'GMP', sort_order: 2, active: true },
  { id: 'b-mjr', name: 'Majheri Restaurant', code: 'MJR', sort_order: 3, active: true },
  { id: 'b-ddl', name: 'Deli Delights', code: 'DDL', sort_order: 4, active: true },
];

export const PROFILES: Profile[] = [
  { id: 'p-mani', display_name: 'Mani', initials: 'MA', accent: 'person-2', role: 'owner', notify_on_new_invoice: true, active: true },
  { id: 'p-milan', display_name: 'Milan', initials: 'MI', accent: 'person-3', role: 'member', notify_on_new_invoice: false, active: true },
  { id: 'p-sujan', display_name: 'Sujan', initials: 'SU', accent: 'person-4', role: 'member', notify_on_new_invoice: false, active: true },
  { id: 'p-rabindra', display_name: 'Rabindra', initials: 'RA', accent: 'person-1', role: 'owner', notify_on_new_invoice: true, active: true },
];

const SUPPLIER_NAMES: ReadonlyArray<[string, number | null]> = [
  ['Bidfood', 14],
  ['Bidvest', 14],
  ['PFD Food Services', 7],
  ['Himalayan Wholesale', 30],
  ['Bhatbhateni Imports', 30],
  ['Coca-Cola Europacific', 14],
  ['Sydney Fresh Produce', 7],
  ['Riverina Meats', 14],
  ['Anchor Dairy', 21],
  ['Everest Spice Traders', 30],
  ['Southern Cross Packaging', null],
  ['Metro Cleaning Supplies', 14],
];

export const SUPPLIERS: Supplier[] = SUPPLIER_NAMES.map(([name, terms], i) => ({
  id: `s-${i}`,
  name,
  default_terms_days: terms,
  contact_name: null,
  contact_phone: null,
  notes: null,
  active: true,
}));

/**
 * `count` unpaid invoices spread from 12 days overdue to 45 days out, across
 * all four businesses, with deliberate supplier + due-date collisions so the
 * payment-run grouping has something real to group.
 */
export function makeInvoices(count = 200, seed = 20260828): InvoiceRow[] {
  const rand = mulberry32(seed);
  const rows: InvoiceRow[] = [];

  for (let i = 0; i < count; i++) {
    const business = BUSINESSES[i % BUSINESSES.length]!;
    // Skew supplier selection so a few majors recur often and the long tail is
    // occasional — that is both what a real supplier ledger looks like and what
    // creates the shared supplier + due date pairs that become payment runs.
    // The exponent is a gentle skew: roughly a quarter of invoices land on the
    // top supplier, rather than the two-thirds a `rand() * rand()` would give.
    const supplier = SUPPLIERS[Math.floor(rand() ** 1.7 * SUPPLIERS.length)]!;

    const dueOffset = Math.floor(rand() * 58) - 12; // -12 .. +45
    const dueDate = addDays(FIXTURE_TODAY, dueOffset);
    const terms = supplier.default_terms_days ?? 14;
    const invoiceDate = addDays(dueDate, -terms);

    const creator = PROFILES[Math.floor(rand() * PROFILES.length)]!;
    const amountCents = Math.floor(rand() * 900_000) + 1_500;

    rows.push({
      id: `i-${String(i).padStart(3, '0')}`,
      business_id: business.id,
      supplier_id: supplier.id,
      invoice_number: rand() > 0.15 ? `INV-${10_000 + i}` : null,
      internal_ref: `${business.code}-260828-${String((i % 99) + 1).padStart(2, '0')}`,
      invoice_date: invoiceDate,
      due_date: dueDate,
      amount_cents: amountCents,
      status: 'unpaid',
      paid_at: null,
      paid_by: null,
      payment_ref: null,
      void_reason: null,
      created_by: creator.id,
      created_at: `2026-08-${String(((i % 27) + 1)).padStart(2, '0')}T03:14:00.000Z`,
      updated_at: `2026-08-${String(((i % 27) + 1)).padStart(2, '0')}T03:14:00.000Z`,
      supplier: { id: supplier.id, name: supplier.name },
      business: { id: business.id, code: business.code, name: business.name },
    });
  }

  return rows;
}

/** One invoice, overridable field by field, for focused tests. */
export function makeInvoice(overrides: Partial<InvoiceRow> = {}): InvoiceRow {
  const base = makeInvoices(1)[0]!;
  return { ...base, ...overrides };
}
