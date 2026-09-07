/**
 * Turning a JavaScript string into bytes a PDF viewer will draw, and knowing
 * how wide the result is.
 *
 * ===========================================================================
 * Why this file exists at all, and what it deliberately cannot do
 *
 * The invoice PDF is written rather than imported (ARCHITECTURE §44.4), and it
 * uses the two fonts every PDF viewer already has — Helvetica and
 * Helvetica-Bold, two of the standard 14. Nothing is embedded, so the file is
 * a few kilobytes and there is no font to ship.
 *
 * The price of that is **the character set**. A standard-14 font is drawn
 * through `WinAnsiEncoding`, which is Latin-1 plus a handful of typographic
 * extras, and that is the whole alphabet available. Devanagari is not in it.
 * Neither is Chinese, Greek or Cyrillic.
 *
 * Making them possible means embedding a Unicode font — hundreds of kilobytes
 * on every phone on shop wifi, which is the exact cost the write-it-yourself
 * decision was taken to avoid. So the limitation is accepted and made
 * VISIBLE rather than hidden: `encodeWinAnsi` reports whether anything was
 * substituted, the compose screen never sees this file, and **the Print path
 * is unaffected** — `window.print()` renders whatever the phone can render, in
 * any script. Only the shared PDF is restricted, and Print is still there.
 *
 * The alternative was to let unrepresentable characters through as a wrong
 * glyph, which on an invoice is a customer's name spelled incorrectly on a
 * document they keep. A '?' is honest about not knowing.
 * ===========================================================================
 */

/** The two faces the invoice uses. Both are standard 14; neither is embedded. */
export type PdfFont = 'Helvetica' | 'Helvetica-Bold';

/*
 * Glyph widths, in 1/1000 of the font size, for the printable ASCII range.
 *
 * From the Adobe Font Metrics for the standard 14. They are here as data
 * rather than measured at runtime because there is nothing to measure against:
 * the fonts live in the viewer, not in this program. Getting one wrong shows
 * up as a right-aligned amount that is a pixel out, which is why the test
 * checks a few known strings rather than trusting the table by eye.
 *
 * Index 0 is space (32); the last entry is '~' (126).
 */
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

const HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

/**
 * The characters this app actually emits that are not ASCII, and what they
 * become.
 *
 * Every one of these is a character the app itself writes — the money
 * formatter, the date formatter and the separators used across the interface —
 * so they are not hypothetical. Left unmapped they would each become a '?' in
 * the middle of a sentence the app wrote, which reads as corruption rather
 * than as a missing glyph.
 *
 * `·` and `–` and `—` DO exist in WinAnsi, and are mapped anyway: a right
 * single quote at 0x92 is correct in WinAnsi and wrong in Latin-1, and viewers
 * disagree about which they are following when a font is not embedded. An
 * apostrophe that renders as a box on one phone is worse than a straight one
 * everywhere.
 */
const SUBSTITUTIONS: Record<string, string> = {
  '‘': "'",
  '’': "'",
  '“': '"',
  '”': '"',
  '–': '-',
  '—': '-',
  '…': '...',
  '·': '-',
  ' ': ' ',
  '•': '-',
};

export interface EncodedText {
  /** The bytes to put inside the PDF string literal, already escaped. */
  literal: string;
  /**
   * True when at least one character could not be represented and became '?'.
   *
   * Carried rather than swallowed so a caller can say so. Nothing in the app
   * silently produces a document with a customer's name spelled wrongly.
   */
  lossy: boolean;
}

/**
 * One character's byte in WinAnsiEncoding, or null if it has none.
 *
 * Latin-1 (0x20-0xFF) maps straight through with two gaps that WinAnsi fills
 * differently; those live in 0x80-0x9F and are the typographic characters
 * `SUBSTITUTIONS` has already replaced, so by the time anything reaches here
 * the only non-ASCII left is accented Latin — which is exactly Latin-1.
 */
function winAnsiByte(char: string): number | null {
  const code = char.codePointAt(0)!;
  if (code >= 0x20 && code <= 0x7e) return code;
  if (code >= 0xa0 && code <= 0xff) return code;
  return null;
}

/**
 * A JavaScript string as an escaped PDF string literal.
 *
 * Three characters have to be escaped inside `( )` — the parentheses
 * themselves and the backslash — and getting that wrong does not produce a
 * wrong-looking invoice, it produces a file no viewer will open. A supplier
 * called "Smith (Wholesale)" is not unusual.
 */
export function encodeWinAnsi(input: string): EncodedText {
  let literal = '';
  let lossy = false;

  for (const char of input.replace(/\r\n?/g, '\n')) {
    const mapped = SUBSTITUTIONS[char] ?? char;

    for (const piece of mapped) {
      const byte = winAnsiByte(piece);

      if (byte === null) {
        literal += '?';
        lossy = true;
        continue;
      }

      if (piece === '(' || piece === ')' || piece === '\\') literal += '\\' + piece;
      else if (byte > 0x7e) literal += '\\' + byte.toString(8).padStart(3, '0');
      else literal += piece;
    }
  }

  return { literal, lossy };
}

/** What `encodeWinAnsi` will draw, as plain characters. Used for measuring. */
function displayable(input: string): string {
  let out = '';
  for (const char of input) {
    const mapped = SUBSTITUTIONS[char] ?? char;
    for (const piece of mapped) out += winAnsiByte(piece) === null ? '?' : piece;
  }
  return out;
}

/**
 * How wide a string will be, in points, once drawn.
 *
 * This is what makes a right-aligned column possible, and a column of money
 * that does not line up is the first thing anybody notices on an invoice.
 * Measured on what will ACTUALLY be drawn, not on the input — a name that
 * became three question marks is three question marks wide.
 *
 * Anything outside the table (accented Latin) falls back to the width of 'n',
 * which is the right shape of guess: those glyphs are letter-shaped, and the
 * consequence of being a little out is a total sitting a point off the margin
 * rather than a broken file.
 */
export function textWidth(text: string, font: PdfFont, size: number): number {
  const widths = font === 'Helvetica-Bold' ? HELVETICA_BOLD : HELVETICA;
  const fallback = font === 'Helvetica-Bold' ? 611 : 556;
  let total = 0;

  for (const char of displayable(text)) {
    const code = char.codePointAt(0)!;
    const width = code >= 32 && code <= 126 ? widths[code - 32]! : fallback;
    total += width;
  }

  return (total * size) / 1000;
}

/**
 * Break a string to fit a column, on spaces where it can and mid-word when it
 * must.
 *
 * The mid-word case is not a nicety. A product description is typed by
 * somebody in a hurry and "Mushrooms/Portobello/Large-crate" is one word to
 * this function; without the second loop it would run off the edge of the
 * page, silently, on the one document a customer keeps.
 */
export function wrapText(
  text: string,
  font: PdfFont,
  size: number,
  maxWidth: number,
): string[] {
  const lines: string[] = [];

  for (const paragraph of text.split('\n')) {
    let current = '';

    for (const word of paragraph.split(/\s+/).filter((piece) => piece !== '')) {
      const candidate = current === '' ? word : `${current} ${word}`;

      if (textWidth(candidate, font, size) <= maxWidth) {
        current = candidate;
        continue;
      }

      if (current !== '') {
        lines.push(current);
        current = '';
      }

      // A single word wider than the column. Cut it where it stops fitting.
      let piece = '';
      for (const char of word) {
        if (piece !== '' && textWidth(piece + char, font, size) > maxWidth) {
          lines.push(piece);
          piece = char;
        } else {
          piece += char;
        }
      }
      current = piece;
    }

    lines.push(current);
  }

  return lines;
}
