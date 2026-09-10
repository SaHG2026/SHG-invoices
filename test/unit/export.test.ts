import { describe, expect, it } from 'vitest';
import { BOM, csvField, csvFile, csvRow, numeric } from '@/lib/csv';
import {
  billsTable,
  exportFilename,
  linesTable,
  nameLookup,
  renderTable,
  salesTable,
} from '@/lib/export/tables';
import { rangeIsUsable } from '@/lib/export/run';
import type { InvoiceRow, Profile, SalesInvoiceLine, SalesInvoiceRow } from '@/lib/types';

/**
 * J4's export, ARCHITECTURE §49.
 *
 * A CSV that is subtly wrong does not fail — it opens, and one column is off.
 * So the assertions here are mostly about the bytes: what is quoted, what is
 * escaped, what a spreadsheet will run instead of read, and whether an amount
 * arrives as a number or as text.
 */

describe('csvField', () => {
  it('leaves an ordinary value alone', () => {
    expect(csvField('Coles')).toBe('Coles');
    expect(csvField(42)).toBe('42');
  });

  it('is empty for null, not the word null', () => {
    expect(csvField(null)).toBe('');
  });

  it('quotes a comma, a quote and a newline, and doubles the quote', () => {
    expect(csvField('Smith, John')).toBe('"Smith, John"');
    expect(csvField('the 6" pan')).toBe('"the 6"" pan"');
    expect(csvField('one\ntwo')).toBe('"one\ntwo"');
    expect(csvField('one\r\ntwo')).toBe('"one\r\ntwo"');
  });

  it('quotes a value whose spaces would otherwise be trimmed away', () => {
    expect(csvField(' Coles')).toBe('" Coles"');
    expect(csvField('Coles ')).toBe('"Coles "');
  });

  /*
   * The guard is a leading TAB, inside quotes: invisible in the cell, and the
   * field still reads back as text through any RFC 4180 parser.
   */
  it('neutralises a value a spreadsheet would run', () => {
    expect(csvField('=1+1')).toBe('"\t=1+1"');
    expect(csvField('+SUM(A1)')).toBe('"\t+SUM(A1)"');
    expect(csvField('@import')).toBe('"\t@import"');
  });

  it('leaves a leading minus alone, because real data begins with one', () => {
    // Neutralising this would corrupt an ordinary note every day to prevent
    // something that has never happened.
    expect(csvField('-40, short delivery')).toBe('"-40, short delivery"');
    expect(csvField('-12.50')).toBe('-12.50');
  });

  it('writes a numeric cell bare, so a spreadsheet reads the column as numbers', () => {
    /*
     * The distinction is invisible in a CSV and is the whole of §50.2 in a
     * workbook: a text cell and a number cell look identical, and only one of
     * them can be added up.
     */
    expect(csvField(numeric('5220.00'))).toBe('5220.00');
    expect(csvField(numeric('-12.50'))).toBe('-12.50');
  });

  it('writes an unusable number as an empty cell rather than NaN', () => {
    expect(csvField(Number.NaN)).toBe('');
    expect(csvField(Number.POSITIVE_INFINITY)).toBe('');
  });
});

describe('csvFile', () => {
  it('begins with the byte-order mark, so Excel reads it as UTF-8', () => {
    const file = csvFile(['Name'], [['Ngô']]);
    expect(file.startsWith(BOM)).toBe(true);
    // The name survives exactly, which is the thing the PDF cannot do (§48.1).
    expect(file).toContain('Ngô');
  });

  it('uses CRLF and ends with a complete line', () => {
    const file = csvFile(['a', 'b'], [['1', '2'], ['3', '4']]);
    expect(file).toBe(`${BOM}a,b\r\n1,2\r\n3,4\r\n`);
  });

  it('writes a header and nothing else when there are no rows', () => {
    // An empty table is still a file. A missing file cannot be told apart from
    // a failed one.
    expect(csvFile(['a', 'b'], [])).toBe(`${BOM}a,b\r\n`);
  });
});

describe('csvRow', () => {
  it('joins fields with a comma', () => {
    expect(csvRow(['a', null, 3])).toBe('a,,3');
  });
});

/* -------------------------------------------------------------------------- */

const names = nameLookup([
  { id: 'p-mani', display_name: 'Mani' },
  { id: 'p-sujan', display_name: 'Sujan' },
] as Pick<Profile, 'id' | 'display_name'>[]);

