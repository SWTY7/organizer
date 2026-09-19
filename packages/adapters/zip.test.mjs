import test from 'node:test';
import assert from 'node:assert/strict';
import { zip, unzip, crc32, isZip, sha256Bytes } from './zip.js';

const text = (b) => new TextDecoder().decode(b);

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('what zip writes, unzip reads back byte for byte', async () => {
  const bin = new Uint8Array(3000).map((_, i) => (i * 7) % 256);
  const z = await zip([
    { name: 'manifest.json', data: JSON.stringify({ kind: 'chatpack', pad: 'x'.repeat(500) }) },
    { name: 'conversations/é.chat.json', data: '{"title":"naïve — ünïcode"}' },
    { name: 'blobs/abc', data: bin },
  ]);
  assert.ok(isZip(z));
  const m = await unzip(z);
  assert.deepEqual([...m.keys()], ['manifest.json', 'conversations/é.chat.json', 'blobs/abc']);
  assert.equal(JSON.parse(text(m.get('manifest.json'))).pad.length, 500);
  assert.equal(text(m.get('conversations/é.chat.json')), '{"title":"naïve — ünïcode"}');
  assert.deepEqual(m.get('blobs/abc'), bin);
});

test('text is deflated when that makes it smaller; binary is stored', async () => {
  const z = await zip([{ name: 'big.json', data: 'a'.repeat(10_000) }, { name: 'blobs/x', data: new Uint8Array(100) }]);
  assert.ok(z.length < 2000, `10 KB of repeated text should compress; got ${z.length} bytes`);
});

// Made by Python's zipfile with ZIP_DEFLATED — a zip this code did not write,
// with a folder entry, deflated text, and a stored binary.
const PY = 'UEsDBBQAAAAIAJi+M12BB2wpFQAAABMAAAANAAAAbWFuaWZlc3QuanNvbqtWys7MS1GyUkrOSCwpSEzOVqoFAFBLAwQUAAAACACYvjNdAAAAAAIAAAAAAAAABAAAAGRpci8DAFBLAwQUAAAACACYvjNdK4HOWBQAAAA0AQAAGQAAAGNvbnZlcnNhdGlvbnMvYS5jaGF0Lmpzb26rVqpQslLKSM3JyVcYJTOIIJVqAVBLAwQUAAAAAAAAACEAc4wFKQABAAAAAQAACQAAAGJsb2JzL3JhdwABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4fICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj9AQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVpbXF1eX2BhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ent8fX5/gIGCg4SFhoeIiYqLjI2Oj5CRkpOUlZaXmJmam5ydnp+goaKjpKWmp6ipqqusra6vsLGys7S1tre4ubq7vL2+v8DBwsPExcbHyMnKy8zNzs/Q0dLT1NXW19jZ2tvc3d7f4OHi4+Tl5ufo6err7O3u7/Dx8vP09fb3+Pn6+/z9/v9QSwECFAAUAAAACACYvjNdgQdsKRUAAAATAAAADQAAAAAAAAAAAAAAgAEAAAAAbWFuaWZlc3QuanNvblBLAQIUABQAAAAIAJi+M10AAAAAAgAAAAAAAAAEAAAAAAAAAAAAEAD9QUAAAABkaXIvUEsBAhQAFAAAAAgAmL4zXSuBzlgUAAAANAEAABkAAAAAAAAAAAAAAIABZAAAAGNvbnZlcnNhdGlvbnMvYS5jaGF0Lmpzb25QSwECFAAUAAAAAAAAACEAc4wFKQABAAAAAQAACQAAAAAAAAAAAAAAgAGvAAAAYmxvYnMvcmF3UEsFBgAAAAAEAAQA6wAAANYBAAAAAA==';

test('reads a zip made by another tool', async () => {
  const m = await unzip(Buffer.from(PY, 'base64'));
  assert.deepEqual([...m.keys()], ['manifest.json', 'conversations/a.chat.json', 'blobs/raw'], 'folder entries are skipped');
  assert.deepEqual(JSON.parse(text(m.get('manifest.json'))), { kind: 'chatpack' });
  assert.equal(JSON.parse(text(m.get('conversations/a.chat.json'))).x, 'hello '.repeat(50));
  assert.deepEqual([...m.get('blobs/raw')], [...Array(256).keys()]);
});

test('something that is not a zip is refused plainly', async () => {
  assert.ok(!isZip(new TextEncoder().encode('{"kind":"chatpack"}')));
  await assert.rejects(unzip(new TextEncoder().encode('not a zip at all, just some words here')), /not a zip/);
});

test('sha256 of bytes, as hex', async () => {
  assert.equal(await sha256Bytes(new TextEncoder().encode('abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
