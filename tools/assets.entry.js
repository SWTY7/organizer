/**
 * Entry point for the asset probe — Phase 0b.
 *
 * Answers three questions that gate the file format, read-only:
 *   1. Does Claude already hand us the text of uploaded documents?
 *   2. Is Claude's preview_url the original image, or a downscaled preview?
 *   3. Does ChatGPT turn a file id into bytes this page may actually fetch?
 *
 * It reports what assets *are* — status, type, size, dimensions — and never
 * what they contain. No filename, no document text, no signature from a signed
 * URL, and never the bearer token. The output is meant to be shareable.
 */

import { adapterForHost, SUPPORTED_HOSTS } from '../packages/adapters/index.js';
import { download } from '../packages/adapters/shared.js';

(async () => {
  const tag = (bg) => `background:${bg};color:#fff;padding:1px 4px;border-radius:3px`;
  const log = (...a) => console.log('%c assets ', tag('#555'), ...a);
  const bad = (...a) => console.log('%c FAIL   ', tag('#b3261e'), ...a);
  const big = (m, c) => console.log(`%c${m}`, `font-size:14px;font-weight:bold;color:${c}`);
  const GOOD = '#2d7d46', WARN = '#b26a00', ERR = '#b3261e';

  const adapter = adapterForHost(location.hostname);
  if (!adapter) {
    big('Wrong site.', ERR);
    console.log(
      `This probe runs on: ${SUPPORTED_HOSTS.join(', ')}\n` +
      `You are on: ${location.hostname}\n\n` +
      `Open one of those in a tab and paste this into ITS console.`
    );
    return;
  }

  big(`Asset probe — ${adapter.label}`, adapter.accent);
  log('read-only. Nothing leaves your browser, and no file contents are recorded.');
  log('scanning up to 40 conversations for one that has an attachment; ~3 requests/second.');

  const result = { probedAt: new Date().toISOString(), site: location.hostname,
                   provider: adapter.id, kind: 'assets' };
  try {
    Object.assign(result, { init: await adapter.init() });
    await adapter.probeAssets(result, (m) => log(m));
  } catch (e) {
    bad(e.message);
    result.error = e.message;
    console.error(e);
  }

  console.log(JSON.stringify(result, null, 2));

  // ---- the answers, in words ------------------------------------------
  if (adapter.id === 'claude') {
    const a = result.attachments;
    if (!a) {
      big('No attachments found in the conversations scanned.', WARN);
      log('Upload a PDF or an image to any chat, then run this again.');
    } else if (a.hasExtractedContent) {
      big(`DOCUMENT TEXT IS ALREADY HERE — ${a.extractedChars} characters, no fetch needed`, GOOD);
      log('The converter currently reads files[] and ignores attachments[], so this is being thrown away.');
    } else {
      big('Attachments carry no extracted text — documents need a real download.', WARN);
    }

    const f = result.files;
    if (f?.preview_url) {
      const got = f.preview_url.pixels, want = f.declared;
      if (!f.preview_url.ok) {
        big(`preview_url refused the request (HTTP ${f.preview_url.status})`, ERR);
      } else if (got && want && got.w >= want.w) {
        big(`preview_url IS the original — ${got.w}×${got.h}, ${f.preview_url.bytes} bytes`, GOOD);
      } else if (got) {
        big(`preview_url is DOWNSCALED — got ${got.w}×${got.h}, the file is ${want?.w}×${want?.h}`, WARN);
        log('Capturing images means finding the full-size endpoint, or accepting previews.');
      } else {
        big(`preview_url returned ${f.preview_url.type}, ${f.preview_url.bytes} bytes`, WARN);
      }
    } else if (!f) {
      big('No image files found in the conversations scanned.', WARN);
    }
  }

  if (adapter.id === 'chatgpt') {
    const d = result.download || {};
    if (!d.triedId) {
      big('No attachments or images found in the conversations scanned.', WARN);
      log('Upload a file or generate an image in any chat, then run this again.');
    } else if (!d.endpointOk) {
      big(`The download endpoint did not answer: ${d.error}`, ERR);
    } else if (!d.hasUrl) {
      big(`Endpoint answered, but with no URL in it. Keys: ${(d.keys || []).join(', ')}`, WARN);
    } else if (d.fetched?.ok) {
      const px = d.fetched.pixels ? `, ${d.fetched.pixels.w}×${d.fetched.pixels.h}` : '';
      big(`FILES ARE RETRIEVABLE — ${d.fetched.bytes} bytes${px} from ${d.host}`, GOOD);
      log(d.crossOrigin
        ? 'The URL is on another origin, so only the extension can fetch it.'
        : 'Same origin, with the session — the extension can do this too.');
    } else if (d.withToken?.ok) {
      big(`FILES ARE RETRIEVABLE, but only with the bearer token — ${d.withToken.bytes} bytes`, GOOD);
    } else if (d.fetched?.error) {
      big(`The URL exists but this page cannot fetch it: ${d.fetched.error}`, WARN);
      log(`Host is ${d.host}.`);
    } else {
      big(`The download URL answered HTTP ${d.fetched?.status} with the session`, ERR);
      if (d.fetched?.refusal) log(`It said: ${d.fetched.refusal}`);
      if (d.anonymous) log(`Without cookies: HTTP ${d.anonymous.status}. With the token: HTTP ${d.withToken?.status}.`);
    }

    if (result.pointerRoutes) {
      const hit = Object.entries(result.pointerRoutes).find(([, r]) => r.fetched?.ok);
      if (hit) {
        const [name, r] = hit;
        const px = r.fetched.pixels ? `, ${r.fetched.pixels.w}×${r.fetched.pixels.h}` : '';
        big(`GENERATED IMAGES: the "${name}" route works — ${r.fetched.bytes} bytes${px}`, GOOD);
      } else {
        big('GENERATED IMAGES: none of the candidate routes answered', WARN);
        for (const [name, r] of Object.entries(result.pointerRoutes)) {
          log(`  ${name}: ${r.ok ? `answered, url=${r.hasUrl}` : r.error}`);
        }
        log('The pointer\'s own metadata is in the output as "pointerMeta" — the route may be in there.');
      }
    }
    if (result.pointer?.scheme && result.pointer.scheme !== 'file-service') {
      log(`Note: asset_pointer scheme is "${result.pointer.scheme}", not the file-service the format assumed.`);
    }
  }

  window.__assets = { schema: result, save: () => download(result, `assets-${adapter.id}.json`) };
  big('NEXT:  copy(__assets.schema)   then paste that back to Claude', '#444');
})();
