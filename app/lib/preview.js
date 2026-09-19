/* ==========================================================================
   Rendering markup the model wrote — the one place provider text is allowed
   to become something other than escaped text.

   SVG is drawn as an <img>. A browser never runs script or fetches anything
   from an SVG loaded as an image, so that is safe with no further care, and
   it is shown straight away.

   HTML goes into an <iframe sandbox=""> — no scripts, no forms, no reaching
   the parent, an opaque origin — with a Content-Security-Policy that loads
   nothing from the network. It still waits for a click: a page can navigate
   its own frame (a meta refresh), which a policy does not stop, and a
   request the app did not make on your behalf is the thing this project
   promises not to do.
   ========================================================================== */

import { el, btn } from './dom.js';

const CSP = "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:";

export const looksLikeSvg = (text) => /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(text || '');

/** An SVG, as an image. */
export function svgImage(text) {
  const img = el('img', 'pv-svg');
  img.alt = 'SVG drawing';
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
  return img;
}

/** An HTML document in a sealed frame, behind a button. */
export function htmlFrame(text) {
  const box = el('div', 'pv-gate');
  box.append(
    el('p', null, 'An HTML page the model wrote. It renders sealed off: no scripts, and nothing loads from the internet.'),
    btn('external', 'Render it', () => {
      const f = el('iframe', 'pv-frame');
      f.setAttribute('sandbox', '');
      f.setAttribute('referrerpolicy', 'no-referrer');
      f.title = 'Rendered HTML, sandboxed';
      f.srcdoc = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}">${text}`;
      box.replaceWith(f);
    }),
  );
  return box;
}

/** Something to show for this markup, or null if it is not drawable. */
export function preview(text, kind) {
  if (kind === 'svg' || looksLikeSvg(text)) return svgImage(text);
  if (kind === 'html') return htmlFrame(text);
  return null;
}

/** The kind a code block's language suggests, if drawable. */
export function drawable(lang, text) {
  const l = String(lang || '').toLowerCase();
  if (l === 'svg' || ((l === 'xml' || !l) && looksLikeSvg(text))) return 'svg';
  if (l === 'html' || l === 'htm') return 'html';
  return null;
}
