import { describe, expect, it } from 'vitest';
import { encodeWinAnsi, textWidth, wrapText } from '@/lib/pdf/text';
import { buildPdf, Page } from '@/lib/pdf/writer';
import { invoiceFileName, renderInvoicePdf } from '@/lib/pdf/invoice';
import { BUSINESSES } from '../fixtures/invoices';
import { formatCents } from '@/lib/money';
import type { SalesInvoice, SalesInvoiceLine } from '@/lib/types';

/**
 * The PDF writer. ARCHITECTURE §48.
 *
 * ===========================================================================
 * What is worth asserting about bytes nobody will read
 *
 * A PDF is not like the rest of this app: it has no DOM to query and its
 * failure mode is not a wrong-looking screen, it is **a file that will not
 * open at all**. So the tests split in two.
 *
 * The structural ones check the things that make it a valid file — the header,
 * the cross-reference offsets, the escaping — because every one of those has
 * exactly one correct answer and getting it wrong produces nothing a person
 * can look at and diagnose.
 *
 * The content ones read the uncompressed content stream as text, which is
 * possible only because nothing here is compressed. That is a deliberate
 * property of the writer and not an accident: a `FlateDecode` stream would
 * save a few kilobytes on a document that is already small, and cost the
 * ability to see what is in it.
 * ===========================================================================
 */

const DELI = BUSINESSES[3]!;

const INVOICE: SalesInvoice = {
  id: 'si-1',
  business_id: DELI.id,
  customer_id: 'c-1',
  invoice_number: 'DDL-0001',
  invoice_date: '2026-09-05',
  due_date: '2026-09-19',
  amount_cents: 8_849,
  status: 'outstanding',
  received_at: null,
  received_by: null,
  payment_ref: null,
  void_reason: null,
  note: null,
  created_by: 'p-mani',
  created_at: '2026-09-05T00:00:00Z',
  updated_at: '2026-09-05T00:00:00Z',
};

const LINES: SalesInvoiceLine[] = [
  {
    id: 'l-1', sales_invoice_id: 'si-1', position: 0, product_id: 'p-1',
    description: 'Momo (pork)', unit: 'box',
    quantity_milli: 3_000, unit_price_cents: 2_500, line_total_cents: 7_500,
  },
  {
    id: 'l-2', sales_invoice_id: 'si-1', position: 1, product_id: 'p-2',
    description: 'Achar', unit: 'jar',
    quantity_milli: 1_500, unit_price_cents: 899, line_total_cents: 1_349,
  },
];

const CUSTOMER = {
  name: 'Harris Farm Markets',
  contact_name: 'Jo',
  contact_phone: '02 9000 0000',
  contact_email: 'jo@example.com',
};

function render(over: Partial<Parameters<typeof renderInvoicePdf>[0]> = {}) {
  const result = renderInvoicePdf({
    invoice: INVOICE,
    lines: LINES,
    business: DELI,
    customer: CUSTOMER,
    ...over,
  });
  return { ...result, text: new TextDecoder('latin1').decode(result.bytes) };
}

