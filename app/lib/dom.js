/* ==========================================================================
   DOM helpers and the few UI primitives everything else is built from.

   These replace every native prompt(), confirm() and alert() the app used to
   make: a native dialog cannot be styled, blocks the page, and is suppressed
   outright by some browsers. See DESIGN.md, interaction rule 2.
   ========================================================================== */

import { icon } from './icons.js';

export { icon };
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export function el(tag, cls, txt) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));

export const fmtDate = (iso, opts = { year: 'numeric', month: 'short', day: 'numeric' }) => {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleDateString(undefined, opts);
};

/** An icon-only button. The label is its tooltip and its accessible name. */
export function iconBtn(name, label, onClick, cls = '') {
  const b = el('button', `ibtn ${cls}`.trim());
  b.type = 'button';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.append(icon(name));
  if (onClick) b.onclick = (e) => { e.stopPropagation(); onClick(e); };
  return b;
}

/** A button with an icon and a word — for actions that deserve a name. */
export function btn(name, label, onClick, cls = '') {
  const b = el('button', `btn ${cls}`.trim());
  b.type = 'button';
  if (name) b.append(icon(name));
  b.append(el('span', null, label));
  if (onClick) b.onclick = (e) => { e.stopPropagation(); onClick(e); };
  return b;
}

/* ------------------------------------------------------------ floating */

let open = null;

export function closeFloat() {
  if (!open) return;
  open.remove();
  open = null;
  document.removeEventListener('mousedown', outside, true);
}
function outside(e) { if (open && !open.contains(e.target)) closeFloat(); }
export const floatOpen = () => Boolean(open);

/** Place a floating node under an element, or at a point, and keep it on screen. */
function float(node, anchor) {
  closeFloat();
  open = node;
  node.classList.add('float');
  document.body.append(node);
  const r = anchor instanceof Element
    ? anchor.getBoundingClientRect()
    : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
  const w = node.offsetWidth, h = node.offsetHeight;
  let x = r.left, y = r.bottom + 4;
  if (x + w > innerWidth - 8) x = Math.max(8, r.right - w);
  if (y + h > innerHeight - 8) y = Math.max(8, r.top - h - 4);
  node.style.left = `${x}px`;
  node.style.top = `${y}px`;
  setTimeout(() => document.addEventListener('mousedown', outside, true));
  return node;
}

/** The anchor for a menu opened by a click: the button, or the pointer. */
export const at = (e) => (e?.currentTarget instanceof Element && e.type === 'click'
  ? e.currentTarget : { x: e.clientX, y: e.clientY });

/**
 * A menu. Items are {label, run, icon?, danger?, checked?, hint?}, '-' for a
 * separator, or {heading}. Arrow keys move, Enter picks, Escape closes.
 */
export function menu(items, anchor) {
  const m = el('div', 'menu');
  m.setAttribute('role', 'menu');
  for (const it of items) {
    if (!it) continue;
    if (it === '-') { m.append(el('div', 'sep')); continue; }
    if (it.heading) { m.append(el('div', 'mhead', it.heading)); continue; }
    const b = el('button', `mi${it.danger ? ' danger' : ''}`);
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.append(it.icon ? icon(it.icon) : el('span', 'i-pad'));
    b.append(el('span', 'ml', it.label));
    if (it.checked) b.append(icon('check'));
    else if (it.hint) b.append(el('span', 'mk', it.hint));
    b.onclick = () => { closeFloat(); it.run(); };
    m.append(b);
  }
  m.addEventListener('keydown', (e) => {
    const bs = $$('button', m);
    const i = bs.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); bs[(i + 1) % bs.length]?.focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); bs[(i - 1 + bs.length) % bs.length]?.focus(); }
    if (e.key === 'Escape') { e.stopPropagation(); closeFloat(); }
  });
  float(m, anchor);
  return m;
}

/**
 * A filterable list: type to narrow, arrows to move, Enter to pick. With
 * `create`, typing a name that does not exist offers to make it — which is how
 * a new tag gets added without a separate "new tag" step.
 */
