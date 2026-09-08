/**
 * An Excel workbook, written by hand. ARCHITECTURE §50.2.
 *
 * ===========================================================================
 * Why this exists, and it is not "because CSV was not good enough"
 *
 * The client asked for one thing a CSV cannot do at all: *"payable and
 * receivable on two sheets of the same excel"*. A CSV is one table. Sheets are
 * the feature, and there is no version of a CSV that has them.
 *
 * That is also §33.2's long-open question finally answered. It asked what
 * happens to the file when it arrives — opened, read and closed, or kept and
 * handed to somebody. Asking for tabs is the second answer.
 *
 * The cost is far lower than §33.2 assumed, because `lib/zip.ts` already had
 * to exist for the "download it all" archive, and **an `.xlsx` IS a zip of XML
 * parts**. What is left is this file: six small documents and the rules about
 * what may go in a cell.
 * ===========================================================================
 *
 * ---------------------------------------------------------------------------
 * The minimum Excel will open, and not one part less
 *
 * Every part below is required. A workbook missing any of them opens as "we
 * found a problem with some content", which reads to somebody as a broken
 * export rather than as a malformed container — so none of this is trimmed to
 * look tidy.
 *
 * What is deliberately NOT here: a shared-strings table. The format offers one
 * so that a repeated word is stored once, which is a compression idea, and
 * nothing here is compressed anyway. Inline strings put the text in the cell
 * where it belongs and remove an entire part that has to stay in step with
 * every sheet. Bigger file, half the machinery, no index to get wrong.
 * ---------------------------------------------------------------------------
 */

import { isNumberCell, type Cell } from './csv';
import { zip, type ZipEntry } from './zip';

/** One tab. Same shape as an `ExportTable`, so §49.2 builds both formats. */
export interface Sheet {
  name: string;
  header: readonly string[];
  rows: readonly (readonly Cell[])[];
}

/**
 * XML text, escaped — and stripped of what XML cannot carry at all.
 *
 * The five entities are the ordinary part. The control characters are the one
 * that matters: XML 1.0 forbids most of C0, and a single stray byte anywhere
 * in a note makes Excel refuse **the whole workbook**, not the cell. That byte
 * would arrive from somebody's phone keyboard, months after this was written,
 * and the failure would look nothing like its cause.
 *
 * Tab, newline and carriage return are the three that are legal, and they are
 * kept: a note typed across two lines should still read across two lines.
 */
function xml(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 0 -> A, 25 -> Z, 26 -> AA.
 *
 * Not a lookup table of the sixteen columns this app happens to use today.
 * A table is right until somebody adds a seventeenth column and the sheet
 * silently loses it, and this is four lines.
 */
export function columnName(index: number): string {
  let name = '';
  let n = index;
  while (n >= 0) {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  }
  return name;
}

/**
 * A sheet name Excel will accept.
 *
 * The rules are the format's, not ours: at most 31 characters, none of
 * `: \ / ? * [ ]`, not blank. Excel does not report a bad name — it refuses
 * the file — so a tab called "Deli's invoices 2026/07" would fail as a
 * container error with nothing pointing at the name.
 *
 * Truncation is silent and that is correct here: a tab is a label, the
 * filename carries the period, and a name cut at 31 characters is still the
 * right tab.
 */
export function sheetName(name: string): string {
  const clean = name.replace(/[:\\/?*[\]]/g, ' ').trim();
  return (clean === '' ? 'Sheet' : clean).slice(0, 31);
}

/**
 * One cell.
 *
 * Three kinds, and the distinction is the point of the whole file:
 *
 * - **`NumberCell`** — written as `<v>`, with no type attribute, which is what
 *   makes a column summable. It carries its exact decimal text (see
 *   `lib/csv.ts`), so integer cents reach the sheet without passing through a
 *   float.
 * - **a plain `number`** — the same, for counts and positions.
 * - **everything else** — an inline string.
 *
 * **Dates stay strings, deliberately.** A real Excel date is a serial number
 * plus a number format plus a style index, and the serial is counted from an
 * epoch that differs between Excel for Windows and Excel for Mac. Rule 2 is
 * that a calendar date in this app is `'YYYY-MM-DD'` text and is never turned
 * into anything that has a timezone; putting date arithmetic inside a
 * spreadsheet writer is exactly how that rule gets broken somewhere nobody
 * looks. ISO text also sorts correctly, which is most of what sorting a date
 * column is for.
 */
function cell(reference: string, value: Cell): string {
  if (value === null) return '';

  if (isNumberCell(value)) {
    return `<c r="${reference}"><v>${xml(value.decimal)}</v></c>`;
  }
  if (typeof value === 'number') {
    // An unusable number is an empty cell, not the text "NaN" in a money
    // column — `lib/csv.ts` makes the same call for the same reason.
    return Number.isFinite(value) ? `<c r="${reference}"><v>${value}</v></c>` : '';
  }
  return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
}

function sheetXml(sheet: Sheet): string {
  const lines: string[] = [];

  const write = (cells: readonly Cell[], rowNumber: number) => {
    const body = cells
      .map((value, index) => cell(`${columnName(index)}${rowNumber}`, value))
      .join('');
    lines.push(`<row r="${rowNumber}">${body}</row>`);
  };

  write(sheet.header, 1);
  sheet.rows.forEach((row, index) => write(row, index + 2));

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    /*
     * The header row frozen, which is the one piece of formatting worth the
     * bytes. These files are hundreds of rows long, and a spreadsheet whose
     * column headings scroll away is one where somebody reads the wrong
     * column — the same failure the app's own sticky totals exist to prevent.
     */
    '<sheetViews><sheetView workbookViewId="0">' +
    '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
    '</sheetView></sheetViews>' +
    `<sheetData>${lines.join('')}</sheetData>` +
    '</worksheet>'
  );
}

