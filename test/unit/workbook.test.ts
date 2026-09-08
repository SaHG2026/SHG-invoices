import { describe, expect, it } from 'vitest';
import { crc32, zip } from '@/lib/zip';
import { columnName, sheetName, xlsx } from '@/lib/xlsx';
import { numeric } from '@/lib/csv';

/**
 * The zip and the workbook. ARCHITECTURE §50.1, §50.2.
 *
 * ---------------------------------------------------------------------------
 * These assertions are the program checking its own arithmetic.
 *
 * §48.3 said it about the PDF and it is true again here: nothing below proves
 * Excel opens the file. What they prove is that the bytes say what this code
 * meant them to say — the signatures are where a reader looks for them, the
 * checksums are right, the parts a workbook must have are present, and a money
 * cell is a number rather than text.
 *
 * The other half is `WORKBOOK_OUT`, at the bottom, which writes real files for
 * a real spreadsheet to open. **The only proof an .xlsx is an .xlsx is a
 * reader opening it.**
 * ---------------------------------------------------------------------------
 */

const utf8 = new TextEncoder();

/** Little-endian, like everything in a zip. */
function u32(bytes: Uint8Array, at: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset).getUint32(at, true);
}
function u16(bytes: Uint8Array, at: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset).getUint16(at, true);
}

