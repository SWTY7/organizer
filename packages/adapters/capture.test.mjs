import test from 'node:test';
import assert from 'node:assert/strict';
import { captureAssets, pendingAssets } from './capture.js';
import { sha256Bytes } from './zip.js';

const bytes = (s) => new TextEncoder().encode(s);
const conv = (...blocks) => ({ messages: [{ content: blocks }] });
const img = (ref, extra = {}) => ({ type: 'image', srcRef: ref, filename: `${ref}.png`, ...extra });

test('only unresolved image and file references are pending', () => {
  const c = [conv(img('a'), { type: 'text', text: 'hi' }, img('b', { blobHash: 'x' }), { type: 'file', srcRef: 'f' }, { type: 'image' })];
  assert.deepEqual(pendingAssets(c).map((b) => b.srcRef), ['a', 'f']);
});

test('fetched bytes are hashed, kept once, and recorded on the block', async () => {
  const c = [conv(img('a'), img('b')), conv(img('a'))];
  const calls = [];
  const r = await captureAssets(c, async (b) => { calls.push(b.srcRef); return { ok: true, bytes: bytes(b.srcRef === 'a' ? 'AAA' : 'AAA'), mime: 'image/png' }; });
  assert.deepEqual(calls, ['a', 'b'], 'the second "a" is not fetched again');
  const h = await sha256Bytes(bytes('AAA'));
  assert.equal(r.blobs.size, 1, 'identical bytes are stored once');
  assert.equal(r.saved, 2);
  assert.equal(r.bytes, 3);
  assert.equal(c[0].messages[0].content[0].blobHash, h);
  assert.equal(c[1].messages[0].content[0].blobHash, h, 'the repeat reference gets the hash too');
  assert.equal(c[0].messages[0].content[0].mime, 'image/png');
});

test('a refusal leaves the reference and is reported by name', async () => {
  const c = [conv(img('a'), img('b'))];
  const r = await captureAssets(c, async (b) => (b.srcRef === 'a' ? { ok: false, status: 403 } : { ok: true, bytes: bytes('B') }));
  assert.equal(r.saved, 1);
  assert.deepEqual(r.failed, [{ name: 'a.png', why: 'HTTP 403' }]);
  assert.equal(c[0].messages[0].content[0].blobHash, undefined);
  assert.equal(c[0].messages[0].content[0].srcRef, 'a', 'still a valid reference block');
});

test('a thrown error is a failure, not a crash', async () => {
  const r = await captureAssets([conv(img('a'))], async () => { throw new Error('session expired'); });
  assert.deepEqual(r.failed, [{ name: 'a.png', why: 'session expired' }]);
});

test('blocks a provider does not fetch are left alone, uncounted', async () => {
  const r = await captureAssets([conv(img('a'))], async () => null);
  assert.deepEqual([r.saved, r.failed.length, r.skipped], [0, 0, 0]);
});

test('size limits: too big a file, or too much in total, is skipped', async () => {
  const c = [conv(img('big', { meta: { sizeBytes: 999 } }), img('a'), img('b'), img('c'))];
  const r = await captureAssets(c, async (b) => ({ ok: true, bytes: bytes(b.srcRef.repeat(4)) }), { limits: { perFile: 100, total: 8 } });
  assert.equal(r.skipped, 2, 'the declared-huge one, and the one past the total');
  assert.equal(r.saved, 2);
  assert.equal(r.bytes, 8);
});