function bill(overrides: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
    id: 'i-1',
    business_id: 'b-1',
    supplier_id: 's-1',
    invoice_number: 'INV-9',
    internal_ref: 'GMH-260828-03',
    invoice_date: '2026-08-28',
    due_date: '2026-09-11',
    amount_cents: 522_000,
    status: 'paid',
    paid_at: '2026-09-10T04:00:00.000Z',
    paid_by: 'p-mani',
    payment_ref: 'transfer 44',
    void_reason: null,
    approved_at: null,
    approved_by: null,
    created_by: 'p-sujan',
    created_at: '2026-08-28T02:00:00.000Z',
    updated_at: '2026-09-10T04:00:00.000Z',
    supplier: { id: 's-1', name: 'Coles' },
    business: { id: 'b-1', code: 'GMH', name: 'GroceryMate Hurstville' },
    ...overrides,
  };
}

describe('billsTable', () => {
  it('writes the amount as a number a spreadsheet can sum', () => {
    const csv = renderTable(billsTable([bill()], names));
    // No dollar sign and no thousands separator: both make Excel read the
    // column as text, and a column of text cannot be totalled.
    expect(csv).toContain(',5220.00,');
    expect(csv).not.toContain('$5,220.00');
  });

  it('names the people rather than printing their ids', () => {
    const csv = renderTable(billsTable([bill()], names));
    expect(csv).toContain('Mani');
    expect(csv).toContain('Sujan');
    expect(csv).not.toContain('p-mani');
  });

  it('falls back to the id when a name is missing, rather than to a blank', () => {
    // A profile row is never deleted, so this means the lookup was short — and
    // the id is what somebody can take to the database. A blank throws the
    // answer away.
    const csv = renderTable(billsTable([bill({ paid_by: 'p-ghost' })], names));
    expect(csv).toContain('p-ghost');
  });

  it('leaves an empty cell where nothing happened', () => {
    const csv = renderTable(billsTable([bill({ paid_at: null, paid_by: null })], names));
    const body = csv.split('\r\n')[1]!;
    expect(body).toContain(',,'); // paid on, paid by
    expect(body).not.toContain('null');
  });

  it('says awaiting review rather than unpaid for an unreviewed entry', () => {
    /*
     * The defect this fixes: `status` is `unpaid` for two different things --
     * a bill one of the four has accepted, and a shop's entry nobody has
     * looked at. The app never confuses them (`onlyOwed` is unpaid AND
     * approved), but the file wrote the raw word, so filtering Status=unpaid
     * in Excel gave a total the app itself refuses to show. Rule 4 broken at
     * the last step, in a file somebody keeps.
     */
    const csv = renderTable(
      billsTable(
        [bill({ status: 'unpaid', paid_at: null, paid_by: null, approved_at: null })],
        names,
      ),
    );
    expect(csv).toContain('awaiting review');
  });

  it('still says unpaid once it has been let into the ledger', () => {
    const csv = renderTable(
      billsTable(
        [
          bill({
            status: 'unpaid',
            paid_at: null,
            paid_by: null,
            approved_at: '2026-08-29T02:00:00.000Z',
            approved_by: 'p-mani',
          }),
        ],
        names,
      ),
    );
    expect(csv).toContain(',unpaid,');
    expect(csv).not.toContain('awaiting review');
  });

  it('includes voided invoices, and says so in the status column', () => {
    // The history SCREEN hides them; a file must not, or the record leaving
    // the app is quietly short.
    const csv = renderTable(
      billsTable(
        [bill({ status: 'void', paid_at: null, paid_by: null, void_reason: 'entered twice' })],
        names,
      ),
    );
    expect(csv).toContain('void');
    expect(csv).toContain('entered twice');
  });
});

/* -------------------------------------------------------------------------- */

function sale(overrides: Partial<SalesInvoiceRow> = {}): SalesInvoiceRow {
  return {
    id: 'sv-1',
    business_id: 'b-ddl',
    customer_id: 'c-1',
    invoice_number: 'DDL-0001',
    invoice_date: '2026-08-28',
    due_date: null,
    amount_cents: 12_000,
    status: 'outstanding',
    received_at: null,
    received_by: null,
    payment_ref: null,
    void_reason: null,
    note: null,
    created_by: 'p-mani',
    created_at: '2026-08-28T02:00:00.000Z',
    updated_at: '2026-08-28T02:00:00.000Z',
    customer: { id: 'c-1', name: 'The Corner Cafe' },
    adjustments: [],
    ...overrides,
  };
}

