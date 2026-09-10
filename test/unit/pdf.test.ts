import { describe, expect, it } from 'vitest';
import { encodeWinAnsi, textWidth, wrapText } from '@/lib/pdf/text';
import { buildPdf, Page, PAGE_WIDTH } from '@/lib/pdf/writer';
import { invoiceFileName, renderInvoicePdf } from '@/lib/pdf/invoice';
import { readJpeg } from '@/lib/pdf/jpeg';
import { invoiceShareMessage, invoiceShareTitle } from '@/lib/pdf/message';
import { BASELINE_JPEG, GREYSCALE_JPEG, PROGRESSIVE_JPEG } from '../fixtures/jpeg';
import { BUSINESSES } from '../fixtures/invoices';
import { formatCents } from '@/lib/money';
import { formatDayInSentence } from '@/lib/date';
import type { SalesInvoice, SalesInvoiceLine, SalesInvoiceRow, SalesInvoiceAdjustment } from '@/lib/types';

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

const INVOICE: SalesInvoiceRow = {
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
  customer: { id: 'c-1', name: 'Harris Farm Markets' },
  /* J5. Empty on the base fixture so every existing assertion still
     describes an ordinary invoice; the adjustment cases add their own. */
  adjustments: [],
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

/** A discount or a refund, for the total-block cases. §53. */
function adj(over: Partial<SalesInvoiceAdjustment> = {}): SalesInvoiceAdjustment {
  return {
    id: 'adj-1',
    sales_invoice_id: 'si-1',
    kind: 'discount',
    amount_cents: 4_000,
    reason: 'short delivery',
    created_by: 'p-milan',
    created_at: '2026-09-01T02:00:00.000Z',
    voided_at: null,
    voided_by: null,
    void_reason: null,
    ...over,
  };
}

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
  it('names the customer without repeating their own phone number back at them', () => {
    // *"Probably receiver details not needed."* They are holding the document;
    // they know how to reach themselves. Still on the customer page.
    const { text } = render();
    expect(text).toContain('Harris Farm Markets');
    expect(text).not.toContain('jo@example.com');
    expect(text).not.toContain('02 9000 0000');
  });

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

  it('leaves one line to put a pen on, and only one', () => {
    /*
     * *"Only one signature line is plenty."* Three was a delivery docket's
     * habit -- Received by / Signature / Date is what a driver hands goods
     * over against -- and it spent a third of the page asking for one thing.
     */
    const { text } = render();
    expect(text).toContain('SIGNATURE');
    expect(text).not.toContain('RECEIVED BY');
    expect([...text.matchAll(/\(SIGNATURE\)/g)]).toHaveLength(1);
  });

  it('sets the signature beside the payment block, not under it', () => {
    /*
     * *"Parallel to the payment option on the left side of the page."*
     *
     * Two facts, and the second is the one worth pinning. The signature must
     * start in the right half of the page -- that is "beside". And the RULE
     * has to sit level with the FOOT of the bank details rather than with
     * their heading, which is what makes the two read as one row instead of
     * two things that happen to start together.
     *
     * Comparing the two LABELS would fail this design while it was working:
     * the signature's label is below its line, so it is ~60pt under the
     * PAYMENT heading by construction.
     *
     * PDF's origin is the bottom left, so a larger y is higher up the page.
     */
    const { text } = render();

    const signature = /1 0 0 1 ([\d.]+) ([\d.]+) Tm\n\(SIGNATURE\)/.exec(text)!;
    const signatureX = Number(signature[1]);
    expect(signatureX).toBeGreaterThan(PAGE_WIDTH / 2);

    // The lowest thing drawn in the left column: the last line of bank details.
    const leftColumn = [...text.matchAll(/1 0 0 1 45\.00 ([\d.]+) Tm/g)].map((m) =>
      Number(m[1]),
    );
    const payFoot = Math.min(...leftColumn);

    // The rule drawn in the right half of the page is the signature line.
    const signatureRule = [...text.matchAll(/([\d.]+) ([\d.]+) m\n([\d.]+) ([\d.]+) l/g)]
      .map((m) => ({ x: Number(m[1]), y: Number(m[2]) }))
      .filter((rule) => rule.x > PAGE_WIDTH / 2);

    expect(signatureRule).toHaveLength(1);
    expect(Math.abs(signatureRule[0]!.y - payFoot)).toBeLessThan(22);
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

  it('leaves one line to put a pen on, and only one', () => {
    /*
     * *"Only one signature line is plenty."* Three was a delivery docket's
     * habit -- Received by / Signature / Date is what a driver hands goods
     * over against -- and it spent a third of the page asking for one thing.
     */
    const { text } = render();
    expect(text).toContain('SIGNATURE');
    expect(text).not.toContain('RECEIVED BY');
    expect([...text.matchAll(/\(SIGNATURE\)/g)]).toHaveLength(1);
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
      expect(stream.includes('(SIGNATURE)')).toBe(last);
      // Headings repeat on every page, which is the other half of the fix.
      expect(stream.includes('(DESCRIPTION)')).toBe(true);
    }
  });
});

