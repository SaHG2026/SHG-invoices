/**
 * CSV, written by hand. ARCHITECTURE §49.1.
 *
 * ===========================================================================
 * Why this file exists rather than a package
 *
 * The same judgement §44.4 made about the PDF, with far less to weigh: CSV is
 * a comma, a quote and a newline. RFC 4180 is two pages. A dependency here
 * would be a supply-chain edge added to a project that has just removed three
 * (§43.2), in exchange for about sixty lines.
 *
 * What that buys is that every decision below is visible and tested. A CSV
 * that is subtly wrong does not fail — it opens, and one column is off.
 * ===========================================================================
 */

/**
 * Everything a cell can be, and `null` is a cell nobody filled in.
 *
 * Deliberately narrow. A `Date` is not here because rule 2 says a calendar
 * date is a `'YYYY-MM-DD'` string and never a `Date`, and a formatter that
 * accepted one would be the place somebody eventually called `toISOString()`.
 * Money is not here either: cents are converted by the caller, through
 * `lib/money.ts`, because a currency decision made inside a CSV encoder is a
 * currency decision made twice.
 */
export type Cell = string | number | null;

/** RFC 4180 says CRLF, and Excel on Windows is the reader this is for. */
const EOL = '\r\n';

/**
 * The characters that force a field to be quoted.
 *
 * The leading/trailing space case is not in the RFC and is here anyway: a
 * supplier typed as `' Coles'` round-trips through a quoted field and is
 * silently trimmed by some readers through an unquoted one, which turns a
 * data-entry mistake into a mystery.
 */
function needsQuotes(text: string): boolean {
  return (
    text.includes('"') ||
    text.includes(',') ||
    text.includes('\n') ||
    text.includes('\r') ||
    text !== text.trim()
  );
}

/**
 * A cell that a spreadsheet would run instead of read.
 *
 * `=`, `+` and `@` at the start of a field make Excel and Sheets treat the
 * text as a formula. This is somebody's typed note arriving in the owner's
 * spreadsheet, so it is worth stopping.
 *
 * **`-` is deliberately not in this list.** It begins real data constantly —
 * a negative figure, a note reading `-40, short delivery`. Neutralising it
 * would corrupt ordinary values every day to prevent something that has never
 * happened, and a export that quietly alters what was typed is worse than the
 * thing it is guarding against.
 */
function isFormula(text: string): boolean {
  return text.startsWith('=') || text.startsWith('+') || text.startsWith('@');
}

/**
 * One field, escaped.
 *
 * The formula guard is a leading TAB rather than the more common leading
 * apostrophe, because the tab is invisible in the cell and the apostrophe is
 * not — Numbers and LibreOffice both show it, so the reader sees `'=x` and
 * assumes the app mangled the data. The tab is inside the quotes, so the field
 * still reads back as text through any RFC 4180 parser.
 */
export function csvField(value: Cell): string {
  if (value === null) return '';
  if (typeof value === 'number') {
    // Not `String(NaN)` -> "NaN" sitting in a money column. An unusable number
    // is an empty cell, which is what it means.
    return Number.isFinite(value) ? String(value) : '';
  }

  const guarded = isFormula(value) ? `\t${value}` : value;
  if (!needsQuotes(guarded) && guarded === value) return value;
  return `"${guarded.replace(/"/g, '""')}"`;
}

/** One row. */
export function csvRow(cells: readonly Cell[]): string {
  return cells.map(csvField).join(',');
}

/**
 * A whole file: a header row, then the body.
 *
 * ---------------------------------------------------------------------------
 * The byte-order mark is not decoration.
 *
 * Excel on Windows opens a plain UTF-8 CSV as the system codepage, so a
 * customer named Ngô arrives as `NgÃ´`. The BOM is what tells it otherwise,
 * and it is three bytes.
 *
 * This is also the answer §48.1 could not give the PDF. The standard-14 fonts
 * cannot draw a name outside WinAnsi and the invoice shows `?`; a CSV carries
 * any name the phone can type, exactly, because a CSV has no fonts in it.
 * ---------------------------------------------------------------------------
 */
export const BOM = '﻿';

export function csvFile(header: readonly string[], rows: readonly (readonly Cell[])[]): string {
  const lines = [csvRow(header), ...rows.map(csvRow)];
  // A trailing EOL, so the last row is a complete line. Readers differ on a
  // file that ends mid-row and the disagreement shows up as a dropped record.
  return BOM + lines.join(EOL) + EOL;
}

/**
 * The file, ready to hand to `downloadFile` or `shareFile`.
 *
 * `text/csv` rather than `application/octet-stream`, so Android's share sheet
 * offers Sheets and Gmail rather than only a file manager — the same
 * consideration §48.2 met with the PDF.
 */
export function csvBlobFile(name: string, content: string): File {
  return new File([content], name, { type: 'text/csv;charset=utf-8' });
}
