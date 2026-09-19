/* ==========================================================================
   Keeping attachments: turning image and file references into saved bytes,
   at capture time, while the provider still has them.

   Signed URLs expire and old uploads get deleted, so anything not captured
   now may be gone for good — that is why this happens in the capturer, and
   why it is on by default.

   Provider knowledge stays in the adapters (`fetchAsset`); this walks the
   converted conversations, fetches each distinct reference once, and records
   the result on the block as `blobHash` (SPEC.md, "srcRef vs blobHash"). A
   reference that cannot be fetched is left as it was — still a valid block,
   shown as "not downloaded" — and counted, never silently dropped.
   ========================================================================== */

import { sha256Bytes } from './zip.js';

export const ASSET_LIMITS = {
  perFile: 50 * 1024 * 1024,    // a single file larger than this is left as a reference
  total: 1024 * 1024 * 1024,    // stop fetching once an export holds this much
};

/** Every block in these conversations that points at bytes not yet held. */
export function pendingAssets(convs) {
  const out = [];
  for (const c of convs) {
    for (const m of c.messages || []) {
      for (const b of m.content || []) {
        if (b && b.srcRef && !b.blobHash && (b.type === 'image' || b.type === 'file')) out.push(b);
      }
    }
  }
  return out;
}

/**
 * @param convs      converted conversations; their blocks are updated in place
 * @param fetchAsset (block) => Promise<{ok, bytes, mime, status}|null>; null
 *                   means "this provider does not fetch this kind of block"
 * @returns {Promise<{blobs: Map<string, Uint8Array>, saved: number, failed:
 *   {name: string, why: string}[], skipped: number, bytes: number}>}
 */
export async function captureAssets(convs, fetchAsset, {
  limits = ASSET_LIMITS, pause = async () => {}, onProgress = () => {},
} = {}) {
  const blobs = new Map();
  const byRef = new Map();   // srcRef -> {hash, mime} | 'failed', so each is fetched once
  const failed = [];
  let skipped = 0, bytes = 0, saved = 0;
  const todo = pendingAssets(convs);

  for (let i = 0; i < todo.length; i++) {
    const b = todo[i];
    onProgress({ done: i, total: todo.length, bytes });
    const name = b.filename || (b.type === 'image' ? 'an image' : 'a file');

    const known = byRef.get(b.srcRef);
    if (known && known !== 'failed') { b.blobHash = known.hash; b.mime ||= known.mime; continue; }
    if (known === 'failed') continue;

    const declared = b.meta?.sizeBytes ?? b.meta?.declaredBytes ?? null;
    if (declared != null && declared > limits.perFile) { skipped++; continue; }
    if (bytes >= limits.total) { skipped++; continue; }

    let r;
    try {
      r = await fetchAsset(b);
    } catch (e) {
      r = { ok: false, why: e.message };
    }
    if (r === null) continue; // not something this provider fetches
    if (i < todo.length - 1) await pause();
    if (!r?.ok || !r.bytes) {
      byRef.set(b.srcRef, 'failed');
      failed.push({ name, why: r?.why || (r?.status ? `HTTP ${r.status}` : 'no data') });
      continue;
    }
    if (r.bytes.length > limits.perFile || bytes + r.bytes.length > limits.total) { skipped++; continue; }

    const hash = await sha256Bytes(r.bytes);
    if (!blobs.has(hash)) { blobs.set(hash, r.bytes); bytes += r.bytes.length; }
    b.blobHash = hash;
    if (r.mime && !b.mime) b.mime = r.mime;
    byRef.set(b.srcRef, { hash, mime: b.mime });
    saved++;
  }
  onProgress({ done: todo.length, total: todo.length, bytes });
  return { blobs, saved, failed, skipped, bytes };
}