describe('a file a viewer will actually open', () => {
  it('starts with a PDF header and ends with the end marker', () => {
    const { text } = render();
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
  });

  it('points startxref at the byte the xref table really begins on', () => {
    /*
     * The one thing in a PDF that cannot be eyeballed and breaks the whole
     * file when it is wrong. A viewer reads `startxref`, seeks to that byte,
     * and expects the word `xref` -- so this asserts exactly what the viewer
     * does, rather than that the number looks plausible.
     */
    const { bytes, text } = render();
    const startxref = Number(/startxref\n(\d+)/.exec(text)![1]);
    const atOffset = new TextDecoder('latin1').decode(bytes.slice(startxref, startxref + 4));
    expect(atOffset).toBe('xref');
  });

  it('gives every object an offset that lands on its own declaration', () => {
    // Same argument, for the object table: entry N must point at "N 0 obj".
    const { bytes, text } = render();
    const table = /xref\n0 (\d+)\n([\s\S]*?)\ntrailer/.exec(text)!;
    const entries = table[2]!.trim().split('\n').slice(1); // skip the free-list head

    for (const [index, entry] of entries.entries()) {
      const offset = Number(entry.slice(0, 10));
      const here = new TextDecoder('latin1').decode(bytes.slice(offset, offset + 12));
      expect(here.startsWith(`${index + 1} 0 obj`)).toBe(true);
    }
  });

  it('declares as many objects as it wrote', () => {
    const { text } = render();
    const size = Number(/\/Size (\d+)/.exec(text)![1]);
    const objects = [...text.matchAll(/^\d+ 0 obj$/gm)].length;
    expect(objects).toBe(size - 1);
  });

  it('states each stream’s real length', () => {
    /*
     * A `/Length` that disagrees with the bytes is the other silent
     * file-killer: viewers read exactly that many bytes and then expect
     * `endstream`.
     */
    const { text } = render();
    for (const match of text.matchAll(/<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/g)) {
      expect(match[2]!.length).toBe(Number(match[1]));
    }
  });
});

describe('text that would otherwise break the file', () => {
  it('escapes the three characters a PDF string cannot hold raw', () => {
    // "Smith (Wholesale)" is an ordinary supplier name, and an unescaped
    // bracket ends the string early -- which is a file that will not open.
    expect(encodeWinAnsi('Smith (Wholesale)').literal).toBe('Smith \\(Wholesale\\)');
    expect(encodeWinAnsi('a\\b').literal).toBe('a\\\\b');
  });

  it('keeps accented Latin, as an octal byte', () => {
    const { literal, lossy } = encodeWinAnsi('Café');
    expect(lossy).toBe(false);
    expect(literal).toBe('Caf\\351');
  });

  it('flattens the typography the app itself emits', () => {
    // Every one of these is written by this app's own formatters, so left
    // unmapped they would be question marks in the middle of our own sentence.
    expect(encodeWinAnsi('Couldn’t — a · b').literal).toBe("Couldn't - a - b");
    expect(encodeWinAnsi('Couldn’t').lossy).toBe(false);
  });

  it('says so when a character has no glyph at all', () => {
    /*
     * The limitation this file is honest about. The standard-14 fonts are
     * drawn through WinAnsiEncoding and Devanagari is not in it; embedding a
     * Unicode font is hundreds of KB on a phone on shop wifi, which is the
     * cost the write-it-yourself decision existed to avoid.
     *
     * So it substitutes AND reports, and the screen tells somebody, and Print
     * still renders the real thing. Silently drawing a wrong glyph would put a
     * customer's name wrongly on a document they keep.
     */
    const { literal, lossy } = encodeWinAnsi('नमस्ते');
    expect(lossy).toBe(true);
    expect(literal).toMatch(/^\?+$/);
  });

  it('carries that report all the way out to the caller', () => {
    const { lossy } = render({
      customer: { ...CUSTOMER, name: 'नमस्ते Grocers' },
    });
    expect(lossy).toBe(true);
    expect(render().lossy).toBe(false);
  });
});

describe('measuring, so a money column lines up', () => {
  it('knows Helvetica’s widths', () => {
    // 'iii' is the narrowest thing in the font and 'WWW' among the widest. A
    // table transcribed wrongly shows up here rather than as a column that is
    // subtly out on a customer's invoice.
    expect(textWidth('iii', 'Helvetica', 10)).toBeCloseTo(6.66, 2);
    expect(textWidth('WWW', 'Helvetica', 10)).toBeCloseTo(28.32, 2);
    expect(textWidth('$1,234.56', 'Helvetica', 10)).toBeGreaterThan(0);
  });

  it('measures the bold face differently from the regular one', () => {
    expect(textWidth('Total', 'Helvetica-Bold', 12)).toBeGreaterThan(
      textWidth('Total', 'Helvetica', 12),
    );
  });

  it('measures what will be drawn, not what was passed in', () => {
    // A name that became three question marks is three question marks wide.
    // Measuring the input would right-align against a width nothing occupies.
    expect(textWidth('नमस', 'Helvetica', 10)).toBeCloseTo(
      textWidth('???', 'Helvetica', 10),
      5,
    );
  });
});

