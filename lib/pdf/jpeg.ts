/**
 * Reading just enough of a JPEG to put it in a PDF. ARCHITECTURE §48.5.
 *
 * ===========================================================================
 * Nothing here decodes an image, and that is the point
 *
 * A PDF embeds a JPEG **as a JPEG**: the filter is `DCTDecode` and the stream
 * is the file's own bytes, untouched. So the only thing needed is the handful
 * of facts the image dictionary has to declare — how wide, how tall, how many
 * colour channels — and those are in the SOF marker near the front of the
 * file.
 *
 * §44.4 expected this to be the hard part, on the assumption that uploaded
 * artwork is PNG: embedding PNG means implementing zlib, and the way around
 * it was to re-encode through a canvas. **Deli's logo turned out to be a
 * JPEG**, so none of that applies — the bytes go in as they are.
 *
 * ---------------------------------------------------------------------------
 * The two things that make a JPEG unusable here
 *
 * **Progressive.** PDF's DCTDecode is baseline only. A progressive JPEG
 * produces a file that opens and shows a blank or corrupt image, which is
 * worse than no logo — so it is refused by name.
 *
 * **CMYK.** Four-channel JPEGs from print software need `/Decode [1 0 1 0 1 0
 * 1 0]` and Adobe-specific inversion rules, and getting it wrong prints a
 * photographic negative on a customer's invoice. Also refused.
 *
 * In both cases the answer is `null`, the document prints the business name
 * instead, and nothing is broken. A logo is a nicety; an invoice is not.
 * ===========================================================================
 */

export interface JpegFacts {
  width: number;
  height: number;
  /** 1 = greyscale, 3 = colour. Anything else is refused above. */
  components: 1 | 3;
}

/** Markers that carry no length field and must be stepped over, not read. */
function isStandalone(marker: number): boolean {
  return marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);
}

/**
 * Every SOF marker, and what it means for us.
 *
 * Baseline and extended-sequential are fine. Everything else is a progressive
 * or arithmetic-coded variant that DCTDecode cannot read.
 */
const SUPPORTED_SOF = new Set([0xc0, 0xc1]);
const UNSUPPORTED_SOF = new Set([0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/**
 * What a PDF needs to know about a JPEG, or null if it cannot use it.
 *
 * Deliberately total: every malformed, truncated or unsupported input returns
 * null rather than throwing. This runs while somebody is trying to download an
 * invoice, and a broken logo must never be the reason they cannot.
 */
export function readJpeg(bytes: Uint8Array): JpegFacts | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  let at = 2;

  while (at + 3 < bytes.length) {
    // Markers can be padded with any number of 0xFF bytes before the code.
    if (bytes[at] !== 0xff) {
      at += 1;
      continue;
    }

    const marker = bytes[at + 1]!;
    if (marker === 0xff) {
      at += 1;
      continue;
    }

    if (isStandalone(marker)) {
      at += 2;
      continue;
    }

    // Start of scan: the entropy-coded data begins and there is no SOF after.
    if (marker === 0xda) return null;

    const length = (bytes[at + 2]! << 8) | bytes[at + 3]!;
    if (length < 2 || at + 2 + length > bytes.length) return null;

    if (UNSUPPORTED_SOF.has(marker)) return null;

    if (SUPPORTED_SOF.has(marker)) {
      // SOF payload: precision, height, width, component count.
      const height = (bytes[at + 5]! << 8) | bytes[at + 6]!;
      const width = (bytes[at + 7]! << 8) | bytes[at + 8]!;
      const components = bytes[at + 9]!;

      if (width < 1 || height < 1) return null;
      if (components !== 1 && components !== 3) return null;

      return { width, height, components };
    }

    at += 2 + length;
  }

  return null;
}
