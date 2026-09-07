'use client';

import { brandPath } from '@/lib/queries/brand';

/**
 * Fetching a business's uploaded mark so it can go on the PDF. §48.5.
 *
 * ===========================================================================
 * Why this is a fetch and not the <img> already on the page
 *
 * The screen shows the same picture through `BusinessMark`, and the tempting
 * shortcut is to read that element's pixels back out through a canvas. It does
 * not work and it is worth knowing why before somebody tries: an image loaded
 * from another origin taints the canvas, `toDataURL` then throws, and the
 * bucket is on Supabase's domain rather than the app's.
 *
 * Fetching the bytes has no such problem, and it also gets us the file as it
 * was uploaded rather than as a browser decoded it -- which is the whole point
 * (`lib/pdf/jpeg.ts`): a JPEG goes into a PDF untouched.
 *
 * ---------------------------------------------------------------------------
 * Every failure ends the same way, and that is deliberate
 *
 * No artwork, no signal, a CDN hiccup, a PNG where a JPEG was expected, a
 * progressive JPEG the writer cannot embed -- all of them return null, the
 * document prints the business name where the mark would be, and the invoice
 * is finished. **A missing logo must never be the reason somebody cannot
 * download an invoice.**
 * ===========================================================================
 */

/** The public url of a business's uploaded mark, or null if it has none. */
function markUrl(code: string): string | null {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) return null;
  return `${base}/storage/v1/object/public/brand/${brandPath('businesses', code)}`;
}

/**
 * The uploaded mark as raw bytes, or null.
 *
 * Only JPEG comes back. A PNG in the bucket would need either zlib or a canvas
 * re-encode (§44.4), and neither is here — so it is refused by content type
 * and the name is printed instead, which is the same outcome as no artwork at
 * all and is never wrong on the page.
 */
export async function fetchLogoBytes(code: string | undefined): Promise<Uint8Array | null> {
  if (!code) return null;
  const url = markUrl(code);
  if (!url) return null;

  try {
    const response = await fetch(url);
    if (!response.ok) return null;

    const type = response.headers.get('content-type') ?? '';
    if (!type.startsWith('image/jpeg')) return null;

    const original = new Uint8Array(await response.arrayBuffer());
    return (await shrink(original)) ?? original;
  } catch {
    return null;
  }
}

/**
 * How many pixels across the mark is worth storing.
 *
 * It is drawn at 34pt, which is under half an inch. 300 pixels is roughly
 * 600dpi at that size -- past what any printer will resolve and well past what
 * a phone screen will.
 */
const LOGO_PIXELS = 300;

/**
 * The same picture, smaller, or null to keep the original.
 *
 * ---------------------------------------------------------------------------
 * Why bother
 *
 * Deli's logo is 1103px and 295KB, and it goes on the page at 34 points. Left
 * alone it is 98% of the invoice: a 3KB document became a 298KB one, sent by
 * email, from a phone, on shop wifi, every time. Shrunk it is around 15KB.
 *
 * ---------------------------------------------------------------------------
 * Every failure returns null, and null means "send the original"
 *
 * This is the one part of the PDF path that cannot run in a test — jsdom has
 * no canvas, `createImageBitmap` is not there, and `toBlob` does nothing. That
 * is survivable **only because of what failure costs**: null falls back to the
 * bytes as downloaded, which still embed correctly and still produce a valid
 * invoice. The worst this function can do is make the file bigger.
 *
 * That is the whole reason it is shaped as an optimisation rather than as a
 * step in the pipeline. A canvas re-encode that the invoice DEPENDED on would
 * be untestable and load-bearing at once, which is how §39.8 happened.
 */
async function shrink(bytes: Uint8Array): Promise<Uint8Array | null> {
  try {
    if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return null;

    const source = new Blob([bytes as BlobPart], { type: 'image/jpeg' });
    const bitmap = await createImageBitmap(source);

    const longest = Math.max(bitmap.width, bitmap.height);
    if (longest <= LOGO_PIXELS) {
      bitmap.close();
      return null;
    }

    const scale = LOGO_PIXELS / longest;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);

    const context = canvas.getContext('2d');
    if (!context) {
      bitmap.close();
      return null;
    }

    /* White underneath, because a JPEG has no transparency: a logo saved with
       an alpha channel would otherwise composite onto black. */
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.85),
    );
    if (!blob) return null;

    const shrunk = new Uint8Array(await blob.arrayBuffer());

    /* Only if it actually helped. A canvas re-encode of an already small or
       already optimal image can come out larger, and shipping a bigger file
       than the one we started with would make this function pure cost. */
    return shrunk.length < bytes.length ? shrunk : null;
  } catch {
    return null;
  }
}