export function picker({ items, placeholder, onPick, anchor, create }) {
  const p = el('div', 'picker');
  const inp = el('input');
  inp.placeholder = placeholder;
  const list = el('div', 'plist');
  p.append(inp, list);

  let active = 0, shown = [];
  const mark = () => $$('.pi', list).forEach((x, k) => x.classList.toggle('on', k === active));
  const pick = (it) => { closeFloat(); it.create != null ? create(it.create) : onPick(it.value); };

  const draw = () => {
    const q = inp.value.trim().toLowerCase();
    shown = items.filter((i) => !q || i.label.toLowerCase().includes(q));
    if (create && q && !items.some((i) => i.label.toLowerCase() === q)) {
      shown.push({ label: `Create “${inp.value.trim()}”`, create: inp.value.trim(), icon: 'plus' });
    }
    active = Math.min(active, Math.max(0, shown.length - 1));
    list.textContent = '';
    shown.forEach((it, n) => {
      const b = el('button', 'pi');
      b.type = 'button';
      b.append(icon(it.icon || 'folder'));
      b.append(el('span', 'pl', it.label));
      // Highlight on hover without rebuilding: a rebuild under the pointer
      // swaps the element between mousedown and mouseup, and the click is lost.
      b.onmouseenter = () => { active = n; mark(); };
      b.onclick = () => pick(it);
      list.append(b);
    });
    if (!shown.length) list.append(el('div', 'pempty', 'No matches'));
    mark();
  };

  inp.oninput = () => { active = 0; draw(); };
  inp.onkeydown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, shown.length - 1); mark(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); mark(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (shown[active]) pick(shown[active]); }
    else if (e.key === 'Escape') { e.stopPropagation(); closeFloat(); }
  };
  draw();
  float(p, anchor);
  inp.focus();
  return p;
}

/* -------------------------------------------------------------- dialog */

/**
 * A modal. Resolves true/false, or the typed string (null on cancel) when
 * `input` is given. Built on <dialog> for its focus trapping and backdrop.
 *
 * It resolves from its own buttons and keys rather than waiting for the
 * dialog's `close` event: that event is queued behind rendering, and in a
 * page that is not painting it never arrives — the dialog closes and nothing
 * acts on the answer.
 */
export function dialog({ title, body, ok = 'OK', cancel = 'Cancel', danger = false, input = null }) {
  return new Promise((resolve) => {
    const d = el('dialog', 'dlg');
    const f = el('form');
    f.append(el('h3', null, title));
    if (body) for (const para of [].concat(body)) f.append(el('p', null, para));
    let inp = null;
    if (input) {
      inp = el('input');
      inp.value = input.value || '';
      inp.placeholder = input.placeholder || '';
      f.append(inp);
    }

    let done = false;
    const finish = (yes) => {
      if (done) return;
      done = true;
      if (d.open) d.close();
      d.remove();
      if (!inp) return resolve(yes);
      const v = inp.value.trim();
      resolve(yes && v ? v : null);
    };

    const row = el('div', 'dlg-actions');
    if (cancel) {
      const c = el('button', 'btn', cancel);
      c.type = 'button';
      c.onclick = () => finish(false);
      row.append(c);
    }
    const o = el('button', `btn ${danger ? 'danger' : 'primary'}`, ok);
    o.type = 'submit';
    row.append(o);
    f.append(row);
    f.onsubmit = (e) => { e.preventDefault(); finish(true); };
    d.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); finish(false); } });
    d.addEventListener('close', () => finish(false)); // closed some other way
    d.append(f);
    document.body.append(d);
    d.showModal();
    if (inp) { inp.focus(); inp.select(); } else o.focus();
  });
}

export const confirmDialog = (o) => dialog(o);
export const askText = (o) => dialog({ ...o, input: { value: o.value, placeholder: o.placeholder } });

/* --------------------------------------------------------------- toast */

/** A brief message, optionally with one action — usually Undo. */
export function toast(msg, action) {
  const host = $('#toasts');
  if (!host) return;
  const t = el('div', 'toast');
  t.append(el('span', null, msg));
  if (action) {
    const b = el('button', null, action.label);
    b.onclick = () => { action.run(); t.remove(); };
    t.append(b);
  }
  host.append(t);
  setTimeout(() => t.classList.add('out'), action ? 5200 : 3000);
  setTimeout(() => t.remove(), action ? 5600 : 3400);
}

/* --------------------------------------------------------- inline edit */

/**
 * An input dropped in place of a label: Enter or clicking away keeps it,
 * Escape abandons it. An unchanged or empty value counts as abandoning.
 */
export function inlineEdit(host, { value = '', placeholder = '', onCommit, onCancel }) {
  const inp = el('input', 'inline');
  inp.value = value;
  inp.placeholder = placeholder;
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    const v = inp.value.trim();
    if (commit && v && v !== value) onCommit(v);
    else onCancel?.();
  };
  inp.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  };
  inp.onblur = () => finish(true);
  for (const ev of ['click', 'mousedown', 'dblclick']) inp.addEventListener(ev, (e) => e.stopPropagation());
  host.append(inp);
  const focus = () => { inp.focus(); inp.select(); };
  if (inp.isConnected) focus(); else setTimeout(focus);
  return inp;
}