describe('the logo', () => {
  /*
   * ==========================================================================
   * §44.4 expected this to be the hard part and it was not.
   *
   * The plan assumed uploaded artwork is PNG -- embedding PNG means
   * implementing zlib, and the way around it was a canvas re-encode. Deli's
   * logo turned out to be a **baseline JPEG**, and a PDF embeds a JPEG as a
   * JPEG: filter `DCTDecode`, the file's own bytes, untouched.
   *
   * So nothing here decodes an image. All that is needed is the width, height
   * and channel count out of the SOF marker -- and the discipline to refuse
   * the two kinds of JPEG that would produce a broken page.
   * ==========================================================================
   */

  it('reads the size and colour out of a baseline JPEG', () => {
    expect(readJpeg(BASELINE_JPEG)).toEqual({ width: 120, height: 90, components: 3 });
    expect(readJpeg(GREYSCALE_JPEG)).toEqual({ width: 40, height: 40, components: 1 });
  });

  it('refuses a progressive JPEG rather than embedding a broken one', () => {
    /*
     * DCTDecode is baseline only. A progressive JPEG produces a file that
     * opens and shows a blank or corrupt image, which is worse than no logo --
     * an invoice that looks damaged rather than one that looks plain.
     */
    expect(readJpeg(PROGRESSIVE_JPEG)).toBeNull();
  });

  it('refuses anything that is not a usable JPEG at all', () => {
    // Every one of these is a real possibility -- a PNG in the bucket, a
    // truncated download, an empty response -- and all of them have to end the
    // same way, because a missing logo must never break an invoice.
    expect(readJpeg(new Uint8Array([]))).toBeNull();
    expect(readJpeg(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(readJpeg(BASELINE_JPEG.slice(0, 6))).toBeNull();
  });

  it('puts the bytes in untouched, as a DCTDecode stream', () => {
    const { bytes, text } = render({ logo: BASELINE_JPEG });

    expect(text).toContain('/Subtype /Image');
    expect(text).toContain('/Filter /DCTDecode');
    expect(text).toContain('/Width 120');
    expect(text).toContain('/Height 90');
    expect(text).toContain('/ColorSpace /DeviceRGB');

    /*
     * The bytes themselves, byte for byte, somewhere in the file. This is the
     * assertion that would have caught pushing a JPEG through `latin1Bytes`:
     * the two agree below 0x80 and disagree above it, so a corrupted image is
     * still a valid-looking PDF with a broken picture in it.
     */
    const haystack = Array.from(bytes).join(',');
    expect(haystack).toContain(Array.from(BASELINE_JPEG).join(','));
  });

  it('keeps the cross-reference table correct with an image in the file', () => {
    /*
     * The reason the image is a part of the object rather than a placeholder
     * spliced in afterwards. The xref is BYTE OFFSETS -- swapping a short
     * marker for a real image moves every object after it, and the file stops
     * opening. Same check as the text-only case, with the image present.
     */
    const { bytes, text } = render({ logo: BASELINE_JPEG });
    const table = /xref\n0 (\d+)\n([\s\S]*?)\ntrailer/.exec(text)!;
    const entries = table[2]!.trim().split('\n').slice(1);

    for (const [index, entry] of entries.entries()) {
      const offset = Number(entry.slice(0, 10));
      const here = new TextDecoder('latin1').decode(bytes.slice(offset, offset + 12));
      expect(here.startsWith(`${index + 1} 0 obj`)).toBe(true);
    }
  });

  it('names the image only on pages that can draw it', () => {
    expect(render({ logo: BASELINE_JPEG }).text).toContain('/XObject << /Logo');
    // No image, no XObject entry -- rather than an empty one pointing nowhere.
    expect(render().text).not.toContain('/XObject');
  });

  it('draws it as tall as the name and address beside it', () => {
    /*
     * *"Can we resize the logo to be bigger? Same height as the title name and
     * its address."*
     *
     * So the size is not a constant -- it is measured from the block it stands
     * next to, and a four-line address gets a taller mark than a two-line one.
     * That is what "same height as" means when the thing being matched varies,
     * and it is why this test renders two different addresses rather than
     * checking one number.
     *
     * The `cm` operator carries width and height, so both come back from it.
     */
    const heightOf = (contact: string | null) => {
      const text = render({
        logo: BASELINE_JPEG,
        business: { ...DELI, contact_block: contact },
      }).text;
      const cm = /q\n([\d.]+) 0 0 ([\d.]+) [\d.]+ [\d.]+ cm/.exec(text)!;
      return { width: Number(cm[1]), height: Number(cm[2]) };
    };

    /* Deli's own: three lines of address. 13pt of cap height plus 3 x 11. */
    const three = heightOf(DELI.contact_block);
    expect(three.height).toBeCloseTo(13 + 3 * 11, 1);

    const one = heightOf('12 Marsden St');
    expect(one.height).toBeLessThan(three.height);

    /* Aspect ratio survives all of it. A logo squashed to fit a box is
       somebody's brand printed wrong on a document they hand over. */
    for (const drawn of [three, one]) {
      expect(drawn.width / drawn.height).toBeCloseTo(120 / 90, 3);
    }
  });

  it('keeps a mark from becoming a postage stamp or a billboard', () => {
    // A business with no address at all would otherwise get a 13pt mark, and
    // one with a ten-line address a mark taller than the table under it.
    const sizeFor = (contact: string | null) => {
      const text = render({
        logo: BASELINE_JPEG,
        business: { ...DELI, contact_block: contact },
      }).text;
      return Number(/q\n[\d.]+ 0 0 ([\d.]+) [\d.]+ [\d.]+ cm/.exec(text)![1]);
    };

    expect(sizeFor(null)).toBeGreaterThanOrEqual(28);
    expect(sizeFor(Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n'))).toBeLessThanOrEqual(96);
  });

  it('lines the top of the mark up with the top of the letters', () => {
    /*
     * The bug the first render had, kept as a test: `image()` takes the TOP
     * edge and subtracts the height itself, and the call site added the height
     * as well -- so the mark sat a whole logo below the name. Every assertion
     * passed; a viewer showed it instantly.
     *
     * PDF y is measured up from the bottom of the page.
     */
    const { text } = render({ logo: BASELINE_JPEG });
    const cm = /q\n[\d.]+ 0 0 ([\d.]+) [\d.]+ ([\d.]+) cm/.exec(text)!;
    const top = Number(cm[2]) + Number(cm[1]);

    // The name's baseline is 59pt down the page and its caps rise 13pt above.
    expect(top).toBeCloseTo(841.89 - (59 - 13), 1);
  });

  it('moves the name across to make room, and back when there is none', () => {
    // *"Obviously the logo will be in front of the name and address."* With no
    // logo the name starts at the margin, rather than leaving a hole where a
    // picture will one day go.
    const withLogo = /1 0 0 1 ([\d.]+) [\d.]+ Tm\n\(Deli Delights\)/.exec(
      render({ logo: BASELINE_JPEG }).text,
    )!;
    const without = /1 0 0 1 ([\d.]+) [\d.]+ Tm\n\(Deli Delights\)/.exec(render().text)!;

    expect(Number(without[1])).toBeCloseTo(45, 1);
    expect(Number(withLogo[1])).toBeGreaterThan(Number(without[1]));
  });

  it('prints the invoice anyway when the logo cannot be used', () => {
    // The property that matters more than any of the above.
    const { text } = render({ logo: PROGRESSIVE_JPEG });
    expect(text).not.toContain('/DCTDecode');
    expect(text).toContain('DDL-0001');
    expect(text).toContain('Deli Delights');
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

describe('the message that travels with the file', () => {
  /*
   * ==========================================================================
   * Asked for: *"need to add auto generate message to attach: Dear customer,
   * please find the invoice for your ______ delivery."*
   *
   * `navigator.share({ files, title, text })` carries it -- Gmail puts `text`
   * in the body and `title` in the subject -- so this is a field on a call the
   * app was already making rather than a feature of its own, and it is a pure
   * function of the invoice with no state anywhere near it.
   *
   * It is a STARTING POINT, not a send. Gmail opens with it in the body and a
   * cursor in it. Nothing in this app sends anything.
   * ==========================================================================
   */
  const message = (over: Partial<SalesInvoice> = {}, business = DELI) =>
    invoiceShareMessage({ invoice: { ...INVOICE, ...over }, business });

  it('fills the blank with the invoice date', () => {
    /*
     * The blank was left blank on purpose and the client chose the date. It is
     * the one field that is always there, cannot be wrong, and is what a
     * customer matches against their own paperwork -- where a month would read
     * better for a regular customer and be wrong the moment there are two
     * deliveries in one.
     */
    expect(message()).toContain('Please find the invoice for your 5 Sep 2026 delivery.');
  });

  it('opens the way he wrote it', () => {
    expect(message().startsWith('Dear customer,')).toBe(true);
  });

  it('says who it is from and what it is for, so it can be filed unopened', () => {
    // An email saying only "please find the invoice" is one nobody can file
    // without opening the attachment.
    const text = message();
    expect(text).toContain('Deli Delights');
    expect(text).toContain('Invoice DDL-0001');
    expect(text).toContain(formatCents(INVOICE.amount_cents));
  });

  it('leaves no hole where an invoice number would be', () => {
    /*
     * An invoice created offline has no number until it sends (CATCH_UP_015
     * §3), and "Invoice  — $88.49" with a gap in it reads as broken. The parts
     * are assembled rather than templated, so the line is simply shorter.
     */
    const text = message({ invoice_number: null });
    expect(text).not.toContain('Invoice  ');
    expect(text).not.toMatch(/Invoice\s+—/);
    expect(text).toContain(formatCents(INVOICE.amount_cents));
  });

  it('survives a business the app cannot name', () => {
    const text = message({}, null as unknown as typeof DELI);
    expect(text).toContain('Dear customer,');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('null');
  });

  it('formats the date through lib/date.ts, without the weekday', () => {
    /*
     * Rule 2: dates are formatted in `lib/date.ts` and nowhere else. But in
     * prose the weekday is noise -- "your Sat 5 Sep 2026 delivery" -- so this
     * uses `formatDayInSentence`, the sibling of the document's formatter,
     * which lives in the same file for the same reason.
     */
    expect(message()).toContain(formatDayInSentence(INVOICE.invoice_date));
  });

  it('titles it with the number, for apps that show a subject', () => {
    expect(invoiceShareTitle(INVOICE)).toBe('Invoice DDL-0001');
    expect(invoiceShareTitle({ ...INVOICE, invoice_number: null })).toBe('Invoice');
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


describe('discounts and refunds on the paper', () => {
  /*
   * The PDF and the screen must not disagree. A customer can be holding this
   * while somebody reads the app, and a document is a claim about a moment —
   * §17's argument for a frozen line price, applied to the figure at the
   * bottom of the page.
   */

  it('says TOTAL and nothing else when nothing came off', () => {
    const { text } = render();
    expect(text).toContain('TOTAL');
    expect(text).not.toContain('TOTAL DUE');
    expect(text).not.toContain('INVOICED');
  });

  it('shows what was invoiced, what came off, and what is left', () => {
    const { text } = render({ invoice: { ...INVOICE, adjustments: [adj()] } });
    expect(text).toContain('INVOICED');
    expect(text).toContain('TOTAL DUE');
    expect(text).toContain('short delivery');
  });

  it('names the kind, so next year somebody knows which happened', () => {
    const { text } = render({
      invoice: { ...INVOICE, adjustments: [adj({ kind: 'refund', reason: 'two jars broken' })] },
    });
    expect(text).toContain('Refund');
    expect(text).toContain('two jars broken');
  });

  it('writes the minus as a hyphen, not the typographic one', () => {
    /*
     * §48.1: the standard-14 fonts are drawn through WinAnsiEncoding and
     * U+2212 is not in it. It would come out as `?` on the one line where a
     * wrong character changes what the number means.
     */
    const { text } = render({ invoice: { ...INVOICE, adjustments: [adj()] } });
    expect(text).toContain('-$40.00');
    expect(text).not.toContain('\u2212');
  });

  it('leaves a voided adjustment off the paper entirely', () => {
    // An invoice quoting a discount that was taken back is worse than one
    // that never mentioned it.
    const { text } = render({
      invoice: {
        ...INVOICE,
        adjustments: [adj({ voided_at: '2026-09-02T00:00:00.000Z', voided_by: 'p-mani' })],
      },
    });
    expect(text).not.toContain('short delivery');
    expect(text).not.toContain('TOTAL DUE');
  });
});

const PDF_OUT = process.env.PDF_OUT ?? '';

describe('preview', () => {
  it.skipIf(!PDF_OUT)('writes a real file', async () => {
    const { writeFileSync } = await import('node:fs');

    /*
     * Deli's ACTUAL logo, off the bucket, not a fixture.
     *
     * This is the file the app will embed, and the only thing that proves the
     * embedding works is a PDF reader drawing it. The fixtures above prove the
     * marker walk; a 295KB photograph proves the rest.
     */
    const { readFileSync } = await import('node:fs');
    let logo: Uint8Array | null = null;
    try {
      logo = new Uint8Array(readFileSync(process.env.PDF_LOGO ?? ''));
    } catch {
      logo = null;
    }

    writeFileSync(PDF_OUT, render({ logo }).bytes);

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
      render({ logo, lines: many, invoice: { ...INVOICE, note: 'Delivered to the back dock.' } })
        .bytes,
    );

    /* And the state the app actually shipped in: an address, no bank details. */
    writeFileSync(
      PDF_OUT.replace(/\.pdf$/, '-no-bank.pdf'),
      render({ logo, business: { ...DELI, bank_details: null } }).bytes,
    );

    /* J5's total block. The one thing bytes cannot answer is whether three
       figures stacked above a rule read as an argument rather than as a
       list — §53, and §48.3's rule that only a reader opening it proves it. */
    writeFileSync(
      PDF_OUT.replace(/\.pdf$/, '-adjusted.pdf'),
      render({
        logo,
        invoice: {
          ...INVOICE,
          adjustments: [
            adj(),
            adj({ id: 'adj-2', kind: 'refund', amount_cents: 1_250, reason: 'two jars broken in transit' }),
          ],
        },
      }).bytes,
    );
  });
});
