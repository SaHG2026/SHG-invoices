import { describe, expect, it } from 'vitest';
import {
  activePreset,
  buildInvoicePayload,
  defaultDueDate,
  emptyInvoiceForm,
  invoiceFormSchema,
  resolveDueDate,
  type InvoiceFormValues,
} from '@/lib/invoice-form';
import { DEFAULT_TERMS_DAYS, DUE_PRESETS_DAYS } from '@/lib/constants';
import { SUPPLIERS } from '../fixtures/invoices';

const ACTOR = '2da43dcf-8b0f-4229-bf5c-e5af68210045';
const BUSINESS = 'b3153037-4bf5-4baa-8c11-b94e690c92bd';
const SUPPLIER = 'a207c7b2-5389-445a-a46e-bb3dd7b2caad';

function values(overrides: Partial<InvoiceFormValues> = {}): InvoiceFormValues {
  return {
    business_id: BUSINESS,
    supplier_id: SUPPLIER,
    amount: '5,220.00',
    invoice_date: '2026-08-28',
    due_date: '2026-09-11',
    invoice_number: 'INV-1234',
    note: '',
    ...overrides,
  };
}

describe('buildInvoicePayload — notes §1.3', () => {
  /**
   * "If you find yourself writing `if (isNew) { ...push }` with no matching
   * else, that's the bug."
   *
   * These assert the shape that makes that impossible: create and edit differ
   * only by whether an id is supplied, and every other field is produced by
   * the same code either way.
   */
  it('produces identical fields for create and for edit', () => {
    const created = buildInvoicePayload(values(), { actorId: ACTOR });
    const edited = buildInvoicePayload(values(), { actorId: ACTOR, id: 'existing-id' });

    const { id, ...editedRest } = edited;
    expect(id).toBe('existing-id');
    expect(editedRest).toEqual(created);
  });

  it('carries an edited amount through, rather than dropping it', () => {
    const before = buildInvoicePayload(values({ amount: '5,420.00' }), {
      actorId: ACTOR,
      id: 'x',
    });
    const after = buildInvoicePayload(values({ amount: '5,220.00' }), {
      actorId: ACTOR,
      id: 'x',
    });

    expect(before.amount_cents).toBe(542_000);
    expect(after.amount_cents).toBe(522_000);
  });

  it('omits id entirely when creating, so the database can generate one', () => {
    expect('id' in buildInvoicePayload(values(), { actorId: ACTOR })).toBe(false);
  });

  it('never sends internal_ref — the database stamps it', () => {
    const payload = buildInvoicePayload(values(), { actorId: ACTOR, id: 'x' });
    expect(payload).not.toHaveProperty('internal_ref');
    expect(payload).not.toHaveProperty('status');
    expect(payload).not.toHaveProperty('paid_at');
  });

  it('parses the amount to integer cents once, at this boundary', () => {
    expect(buildInvoicePayload(values({ amount: '5,220.00' }), { actorId: ACTOR }).amount_cents)
      .toBe(522_000);
    expect(buildInvoicePayload(values({ amount: '$0.05' }), { actorId: ACTOR }).amount_cents)
      .toBe(5);
  });

  it('turns an empty invoice number into null, not an empty string', () => {
    for (const blank of ['', '   ', undefined]) {
      expect(
        buildInvoicePayload(values({ invoice_number: blank }), { actorId: ACTOR }).invoice_number,
      ).toBeNull();
    }
    expect(
      buildInvoicePayload(values({ invoice_number: '  INV-9  ' }), { actorId: ACTOR })
        .invoice_number,
    ).toBe('INV-9');
  });

  it('throws rather than writing a wrong number if validation was skipped', () => {
    expect(() => buildInvoicePayload(values({ amount: 'abc' }), { actorId: ACTOR })).toThrow(
      /unparseable amount/,
    );
  });
});

