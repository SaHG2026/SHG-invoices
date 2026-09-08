/**
 * A zip archive, written by hand. ARCHITECTURE §50.1.
 *
 * ===========================================================================
 * Two things needed one file, which is why this exists at all.
 *
 * The client asked for "download it all" as a zip, and for Deli's export to be
 * one Excel workbook with a sheet per direction. Those sound like separate
 * jobs. **They are the same job: an `.xlsx` file IS a zip archive of XML
 * parts.** So a zip writer buys the archive and the workbook together.
 *
 * The reason it can be written rather than imported is that **zip supports
 * uncompressed entries** — storage method 0 — and every reader accepts them,
 * Excel included. Compression is what would have needed zlib, and nothing here
 * needs compression: this is XML and CSV going to a phone, not over a wire.
 *
 * §44.4's judgement about the PDF, applied again and landing more easily. A
 * few hundred lines against a dependency, in a project that has removed three
 * (§43.2), for a format that has not changed since 1989.
 * ===========================================================================
 */

/**
 * CRC-32, the one part of zip that cannot be fudged.
 *
 * Every entry carries a checksum of its own bytes, twice — once in the local
 * header and once in the central directory. A reader that finds them wrong
 * reports a corrupt archive, and Excel reports it as "we found a problem with
 * some content", which reads like a bug in the workbook rather than in the
 * container.
 *
 * The table is built once at module load. 256 iterations of eight shifts is
 * nothing, and it is the difference between a per-byte loop of eight
 * operations and one lookup.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * The timestamp every entry carries, and it is a constant.
 *
 * **Rule 2: `new Date()` appears in `lib/date.ts` and nowhere else.** Zip wants
 * a DOS date and time, which is neither a calendar date nor a time of day as
 * this app understands them — it is a packed 16-bit pair, and reaching for a
 * clock here would put the app's worst bug class inside a file format.
 *
 * A fixed value costs nothing real: the useful date on an export is in its
 * filename (§49.2), and archives that do not carry a clock have the pleasant
 * side effect of being byte-identical for identical content, which is what
 * lets a test assert on the bytes at all.
 *
 * 1980-01-01 00:00 — the earliest the format can express, so it reads as "no
 * time recorded" rather than as a wrong one.
 */
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const END_SIG = 0x06054b50;

/** One file inside the archive. `name` may contain `/` for a folder. */
export interface ZipEntry {
  name: string;
  bytes: Uint8Array;
}

/**
 * A growable little-endian byte buffer.
 *
 * Zip is little-endian throughout and `DataView` is the only thing in the
 * platform that says so explicitly. Writing these by hand with shifts is where
 * a byte order gets flipped once and every reader disagrees about the file.
 */
class Bytes {
  private parts: Uint8Array[] = [];
  length = 0;

  u16(value: number): void {
    const view = new Uint8Array(2);
    new DataView(view.buffer).setUint16(0, value, true);
    this.raw(view);
  }

  u32(value: number): void {
    const view = new Uint8Array(4);
    new DataView(view.buffer).setUint32(0, value >>> 0, true);
    this.raw(view);
  }

  raw(bytes: Uint8Array): void {
    this.parts.push(bytes);
    this.length += bytes.length;
  }

  done(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const part of this.parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }
}

const utf8 = new TextEncoder();

/**
 * The archive.
 *
 * Stored, never deflated — see the header. Each entry is written twice: once
 * as a local header immediately before its data, and once in the central
 * directory at the end, which is the index a reader actually reads. The two
 * must agree about the size and the checksum or the file is corrupt, so they
 * are computed once and used in both places rather than derived twice.
 *
 * No Zip64, and that is a stated limit rather than an oversight: the sizes
 * here are 32-bit, so this cannot write an entry or an archive over 4GB. An
 * export that large is refused long before it reaches this file — `runExport`
 * stops at `EXPORT_MAX_ROWS` (§49.3).
 */
export function zip(entries: readonly ZipEntry[]): Uint8Array {
  const body = new Bytes();
  const directory = new Bytes();

  for (const entry of entries) {
    const name = utf8.encode(entry.name);
    const crc = crc32(entry.bytes);
    const size = entry.bytes.length;
    const offset = body.length;

    // ---- local file header, then the data itself -------------------------
    body.u32(LOCAL_SIG);
    body.u16(20); // version needed: 2.0, which is what "stored" requires
    body.u16(0); // no flags. Names here are ASCII, so no UTF-8 flag is needed
    body.u16(0); // method 0 — stored. The whole reason no zlib is involved
    body.u16(DOS_TIME);
    body.u16(DOS_DATE);
    body.u32(crc);
    body.u32(size); // compressed size
    body.u32(size); // uncompressed size — the same, because nothing was compressed
    body.u16(name.length);
    body.u16(0); // no extra field
    body.raw(name);
    body.raw(entry.bytes);

    // ---- and its entry in the index --------------------------------------
    directory.u32(CENTRAL_SIG);
    directory.u16(20); // version made by
    directory.u16(20); // version needed
    directory.u16(0);
    directory.u16(0);
    directory.u16(DOS_TIME);
    directory.u16(DOS_DATE);
    directory.u32(crc);
    directory.u32(size);
    directory.u32(size);
    directory.u16(name.length);
    directory.u16(0); // extra
    directory.u16(0); // comment
    directory.u16(0); // disk number
    directory.u16(0); // internal attributes
    directory.u32(0); // external attributes — no unix mode, so readers use their own default
    directory.u32(offset);
    directory.raw(name);
  }

  const dirBytes = directory.done();
  const bodyBytes = body.done();

  const end = new Bytes();
  end.u32(END_SIG);
  end.u16(0); // this disk
  end.u16(0); // disk the directory starts on
  end.u16(entries.length);
  end.u16(entries.length);
  end.u32(dirBytes.length);
  end.u32(bodyBytes.length); // the directory begins where the data ends
  end.u16(0); // no archive comment

  const out = new Uint8Array(bodyBytes.length + dirBytes.length + end.length);
  out.set(bodyBytes, 0);
  out.set(dirBytes, bodyBytes.length);
  out.set(end.done(), bodyBytes.length + dirBytes.length);
  return out;
}

/** The archive as a file, ready for `downloadFile` or `shareFile`. */
export function zipBlobFile(name: string, entries: readonly ZipEntry[]): File {
  return new File([zip(entries) as unknown as BlobPart], name, { type: 'application/zip' });
}