const CONTENT_TYPE_SHEET =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml';

/**
 * The workbook, as bytes.
 *
 * The relationship ids tie three files together — `workbook.xml` names a sheet
 * by `r:id`, `workbook.xml.rels` maps that id to a path, and
 * `[Content_Types].xml` declares what is at that path. All three are generated
 * from the same loop rather than written out separately, because the failure
 * when they disagree is the container error again, with nothing saying which
 * of the three was wrong.
 */
export function xlsx(sheets: readonly Sheet[]): Uint8Array {
  const used = new Set<string>();
  const named = sheets.map((sheet, index) => {
    /* Excel refuses a workbook with two tabs of the same name, and it refuses
       it as a container error. Two sheets called the same thing should not
       happen; if it ever does, a numbered suffix is a legible workbook and a
       refusal is not. */
    let name = sheetName(sheet.name);
    let attempt = 2;
    while (used.has(name.toLowerCase())) {
      name = sheetName(`${sheetName(sheet.name).slice(0, 27)} ${attempt}`);
      attempt += 1;
    }
    used.add(name.toLowerCase());
    return { ...sheet, name, index: index + 1 };
  });

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    named
      .map(
        (sheet) =>
          `<Override PartName="/xl/worksheets/sheet${sheet.index}.xml" ContentType="${CONTENT_TYPE_SHEET}"/>`,
      )
      .join('') +
    '</Types>';

  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>';

  const workbook =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"' +
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets>' +
    named
      .map(
        (sheet) =>
          `<sheet name="${xml(sheet.name)}" sheetId="${sheet.index}" r:id="rId${sheet.index}"/>`,
      )
      .join('') +
    '</sheets></workbook>';

  const workbookRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    named
      .map(
        (sheet) =>
          `<Relationship Id="rId${sheet.index}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${sheet.index}.xml"/>`,
      )
      .join('') +
    /* Styles gets the id after the last sheet. Numbered from the sheets rather
       than fixed at rId99, so adding a sheet cannot collide with it. */
    `<Relationship Id="rId${named.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    '</Relationships>';

  /*
   * A stylesheet that styles nothing, and it is not optional.
   *
   * Excel treats a missing `styles.xml` as a damaged workbook even though the
   * schema allows it, and every element below is required to be present even
   * when empty — including the second fill, which the format reserves and
   * which Excel expects to find. This is the shortest one that opens.
   */
  const styles =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
    '<fills count="2"><fill><patternFill patternType="none"/></fill>' +
    '<fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border/></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
    '</styleSheet>';

  const utf8 = new TextEncoder();
  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', bytes: utf8.encode(contentTypes) },
    { name: '_rels/.rels', bytes: utf8.encode(rootRels) },
    { name: 'xl/workbook.xml', bytes: utf8.encode(workbook) },
    { name: 'xl/_rels/workbook.xml.rels', bytes: utf8.encode(workbookRels) },
    { name: 'xl/styles.xml', bytes: utf8.encode(styles) },
    ...named.map((sheet) => ({
      name: `xl/worksheets/sheet${sheet.index}.xml`,
      bytes: utf8.encode(sheetXml(sheet)),
    })),
  ];

  return zip(entries);
}

/** The workbook as a file, ready for `downloadFile` or `shareFile`. */
export function xlsxBlobFile(name: string, sheets: readonly Sheet[]): File {
  return new File([xlsx(sheets) as unknown as BlobPart], name, {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}