describe('wrapping a description that does not fit its column', () => {
  it('breaks on spaces where it can', () => {
    const lines = wrapText('Sliced Swiss Brown Mushrooms crate', 'Helvetica', 9.5, 100);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(textWidth(line, 'Helvetica', 9.5)).toBeLessThanOrEqual(100);
  });

  it('breaks mid-word when it must', () => {
    /*
     * Not a nicety. A description is typed in a hurry, and
     * "Mushrooms/Portobello/Large-crate" is one word to a space-splitter --
     * which without this runs off the edge of the page, silently, on the one
     * document a customer keeps.
     */
    const lines = wrapText('Mushrooms/Portobello/Large-crate', 'Helvetica', 9.5, 60);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(textWidth(line, 'Helvetica', 9.5)).toBeLessThanOrEqual(60);
  });

  it('keeps the newlines somebody typed', () => {
    expect(wrapText('one\ntwo', 'Helvetica', 10, 500)).toEqual(['one', 'two']);
  });
});

describe('the invoice on the page', () => {
  it('carries the number, the customer, both dates and every line', () => {
    const { text } = render();
    for (const expected of [
      'DDL-0001',
      'Harris Farm Markets',
      'Momo \\(pork\\)',
      'Achar',
      '5 Sep 2026',
      '19 Sep 2026',
    ]) {
      expect(text).toContain(expected);
    }
  });

  it('totals what the lines add up to, using the app’s own formatter', () => {
    /*
     * The property that stops this drifting from the screen (notes §1.3):
     * both renderings run every figure through `formatCents`. If the total is
     * wrong here it is wrong there too, which is the failure worth having.
     */
    const { text } = render();
    expect(text).toContain(formatCents(7_500 + 1_349));
    expect(INVOICE.amount_cents).toBe(7_500 + 1_349);
  });

  it('prints who sent it and how to pay, live from the business row', () => {
    const { text } = render();
    expect(text).toContain('12 Marsden St');
    expect(text).toContain('PAYMENT');
    expect(text).toContain('BSB 062-000');
  });

  it('leaves no heading behind for a business that has set neither', () => {
    // The state three of the four businesses are in, and the state the app
    // shipped in for Deli's bank details. CATCH_UP_017's rule.
    const { text } = render({ business: BUSINESSES[0]! });
    expect(text).not.toContain('PAYMENT');
    expect(text).not.toContain('12 Marsden St');
    expect(text).toContain('DDL-0001');
  });

  it('prints no DUE heading when there is no due date', () => {
    const { text } = render({ invoice: { ...INVOICE, due_date: null } });
    expect(text).not.toContain('(DUE)');
    expect(text).toContain('(DATE)');
  });

  it('says so rather than printing an empty table with no lines', () => {
    const { text } = render({ lines: [] });
    expect(text).toContain('Recorded without a breakdown');
    expect(text).toContain(formatCents(INVOICE.amount_cents));
  });

  it('leaves somewhere to put a pen', () => {
    const { text } = render();
    for (const label of ['RECEIVED BY', 'SIGNATURE', 'DATE']) expect(text).toContain(label);
  });

  it('starts a second page rather than losing rows off the bottom', () => {
    /*
     * The worst failure this document has, and the only one that does not
     * look wrong: an invoice whose last rows fell off the page still prints a
     * total that includes them. The screen gets header repetition free from
     * the browser; here it has to be built.
     */
    const many: SalesInvoiceLine[] = Array.from({ length: 60 }, (_, index) => ({
      ...LINES[0]!,
      id: `l-${index}`,
      position: index,
      description: `Line item number ${index}`,
    }));

    const { text } = render({ lines: many });
    expect(/\/Count (\d+)/.exec(text)![1]).not.toBe('1');
    // Every row is on some page, and each page carries the column headings.
    expect(text).toContain('Line item number 59');
    expect([...text.matchAll(/DESCRIPTION/g)].length).toBeGreaterThan(1);
  });

  it('puts the total and the signature block on the LAST page, once', () => {
    /*
     * Which page they land on is the whole question, and the string being
     * present somewhere in the file does not answer it. A total stranded on
     * page one, above rows it does not include, is a document that is wrong
     * in the way nobody checks. A signature block on page one is somewhere
     * nobody will sign.
     *
     * Read per content stream, which is per page. Possible only because
     * nothing here is compressed.
     */
    const many: SalesInvoiceLine[] = Array.from({ length: 60 }, (_, index) => ({
      ...LINES[0]!,
      id: `l-${index}`,
      position: index,
      description: `Line item number ${index}`,
    }));

    const streams = [
      ...render({ lines: many }).text.matchAll(/stream\n([\s\S]*?)\nendstream/g),
    ].map((match) => match[1]!);

    expect(streams.length).toBeGreaterThan(1);
    for (const [index, stream] of streams.entries()) {
      const last = index === streams.length - 1;
      expect(stream.includes('(TOTAL)')).toBe(last);
      expect(stream.includes('RECEIVED BY')).toBe(last);
      // Headings repeat on every page, which is the other half of the fix.
      expect(stream.includes('(DESCRIPTION)')).toBe(true);
    }
  });
});

