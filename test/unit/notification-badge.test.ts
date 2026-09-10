import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

/**
 * The notification badge. ARCHITECTURE §51.
 *
 * ===========================================================================
 * Why this test decodes a PNG instead of asserting something simpler.
 *
 * Reported as *"the notification icon is a white blob"*. The cause: `sw.js`
 * passed the full-colour app icon as the notification `badge`, and **Android
 * throws away a badge's colours and draws only its alpha channel, tinted.**
 * `icon-192.png` is 0% transparent, so its alpha is a filled square, and a
 * filled square tinted white is a white blob.
 *
 * The obvious guard — "the badge is a PNG with an alpha channel" — would have
 * PASSED ON THE FILE THAT CAUSED THE BUG. `icon-192.png` is RGBA too; it
 * simply has nothing transparent in it. A check that cannot fail on the known
 * defect is HANDOFF's "a check that is never extended stops being a check and
 * becomes a claim", written from the start.
 *
 * So this reads the actual pixels. Node ships zlib, and PNG un-filtering is
 * the twenty lines below.
 * ===========================================================================
 */

interface Decoded {
  width: number;
  height: number;
  /** One byte per pixel, row-major. */
  alpha: Uint8Array;
}

/**
 * Enough of a PNG reader to answer one question: how much of this is see
 * through?
 *
 * Deliberately narrow. It refuses anything but 8-bit RGBA, non-interlaced —
 * which is what every icon in `public/icons` is — rather than growing support
 * for formats nothing here produces. A decoder that silently mishandles a
 * palette image would report 0% transparent and fail the test for the wrong
 * reason, which is worse than refusing to read it.
 */
function alphaOf(bytes: Buffer): Decoded {
  expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');

  let at = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];

  while (at < bytes.length) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.subarray(at + 4, at + 8).toString('ascii');
    const data = bytes.subarray(at + 8, at + 8 + length);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      expect(data[8], 'bit depth').toBe(8);
      expect(data[9], 'colour type — 6 is RGBA').toBe(6);
      expect(data[12], 'interlace').toBe(0);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }

    at += 12 + length; // length + type + data + crc
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const out = new Uint8Array(width * height);
  const line = new Uint8Array(stride);
  const previous = new Uint8Array(stride);

  let read = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[read];
    read += 1;

    for (let x = 0; x < stride; x += 1) {
      const value = raw[read + x]!;
      const a = x >= 4 ? line[x - 4]! : 0; // the byte to the left
      const b = previous[x]!; // the byte above
      const c = x >= 4 ? previous[x - 4]! : 0; // above-left

      let restored: number;
      switch (filter) {
        case 0:
          restored = value;
          break;
        case 1:
          restored = value + a;
          break;
        case 2:
          restored = value + b;
          break;
        case 3:
          restored = value + ((a + b) >> 1);
          break;
        case 4: {
          // Paeth: whichever of left, above, above-left the gradient predicts.
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          restored = value + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`unknown PNG filter ${filter}`);
      }
      line[x] = restored & 0xff;
    }

    for (let x = 0; x < width; x += 1) out[y * width + x] = line[x * 4 + 3]!;
    previous.set(line);
    read += stride;
  }

  return { width, height, alpha: out };
}

function transparentShare(file: string): number {
  const { alpha } = alphaOf(readFileSync(file));
  let clear = 0;
  for (const value of alpha) if (value === 0) clear += 1;
  return clear / alpha.length;
}

describe('the notification badge', () => {
  const BADGE = 'public/icons/badge-96.png';

  it('is what the service worker actually asks for', () => {
    const sw = readFileSync('public/sw.js', 'utf8');
    expect(sw).toContain("badge: '/icons/badge-96.png'");
    /*
     * And NOT the app icon, which is the exact line that produced the blob.
     * `icon:` may still be icon-192 — that one is drawn as supplied.
     */
    expect(sw).not.toContain("badge: '/icons/icon-192.png'");
  });

  it('is mostly transparent, which is the whole point of it', () => {
    // Android draws the alpha and nothing else. Below roughly half and the
    // mark stops reading as a mark and starts reading as a shape.
    expect(transparentShare(BADGE)).toBeGreaterThan(0.5);
  });

  it('has something left to draw once the colours are thrown away', () => {
    // The opposite failure, and just as silent: a badge that is ENTIRELY
    // transparent shows nothing at all, and a missing status-bar icon looks
    // like a notification that never arrived.
    expect(transparentShare(BADGE)).toBeLessThan(0.98);
  });

  it('is square, so it is not letterboxed into the status bar', () => {
    const { width, height } = alphaOf(readFileSync(BADGE));
    expect(width).toBe(height);
  });

  it('would have failed on the file that caused the bug', () => {
    /*
     * The check checking itself.
     *
     * `icon-192.png` is a perfectly good RGBA PNG — which is why "has an alpha
     * channel" was never going to catch this. It has no transparency at all,
     * so as a badge it is a filled square. If this assertion ever starts
     * failing, the app icon has gained transparency and the two tests above
     * have stopped being able to tell the two files apart.
     */
    expect(transparentShare('public/icons/icon-192.png')).toBeLessThan(0.01);
  });
});
