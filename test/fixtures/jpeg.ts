/**
 * JPEGs, as bytes, for the PDF image tests.
 *
 * Hand-built rather than checked in as binary files, because what is being
 * tested is the marker walk in `lib/pdf/jpeg.ts` and these are the exact
 * shapes it has to tell apart. A real photograph would prove the same thing
 * more slowly and less clearly -- and `preview` in pdf.test.ts embeds Deli's
 * actual logo, which is where a real file earns its place.
 */

/**
 * Baseline, 120 wide by 90 high, three components. What Deli's logo is.
 *
 * The SOF payload is precision, HEIGHT, then width -- in that order, which is
 * the one thing about this marker that is easy to get backwards. It was, once:
 * the first version of this fixture wrote them the other way round and the
 * parser was blamed for it.
 */
export const BASELINE_JPEG = new Uint8Array([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 255, 192, 0, 17, 8, 0, 90, 0, 120, 3, 1, 17, 0, 2, 17, 1, 3, 17, 1, 255, 218, 0, 12, 3, 1, 0, 2, 17, 3, 17, 0, 63, 0, 255, 217]);

/** The same file with SOF0 changed to SOF2. DCTDecode cannot read this. */
export const PROGRESSIVE_JPEG = new Uint8Array([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 255, 194, 0, 17, 8, 0, 90, 0, 120, 3, 1, 17, 0, 2, 17, 1, 3, 17, 1, 255, 218, 0, 12, 3, 1, 0, 2, 17, 3, 17, 0, 63, 0, 255, 217]);

/** Baseline, 40x40, one component. Greyscale, which is DeviceGray. */
export const GREYSCALE_JPEG = new Uint8Array([255, 216, 255, 192, 0, 11, 8, 0, 40, 0, 40, 1, 1, 17, 0, 255, 218, 0, 8, 1, 1, 0, 0, 63, 0, 255, 217]);