describe('crc32', () => {
  it('agrees with the known value for "123456789"', () => {
    // The standard check value for CRC-32/ISO-HDLC. If this is wrong every
    // archive this app writes is corrupt, and the reader's message will blame
    // the workbook rather than the checksum.
    expect(crc32(utf8.encode('123456789'))).toBe(0xcbf43926);
  });

  it('is zero for nothing', () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe('zip', () => {
  const archive = zip([
    { name: 'a.txt', bytes: utf8.encode('hello') },
    { name: 'folder/b.txt', bytes: utf8.encode('world!') },
  ]);

  it('starts with a local file header and ends with the central directory', () => {
    expect(u32(archive, 0)).toBe(0x04034b50);
    expect(u32(archive, archive.length - 22)).toBe(0x06054b50);
  });

  it('stores rather than compresses, which is why no zlib is involved', () => {
    expect(u16(archive, 8)).toBe(0); // method 0
    // Compressed and uncompressed sizes are equal, and equal to the content.
    expect(u32(archive, 18)).toBe(5);
    expect(u32(archive, 22)).toBe(5);
  });

  it('counts its entries in the end record', () => {
    expect(u16(archive, archive.length - 22 + 8)).toBe(2);
    expect(u16(archive, archive.length - 22 + 10)).toBe(2);
  });

  it('points the central directory at where the data ends', () => {
    const size = u32(archive, archive.length - 22 + 12);
    const offset = u32(archive, archive.length - 22 + 16);
    expect(offset + size + 22).toBe(archive.length);
    expect(u32(archive, offset)).toBe(0x02014b50);
  });

  it('carries the checksum of each entry', () => {
    expect(u32(archive, 14)).toBe(crc32(utf8.encode('hello')));
  });

  it('is byte-identical for identical content', () => {
    /*
     * Because the timestamp is a constant, not a clock — rule 2 keeps
     * `new Date()` inside lib/date.ts, and the useful date on an export is in
     * its filename. Determinism is the side effect that lets a test assert on
     * bytes at all.
     */
    const again = zip([
      { name: 'a.txt', bytes: utf8.encode('hello') },
      { name: 'folder/b.txt', bytes: utf8.encode('world!') },
    ]);
    expect(Array.from(again)).toEqual(Array.from(archive));
  });

  it('writes an empty archive rather than throwing', () => {
    const empty = zip([]);
    expect(empty.length).toBe(22);
    expect(u32(empty, 0)).toBe(0x06054b50);
  });
});

/* -------------------------------------------------------------------------- */

describe('columnName', () => {
  it('counts the way a spreadsheet does', () => {
    expect(columnName(0)).toBe('A');
    expect(columnName(25)).toBe('Z');
    // The one every hand-written implementation gets wrong. It is not base 26.
    expect(columnName(26)).toBe('AA');
    expect(columnName(51)).toBe('AZ');
    expect(columnName(52)).toBe('BA');
    expect(columnName(701)).toBe('ZZ');
    expect(columnName(702)).toBe('AAA');
  });
});

describe('sheetName', () => {
  it('leaves an ordinary name alone', () => {
    expect(sheetName('Bills')).toBe('Bills');
    // An apostrophe is legal, and these tabs have one.
    expect(sheetName('Deli’s invoices')).toBe('Deli’s invoices');
  });

  it('removes what Excel refuses, rather than letting the file fail', () => {
    // Excel does not report a bad sheet name — it refuses the workbook, with
    // nothing pointing at the name.
    expect(sheetName('2026/07 [draft]')).toBe('2026 07  draft');
    expect(sheetName('a:b\\c?d*e')).toBe('a b c d e');
  });

  it('never produces a blank name', () => {
    expect(sheetName('///')).toBe('Sheet');
    expect(sheetName('   ')).toBe('Sheet');
  });

  it('cuts at 31 characters, which is the format’s limit', () => {
    expect(sheetName('x'.repeat(40))).toHaveLength(31);
  });
});

/* -------------------------------------------------------------------------- */

/** Pull one stored entry back out, by name. */
function entryOf(archive: Uint8Array, name: string): string {
  const decoder = new TextDecoder();
  let at = 0;
  while (u32(archive, at) === 0x04034b50) {
    const size = u32(archive, 18 + at);
    const nameLength = u16(archive, 26 + at);
    const extraLength = u16(archive, 28 + at);
    const start = at + 30 + nameLength + extraLength;
    const found = decoder.decode(archive.subarray(at + 30, at + 30 + nameLength));
    if (found === name) return decoder.decode(archive.subarray(start, start + size));
    at = start + size;
  }
  throw new Error(`no entry called ${name}`);
}

describe('xlsx', () => {
  const book = xlsx([
    {
      name: 'Bills',
      header: ['Supplier', 'Amount', 'Status'],
      rows: [
        ['Coles', numeric('5220.00'), 'paid'],
        ['Smith & Sons <Pty>', numeric('12.50'), 'awaiting review'],
        ['Ngô Produce', null, 'void'],
      ],
    },
    { name: 'Deli’s invoices', header: ['Number'], rows: [] },
  ]);

  it('contains every part Excel requires', () => {
    /*
     * A workbook missing any of these opens as "we found a problem with some
     * content", which reads as a broken export rather than as a malformed
     * container. `styles.xml` is the one that looks optional and is not.
     */
    for (const part of [
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/worksheets/sheet1.xml',
      'xl/worksheets/sheet2.xml',
    ]) {
      expect(() => entryOf(book, part)).not.toThrow();
    }
  });

  it('names every sheet, in order', () => {
    const workbook = entryOf(book, 'xl/workbook.xml');
    expect(workbook).toContain('name="Bills"');
    expect(workbook).toContain('name="Deli’s invoices"');
    expect(workbook.indexOf('Bills')).toBeLessThan(workbook.indexOf('Deli’s invoices'));
  });

  it('ties each sheet name to the part that holds it', () => {
    // Three files have to agree: workbook.xml names an r:id, the rels file
    // maps it to a path, and [Content_Types] declares what is at that path.
    const rels = entryOf(book, 'xl/_rels/workbook.xml.rels');
    expect(rels).toContain('Id="rId1"');
    expect(rels).toContain('Target="worksheets/sheet1.xml"');
    expect(rels).toContain('Target="styles.xml"');
    expect(entryOf(book, '[Content_Types].xml')).toContain('/xl/worksheets/sheet2.xml');
  });

  it('writes money as a number, not as text', () => {
    /*
     * The whole reason `NumberCell` exists. A text cell and a number cell look
     * identical on screen, and only one of them can be added up — which is the
     * one thing the export is for.
     */
    const sheet = entryOf(book, 'xl/worksheets/sheet1.xml');
    expect(sheet).toContain('<v>5220.00</v>');
    expect(sheet).not.toContain('<is><t xml:space="preserve">5220.00</t></is>');
  });

  it('writes text as an inline string', () => {
    expect(entryOf(book, 'xl/worksheets/sheet1.xml')).toContain(
      '<c r="A2" t="inlineStr"><is><t xml:space="preserve">Coles</t></is></c>',
    );
  });

  it('escapes what would otherwise close a tag', () => {
    // `&` and `<` in a supplier name would make the sheet malformed XML, and
    // Excel refuses the whole workbook rather than the cell.
    const sheet = entryOf(book, 'xl/worksheets/sheet1.xml');
    expect(sheet).toContain('Smith &amp; Sons &lt;Pty&gt;');
    expect(sheet).not.toContain('Smith & Sons <Pty>');
  });

  it('carries a name the PDF cannot draw', () => {
    // §48.1: the standard-14 fonts turn this into `?`. A workbook has no fonts
    // in it, so it carries any name the phone can type.
    expect(entryOf(book, 'xl/worksheets/sheet1.xml')).toContain('Ngô Produce');
  });

  it('writes no cell at all where there is no value', () => {
    // An empty cell, not the text "null". A sheet omits the cell entirely.
    const sheet = entryOf(book, 'xl/worksheets/sheet1.xml');
    expect(sheet).not.toContain('null');
    expect(sheet).toContain('<row r="4">');
  });

  it('strips a control character rather than losing the workbook', () => {
    /*
     * XML 1.0 forbids most of C0, and one stray byte in one note makes Excel
     * refuse the WHOLE file. That byte arrives from somebody's phone keyboard
     * months from now, and the failure looks nothing like its cause.
     */
    const withJunk = xlsx([
      { name: 'S', header: ['A'], rows: [[`before\u0007after`]] },
    ]);
    const sheet = entryOf(withJunk, 'xl/worksheets/sheet1.xml');
    expect(sheet).toContain('beforeafter');
    expect(sheet).not.toContain('\u0007');
  });

  it('keeps the newlines inside a note', () => {
    // Legal in XML, and a note typed across two lines should read across two.
    const withBreak = xlsx([{ name: 'S', header: ['A'], rows: [['one\ntwo']] }]);
    expect(entryOf(withBreak, 'xl/worksheets/sheet1.xml')).toContain('one\ntwo');
  });

  it('still writes a sheet for a table with no rows', () => {
    // A missing sheet cannot be told apart from a failed one.
    const sheet = entryOf(book, 'xl/worksheets/sheet2.xml');
    expect(sheet).toContain('Number');
    expect(sheet).toContain('<row r="1">');
    expect(sheet).not.toContain('<row r="2">');
  });

  it('freezes the header row', () => {
    // Hundreds of rows, and headings that scroll away are how somebody reads
    // the wrong column.
    expect(entryOf(book, 'xl/worksheets/sheet1.xml')).toContain('state="frozen"');
  });

  it('will not produce two tabs with the same name', () => {
    // Excel refuses that workbook, and refuses it as a container error.
    const clash = xlsx([
      { name: 'Bills', header: ['A'], rows: [] },
      { name: 'Bills', header: ['A'], rows: [] },
    ]);
    const workbook = entryOf(clash, 'xl/workbook.xml');
    expect(workbook).toContain('name="Bills"');
    expect(workbook).toContain('name="Bills 2"');
  });
});

/* -------------------------------------------------------------------------- *
 * Real files, for a real spreadsheet to open.
 *
 * Everything above is the program checking its own arithmetic. §48.3's rule
 * for the PDF applies here word for word: the only proof an .xlsx is an .xlsx
 * is a reader opening it.
 *
 *   WORKBOOK_OUT=/tmp/shg npx vitest run test/unit/workbook.test.ts
 * -------------------------------------------------------------------------- */

const OUT = process.env.WORKBOOK_OUT ?? '';

describe('a workbook you can open', () => {
  it.skipIf(!OUT)('writes one', async () => {
    const { writeFileSync } = await import('node:fs');

    const bytes = xlsx([
      {
        name: 'Bills',
        header: ['Reference', 'Supplier', 'Invoice date', 'Amount', 'Status'],
        rows: [
          ['GMH-260828-03', 'Coles', '2026-08-28', numeric('5220.00'), 'paid'],
          ['GMP-260829-01', 'Smith & Sons', '2026-08-29', numeric('118.40'), 'unpaid'],
          ['GMP-260830-02', 'Ngô Produce', '2026-08-30', numeric('64.05'), 'awaiting review'],
        ],
      },
      {
        name: 'Deli’s invoices',
        header: ['Invoice number', 'Customer', 'Invoice date', 'Amount', 'Status'],
        rows: [['DDL-0001', 'The Corner Cafe', '2026-08-28', numeric('120.00'), 'outstanding']],
      },
      {
        name: 'Deli’s invoice lines',
        header: ['Invoice number', 'Line', 'Description', 'Quantity', 'Unit price', 'Line total'],
        rows: [
          ['DDL-0001', 1, 'Tomatoes', numeric('1.5'), numeric('8.00'), numeric('12.00')],
          ['DDL-0001', 2, 'Basil', numeric('2'), numeric('54.00'), numeric('108.00')],
        ],
      },
    ]);

    writeFileSync(`${OUT}/workbook.xlsx`, bytes);

    /*
     * And the "download it all" case, which is a zip of zips: each business
     * gets its own workbook, and an .xlsx is itself an archive. Worth writing
     * out separately because nesting is where a stored-only writer would show
     * a problem if it had one — an inner file that is itself a container.
     */
    writeFileSync(
      `${OUT}/everything.zip`,
      zip([
        { name: 'shg-gmh-everything.xlsx', bytes },
        { name: 'shg-ddl-everything.xlsx', bytes },
      ]),
    );

    // Sum the Amount column on sheet 1: it must come to 5402.45. If the cells
    // are text, Excel shows 0 and nothing about the file looks wrong.
  });
});