describe('what the file is called', () => {
  it('is the invoice number', () => {
    expect(invoiceFileName(INVOICE)).toBe('DDL-0001.pdf');
  });

  it('is never null.pdf', () => {
    // An invoice created offline has no number until it sends (CATCH_UP_015
    // §3), which is a real state rather than a defensive branch.
    expect(invoiceFileName({ ...INVOICE, invoice_number: null })).toBe('invoice-si-1.pdf');
  });
});

describe('the writer itself', () => {
  it('refuses to build a document with no pages', () => {
    expect(() => buildPdf([], 'x')).toThrow();
  });

  it('draws a rule where it was asked to', () => {
    const page = new Page();
    page.rule(10, 100, 20);
    // PDF's origin is the bottom left; 20 from the top of A4 is 821.89 up.
    expect(page.stream()).toContain('10.00 821.89 m');
  });
});

/* ------------------------------------------------------------------------ *
   Not a test. A way to open the thing in a real viewer.

   Everything above is this program checking its own arithmetic, and HANDOFF §6
   is exactly about that: a fence proven to keep things out has not been proven
   to have a gate. The only proof that this is a PDF is a PDF reader opening
   it. Skipped unless PDF_OUT is set, like the other preview harnesses.

     PDF_OUT=/tmp/shg/invoice.pdf npx vitest run test/unit/pdf.test.ts
 * ------------------------------------------------------------------------ */

const PDF_OUT = process.env.PDF_OUT ?? '';

describe('preview', () => {
  it.skipIf(!PDF_OUT)('writes a real file', async () => {
    const { writeFileSync } = await import('node:fs');

    writeFileSync(PDF_OUT, render().bytes);

    /* A long one too, because the page break is the part that cannot be
       checked by reading bytes: whether the second page LOOKS like a
       continuation is a question only a viewer answers. */
    const many: SalesInvoiceLine[] = Array.from({ length: 45 }, (_, index) => ({
      ...LINES[0]!,
      id: `l-${index}`,
      position: index,
      description:
        index % 7 === 0
          ? 'Sliced Swiss Brown Mushrooms, large crate, delivered to the back dock'
          : `Line item number ${index}`,
    }));
    writeFileSync(
      PDF_OUT.replace(/\.pdf$/, '-long.pdf'),
      render({ lines: many, invoice: { ...INVOICE, note: 'Delivered to the back dock.' } }).bytes,
    );

    /* And the state the app actually shipped in: an address, no bank details. */
    writeFileSync(
      PDF_OUT.replace(/\.pdf$/, '-no-bank.pdf'),
      render({ business: { ...DELI, bank_details: null } }).bytes,
    );
  });
});
