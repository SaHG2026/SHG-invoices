import { encodeWinAnsi, textWidth, type PdfFont } from './text';

/**
 * A very small PDF writer, for exactly one document.
 *
 * ===========================================================================
 * Written rather than imported. ARCHITECTURE §44.4.
 *
 * A one-page invoice is text, rules and a table. PDF is a text format, the
 * fonts it needs are already in every viewer, and the whole encoder is this
 * file — against ~350KB of library downloaded onto a phone on shop wifi, plus
 * a supply-chain dependency in a project that has just removed three.
 *
 * Rule 7 rules out libraries that restructure the app. This is not that
 * judgement: an encoder is a leaf that takes data and returns bytes. The
 * judgement is narrower — that this particular document is stable enough to
 * own, and that a dependency whose surface is `bytes = f(invoice)` is one we
 * can replace in an afternoon if that turns out to be wrong.
 *
 * ---------------------------------------------------------------------------
 * What a PDF actually is, so the next person does not have to look it up
 *
 * A header, a list of numbered objects, a cross-reference table saying what
 * BYTE each object starts at, and a trailer pointing at the table. The
 * byte offsets are the only fiddly part and they are the reason this is a
 * class rather than a template string: they cannot be known until everything
 * before them has been serialised, so the document is assembled in order and
 * the offsets are recorded as it goes.
 *
 * The object graph for this document is fixed and small:
 *
 *   1  Catalog        -> Pages
 *   2  Pages          -> every Page
 *   3  Helvetica       (standard 14, not embedded)
 *   4  Helvetica-Bold  (ditto)
 *   5.. Page, Contents, Page, Contents, ...
 *
 * ---------------------------------------------------------------------------
 * Latin-1 out, not UTF-8
 *
 * The bytes are written through `latin1Bytes` rather than `TextEncoder`,
 * because a PDF string literal holds BYTES and `encodeWinAnsi` has already
 * decided what each of them is. Running its output through a UTF-8 encoder
 * would turn every byte above 0x7F into two, which is a file that opens and
 * shows mojibake -- the failure that looks like a font problem and is not.
 * ===========================================================================
 */

/** A4, in points, which is what PDF measures in. 72pt to the inch. */
export const PAGE_WIDTH = 595.28;
export const PAGE_HEIGHT = 841.89;

const FONT_REF: Record<PdfFont, string> = {
  Helvetica: '/F1',
  'Helvetica-Bold': '/F2',
};

/**
 * One page's content stream, built up as PDF operators.
 *
 * The coordinate system is flipped from the one everything else in this app
 * uses: PDF's origin is the BOTTOM left and y increases upwards. Rather than
 * convert at forty call sites, `y` here means "points down from the top of the
 * page" and the conversion happens once, in `at()`. Getting that wrong prints
 * an invoice upside down, which is at least obvious.
 */
export class Page {
  private ops: string[] = [];
  /** True once anything on this page could not be drawn as it was written. */
  lossy = false;

  private at(y: number): number {
    return PAGE_HEIGHT - y;
  }

  /** Grey, 0 black to 1 white. The document is black on white with two greys. */
  private setGrey(grey: number) {
    this.ops.push(`${grey.toFixed(3)} g`);
  }

  text(
    value: string,
    x: number,
    y: number,
    { font = 'Helvetica' as PdfFont, size = 10, grey = 0 } = {},
  ) {
    if (value === '') return;
    const encoded = encodeWinAnsi(value);
    if (encoded.lossy) this.lossy = true;

    this.setGrey(grey);
    this.ops.push(
      'BT',
      `${FONT_REF[font]} ${size} Tf`,
      `1 0 0 1 ${x.toFixed(2)} ${this.at(y).toFixed(2)} Tm`,
      `(${encoded.literal}) Tj`,
      'ET',
    );
  }

  /** Right-aligned at `right`. What every money column on the page uses. */
  textRight(
    value: string,
    right: number,
    y: number,
    options: { font?: PdfFont; size?: number; grey?: number } = {},
  ) {
    const font = options.font ?? 'Helvetica';
    const size = options.size ?? 10;
    this.text(value, right - textWidth(value, font, size), y, options);
  }

  /**
   * A horizontal rule.
   *
   * Explicitly stroked rather than a bordered box, because §47.5's problem
   * does not exist here and the opposite one does: nothing in a PDF is
   * "decoration a browser may drop", so a line drawn is a line printed.
   */
  rule(x1: number, x2: number, y: number, { width = 0.8, grey = 0 } = {}) {
    this.ops.push(
      `${grey.toFixed(3)} G`,
      `${width} w`,
      `${x1.toFixed(2)} ${this.at(y).toFixed(2)} m`,
      `${x2.toFixed(2)} ${this.at(y).toFixed(2)} l`,
      'S',
    );
  }

  stream(): string {
    return this.ops.join('\n');
  }
}

/**
 * Latin-1 bytes. See the header: a PDF string literal holds bytes, and these
 * have already been decided by `encodeWinAnsi`.
 */
function latin1Bytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}

export interface PdfResult {
  bytes: Uint8Array;
  /** True when any page substituted a character it could not draw. */
  lossy: boolean;
}

/**
 * Serialise pages into a finished PDF.
 *
 * `title` becomes the document's own title, which is what a phone's share
 * sheet and a desktop's tab strip show — an untitled PDF called
 * `blob:https://...` in a share sheet is the sort of thing that gets sent to a
 * customer looking like nothing.
 */
export function buildPdf(pages: Page[], title: string): PdfResult {
  if (pages.length === 0) throw new Error('A PDF needs at least one page.');

  const objects: string[] = [];
  /** 1-based, because PDF object numbers start at 1 and object 0 is special. */
  const add = (body: string): number => {
    objects.push(body);
    return objects.length;
  };

  // Reserved in this order so the Catalog can name the Pages object before the
  // pages themselves exist. PDF is happy with forward references; a human
  // reading the file is happier when the first object is the root.
  const catalogId = add('');
  const pagesId = add('');
  const helvetica = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const bold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');

  const pageIds: number[] = [];

  for (const page of pages) {
    const stream = page.stream();
    const contentsId = add(
      `<< /Length ${latin1Bytes(stream).length} >>\nstream\n${stream}\nendstream`,
    );
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${pagesId} 0 R ` +
          `/MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
          `/Resources << /Font << /F1 ${helvetica} 0 R /F2 ${bold} 0 R >> >> ` +
          `/Contents ${contentsId} 0 R >>`,
      ),
    );
  }

  const info = add(`<< /Title (${encodeWinAnsi(title).literal}) /Producer (Sagarmatha Payments) >>`);

  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] =
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  // ---- Serialise, recording where every object starts -----------------
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];

  for (const [index, object] of objects.entries()) {
    offsets.push(latin1Bytes(body).length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }

  const xrefAt = latin1Bytes(body).length;

  // Entry zero is the head of the free list and is always exactly this.
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    xref += `${offset.toString().padStart(10, '0')} 00000 n \n`;
  }

  const trailer =
    `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${info} 0 R >>\n` +
    `startxref\n${xrefAt}\n%%EOF\n`;

  return {
    bytes: latin1Bytes(body + xref + trailer),
    lossy: pages.some((page) => page.lossy),
  };
}