describe('invoiceFormSchema', () => {
  it('accepts a normal invoice', () => {
    expect(invoiceFormSchema.safeParse(values()).success).toBe(true);
  });

  it('explains what to do rather than what went wrong — spec §8', () => {
    const result = invoiceFormSchema.safeParse(values({ amount: 'abc' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = result.error.issues[0]!.message;
      expect(message).toMatch(/5220\.00/);
      expect(message).not.toMatch(/invalid|error|failed/i);
    }
  });

  it('rejects amounts the database would refuse', () => {
    for (const amount of ['', '0', '0.00', '-5', '5.005', 'abc']) {
      expect(invoiceFormSchema.safeParse(values({ amount })).success).toBe(false);
    }
  });

  it('rejects a malformed or impossible date', () => {
    for (const date of ['', '28/08/2026', '2026-02-31', '2026-8-28']) {
      expect(invoiceFormSchema.safeParse(values({ due_date: date })).success).toBe(false);
    }
  });

  it('treats the invoice number and note as optional', () => {
    expect(
      invoiceFormSchema.safeParse(values({ invoice_number: '', note: '' })).success,
    ).toBe(true);
  });
});

describe('due dates', () => {
  const today = '2026-08-28';

  it('uses the supplier’s own terms when they have them', () => {
    const pfd = SUPPLIERS.find((s) => s.name === 'PFD Food Services')!;
    expect(pfd.default_terms_days).toBe(7);
    expect(defaultDueDate(pfd, today)).toBe('2026-09-04');

    const himalayan = SUPPLIERS.find((s) => s.name === 'Himalayan Wholesale')!;
    expect(himalayan.default_terms_days).toBe(30);
    expect(defaultDueDate(himalayan, today)).toBe('2026-09-27');
  });

  it('falls back to the shared default, not a literal', () => {
    const noTerms = SUPPLIERS.find((s) => s.default_terms_days === null)!;
    expect(defaultDueDate(noTerms, today)).toBe('2026-09-11');
    expect(defaultDueDate(null, today)).toBe('2026-09-11');
    // Notes §5: the 14 lives in one place and this proves the link.
    expect(DEFAULT_TERMS_DAYS).toBe(14);
  });

  it('highlights the preset matching the current due date', () => {
    expect(activePreset('2026-09-04', today, DUE_PRESETS_DAYS)).toBe(7);
    expect(activePreset('2026-09-11', today, DUE_PRESETS_DAYS)).toBe(14);
    expect(activePreset('2026-09-27', today, DUE_PRESETS_DAYS)).toBe(30);
    expect(activePreset('2026-09-15', today, DUE_PRESETS_DAYS)).toBeNull();
  });

  it('keeps the presets and the maths reading from one constant', () => {
    expect([...DUE_PRESETS_DAYS]).toEqual([7, 14, 30]);
  });
});

describe('terms count from the invoice date, not from today', () => {
  /**
   * "14 day terms" is a fact about the invoice — fourteen days from the date
   * printed on it. The two only coincide when the docket arrives the day it
   * was written. An invoice that turns up three days late is already three
   * days into its terms; counting from today would quietly hand it three
   * extra days to pay, on every late-arriving invoice, forever.
   */
  const pfd = SUPPLIERS.find((s) => s.name === 'PFD Food Services')!; // 7 days

  it('uses the invoice date as the starting point', () => {
    expect(defaultDueDate(pfd, '2026-08-25')).toBe('2026-09-01');
    expect(defaultDueDate(pfd, '2026-08-28')).toBe('2026-09-04');
  });

  it('does not give a late-arriving invoice extra days', () => {
    // Docket dated the 25th, entered on the 28th. Due the 1st, not the 4th.
    expect(defaultDueDate(pfd, '2026-08-25')).not.toBe(defaultDueDate(pfd, '2026-08-28'));
  });
});

describe('resolveDueDate', () => {
  it('follows the invoice date while it is expressed as a term', () => {
    expect(
      resolveDueDate({ invoiceDate: '2026-08-28', termDays: 14, explicitDueDate: null }),
    ).toBe('2026-09-11');
    // Move the invoice date; the due date moves with it.
    expect(
      resolveDueDate({ invoiceDate: '2026-08-25', termDays: 14, explicitDueDate: null }),
    ).toBe('2026-09-08');
  });

  it('leaves a date somebody typed exactly where they put it', () => {
    expect(
      resolveDueDate({ invoiceDate: '2026-08-28', termDays: 14, explicitDueDate: '2026-10-01' }),
    ).toBe('2026-10-01');
    expect(
      resolveDueDate({ invoiceDate: '2026-08-01', termDays: 7, explicitDueDate: '2026-10-01' }),
    ).toBe('2026-10-01');
  });

  it('falls back to the shared default when the supplier has no terms', () => {
    expect(
      resolveDueDate({ invoiceDate: '2026-08-28', termDays: null, explicitDueDate: null }),
    ).toBe('2026-09-11');
  });
});

describe('emptyInvoiceForm', () => {
  it('opens on today, with the default term already applied', () => {
    const form = emptyInvoiceForm({ today: '2026-08-28', businessId: BUSINESS });

    expect(form.invoice_date).toBe('2026-08-28');
    expect(form.due_date).toBe('2026-09-11');
    expect(form.business_id).toBe(BUSINESS);
    expect(form.supplier_id).toBe('');
    expect(form.amount).toBe('');
  });

  it('is a fresh object each time, so two sheets cannot share state', () => {
    const a = emptyInvoiceForm({ today: '2026-08-28', businessId: BUSINESS });
    const b = emptyInvoiceForm({ today: '2026-08-28', businessId: BUSINESS });
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});