function line(overrides: Partial<SalesInvoiceLine> = {}): SalesInvoiceLine {
  return {
    id: 'l-1',
    sales_invoice_id: 'sv-1',
    position: 0,
    product_id: 'pr-1',
    description: 'Tomatoes',
    unit: 'kg',
    quantity_milli: 1_500,
    unit_price_cents: 800,
    line_total_cents: 1_200,
    ...overrides,
  };
}

describe('salesTable', () => {
  it('says received, never paid', () => {
    // §17's vocabulary: you do not pay an invoice you issued, and a shared
    // word is how two directions end up added together.
    const csv = renderTable(salesTable([sale()], names));
    expect(csv).toContain('Received on');
    expect(csv).not.toContain('Paid on');
  });

  it('leaves the due date empty when none was issued', () => {
    // An ordinary state, not a gap — CATCH_UP_017. An invented date would go
    // overdue on a day nobody agreed to.
    const csv = renderTable(salesTable([sale()], names));
    /* Amount, Adjustments and Net since J5 — the issued figure stays what
       the customer's copy says, and the net is what is owed. §53. */
    expect(csv.split('\r\n')[1]).toBe(
      'DDL-0001,The Corner Cafe,2026-08-28,,120.00,0.00,120.00,outstanding,,,,,Mani,2026-08-28,',
    );
  });
});

describe('linesTable', () => {
  it('repeats enough of the invoice for a line to stand alone', () => {
    const csv = renderTable(linesTable([sale()], [line()]));
    const body = csv.split('\r\n')[1]!;
    expect(body).toContain('DDL-0001');
    expect(body).toContain('The Corner Cafe');
  });

  it('counts lines from 1, because nobody reading a spreadsheet counts from 0', () => {
    const csv = renderTable(linesTable([sale()], [line({ position: 0 })]));
    expect(csv.split('\r\n')[1]).toContain(',1,Tomatoes,');
  });

  it('puts the lines of one invoice back in printed order', () => {
    const csv = renderTable(
      linesTable(
        [sale()],
        [
          line({ id: 'l-2', position: 1, description: 'Basil' }),
          line({ id: 'l-1', position: 0, description: 'Tomatoes' }),
        ],
      ),
    );
    expect(csv.indexOf('Tomatoes')).toBeLessThan(csv.indexOf('Basil'));
  });

  it('copies the line total rather than recomputing it', () => {
    // The database computes it (CATCH_UP_015 §4). A second multiplication here
    // would be a second answer, in the one place nobody would check it.
    const csv = renderTable(
      linesTable([sale()], [line({ quantity_milli: 3_000, line_total_cents: 999 })]),
    );
    expect(csv).toContain('9.99');
  });

  it('writes the quantity through lib/quantity, not as thousandths', () => {
    const csv = renderTable(linesTable([sale()], [line({ quantity_milli: 1_500 })]));
    expect(csv).toContain(',1.5,');
    expect(csv).not.toContain(',1500,');
  });
});

/* -------------------------------------------------------------------------- */

describe('exportFilename', () => {
  it('carries the period, so two files in a folder can be told apart', () => {
    expect(exportFilename('bills', '2026-07-01', '2026-07-31')).toBe(
      'shg-bills-2026-07-01_2026-07-31.csv',
    );
  });

  it('says everything rather than inventing a start date nobody chose', () => {
    // §40.1: a default is a claim.
    expect(exportFilename('bills', null, null)).toBe('shg-bills-everything.csv');
  });

  it('names the open end for what it is', () => {
    expect(exportFilename('bills', '2026-07-01', null)).toBe('shg-bills-2026-07-01_today.csv');
    expect(exportFilename('bills', null, '2026-07-31')).toBe('shg-bills-start_2026-07-31.csv');
  });
});

describe('rangeIsUsable', () => {
  it('accepts an unbounded range, and each end on its own', () => {
    expect(rangeIsUsable({ from: null, to: null })).toBe(true);
    expect(rangeIsUsable({ from: '2026-01-01', to: null })).toBe(true);
    expect(rangeIsUsable({ from: null, to: '2026-01-01' })).toBe(true);
  });

  it('accepts a single day', () => {
    expect(rangeIsUsable({ from: '2026-01-01', to: '2026-01-01' })).toBe(true);
  });

  it('refuses a backwards range rather than returning an empty file', () => {
    // An empty file reads as "there was no business that month", which is a
    // different and much worse answer than "those dates are the wrong way
    // round".
    expect(rangeIsUsable({ from: '2026-02-01', to: '2026-01-01' })).toBe(false);
  });

  it('refuses something that is not a date at all', () => {
    expect(rangeIsUsable({ from: '01/02/2026', to: null })).toBe(false);
  });
});
