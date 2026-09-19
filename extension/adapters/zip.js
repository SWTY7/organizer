/* ==========================================================================
   Just enough zip for a .chatpack.zip: write one, read one. No dependency.

   Writing stores images as they are (a webp does not shrink) and deflates
   text with the browser's own CompressionStream when there is one. Reading
   handles stored and deflated entries, which is what any zip tool makes by
   default, via DecompressionStream('deflate-raw').

   Not handled, on purpose: zip64 (archives over 4 GB), encryption, and
   multi-disk archives. Each is refused with a message rather than misread.

   Shared by the capture extension, which writes, and the app, which reads —
   so it lives with the adapters and is copied into the extension by
   tools/build.mjs like them.
   ========================================================================== */

let CRC_TABLE = null;
export function crc32(bytes) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const utf8 = (s) => new TextEncoder().encode(s);
const asBytes = (d) => (typeof d === 'string' ? utf8(d) : d instanceof Uint8Array ? d : new Uint8Array(d));

async function pipe(bytes, stream) {
  const out = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

/** Hex SHA-256 of some bytes — the name a blob is stored under. */
export async function sha256Bytes(bytes) {
  const h = await crypto.subtle.digest('SHA-256', asBytes(bytes));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * @param {{name: string, data: Uint8Array|string}[]} entries
 * @param {{compress?: (name: string) => boolean}} opts  deflate these, if the
 *   browser can; the default is text-like files, since images and PDFs are
 *   already compressed and would only cost time.
 * @returns {Promise<Uint8Array>}
 */
export async function zip(entries, { compress = (n) => /\.(json|txt|md|html|svg|csv)$/i.test(n) } = {}) {
  const canDeflate = typeof CompressionStream === 'function';
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = utf8(e.name);
    const raw = asBytes(e.data);
    const crc = crc32(raw);
    let body = raw, method = 0;
    if (canDeflate && compress(e.name)) {
      const d = await pipe(raw, new CompressionStream('deflate-raw'));
      if (d.length < raw.length) { body = d; method = 8; }
    }
    if (offset > 0xffffffff || body.length > 0xffffffff) throw new Error('This export is over 4 GB, which a simple zip cannot hold. Export fewer conversations at a time.');

    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true);          // names are UTF-8
    lh.setUint16(8, method, true);
    lh.setUint16(10, dosTime, true);
    lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, body.length, true);
    lh.setUint32(22, raw.length, true);
    lh.setUint16(26, name.length, true);
    lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), name, body);

    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, method, true);
    ch.setUint16(12, dosTime, true);
    ch.setUint16(14, dosDate, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, body.length, true);
    ch.setUint32(24, raw.length, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + body.length;
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);

  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) { out.set(p, at); at += p.length; }
  return out;
}

/** Does this look like a zip? */
export const isZip = (bytes) => bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4;

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<Map<string, Uint8Array>>} name -> contents; folders skipped
 */
export async function unzip(bytes) {
  bytes = asBytes(bytes);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file, or a damaged one');
  if (dv.getUint16(4 + eocd, true) !== 0) throw new Error('multi-part zip archives are not supported');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  if (p === 0xffffffff || count === 0xffff) throw new Error('zip64 archives (over 4 GB) are not supported');

  const out = new Map();
  const dec = new TextDecoder();
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('damaged zip: bad central directory');
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true);
    const xlen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    if (flags & 1) throw new Error(`${name} is encrypted`);
    if (dv.getUint32(local, true) !== 0x04034b50) throw new Error('damaged zip: bad local header');
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + csize);
    if (method === 0) out.set(name, data.slice());
    else if (method === 8) out.set(name, await pipe(data, new DecompressionStream('deflate-raw')));
    else throw new Error(`${name} uses a compression method this reader does not know (${method})`);
  }
  return out;
}
