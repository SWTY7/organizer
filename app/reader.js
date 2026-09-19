/* ==========================================================================
   The reader: one conversation, in a centred column.

   Templates, switched from the top bar:
     Transcript  every message, top to bottom, as a chat
     Outline     one line per exchange, open the ones you want
     Focus       one exchange at a time, set as a page
     Digest      only your questions, answers in the pop-up
     Gallery     code, tables, files, tool calls and links, as a grid
     Branches    the path down the page, other versions beside it, diffed
     Board       (`columns`) exchanges as cards in columns you arrange;
                 a card opens in a pop-up, the "sheet"

   The inspector (inspector.js) is the navigator for all three, so the reader
   has no rail or ribbon of its own any more.
   ========================================================================== */

import * as O from '../packages/organize/outline.js';
import * as SEC from '../packages/organize/sections.js';
import * as BR from '../packages/organize/branches.js';
import { diffWords } from '../packages/organize/diff.js';
import * as GAL from '../packages/organize/gallery.js';
import * as ART from '../packages/organize/artifacts.js';
import { preview, drawable } from './lib/preview.js';
import {
  S, R, PREFS, metaOf, convById, mainPath, folderPath, sectionsOf, setSection, clearSection,
  dropSections, removeTag, openConv, blockText, revealFolder, cardMovesOf, moveCard, resetCard,
  boardColsOf, addBoardCol, renameBoardCol, dropBoardCol,
  blobUrl, shownSections, suggestionsOf, runSuggest, dismissSuggestion, keepSuggestions, unkeepSuggestions,
} from './core.js';
import {
  $, $$, el, icon, iconBtn, btn, menu, at, askText, confirmDialog, fmtDate, toast, picker, floatOpen, closeFloat,
} from './lib/dom.js';
import { md } from './lib/md.js';
import { movePicker, tagPicker, star, archive, remove, plural } from './actions.js';
import { provName } from './explorer.js';
import { renderNoteReader } from './notes.js';

export const TEMPLATES = {
  transcript: { label: 'Transcript', icon: 'rows', hint: 'Every message, top to bottom' },
  outline: { label: 'Outline', icon: 'outline', hint: 'One line per exchange — open the ones you want' },
  digest: { label: 'Digest', icon: 'msg', hint: 'Only your questions — find the one you asked' },
  focus: { label: 'Focus', icon: 'focus', hint: 'One exchange at a time, as a page · j / k to move' },
  branches: { label: 'Branches', icon: 'branch', hint: 'Every regenerate and edit, side by side, with what changed' },
  columns: { label: 'Board', icon: 'columns', hint: 'Exchanges as cards in columns — arrange them, click one to read it' },
  gallery: { label: 'Gallery', icon: 'grid', hint: 'Every code block, table, file, tool call and link, as a grid' },
};

/* ---------------------------------------------------------------- blocks */

function renderBlock(b) {
  switch (b.type) {
    case 'text': {
      const d = el('div', 'prose');
      d.innerHTML = md(b.text);
      // A fenced SVG or HTML block can be drawn, so it gets the full code
      // block — preview and source — rather than a bare <pre>.
      for (const c of d.querySelectorAll('pre > code[data-lang]')) {
        if (drawable(c.dataset.lang, c.textContent)) c.parentElement.replaceWith(codeBlock(c.textContent, c.dataset.lang));
      }
      return d;
    }
    case 'code': return codeBlock(b.text || '', b.lang);
    case 'thinking': {
      const n = Array.isArray(b.summaries) ? b.summaries.length : 0;
      const d = details(n ? `Thought · ${plural(n, 'step')}` : 'Thought', 'thinking');
      const inner = d.lastChild;
      if (n) { const ul = el('ul'); for (const s of b.summaries) ul.append(el('li', null, s)); inner.append(ul); }
      if (b.text) { const t = el('div', 'prose'); t.innerHTML = md(b.text); inner.append(t); }
      return d;
    }
    case 'tool_use': {
      const e = ART.editOf(b);
      const verb = { create: 'created', update: 'edited', insert: 'edited' }[e?.cmd] || 'changed';
      const d = details(e ? `Artifact · ${e.title || e.key} · ${verb} — the finished version is in Gallery` : `Tool call · ${b.name || 'tool'}`, 'tool');
      d.lastChild.append(codeBlock(b.text || (b.input != null ? JSON.stringify(b.input, null, 2) : ''), b.lang));
      return d;
    }
    case 'tool_result': {
      const d = details(b.isError ? 'Tool result · error' : `Tool result${b.meta?.kind ? ` · ${b.meta.kind}` : ''}`, 'tool');
      d.lastChild.append(codeBlock(b.text || ''));
      return d;
    }
    case 'file': {
      // An uploaded document usually arrives with its text already extracted,
      // so there is something real to show rather than a shrug.
      const saved = b.blobHash ? storedFile(b) : null;
      if (b.text) {
        const d = details(`${b.filename || 'Attached file'} · ${b.text.length.toLocaleString()} characters`, 'file');
        d.lastChild.append(codeBlock(b.text));
        if (!saved) return d;
        const both = el('div');
        both.append(saved, d);
        return both;
      }
      return saved || chip('file', b.filename || 'File', 'Not downloaded — captured as a reference');
    }
    case 'image': {
      if (b.blobHash) return storedImage(b);
      const dim = b.width && b.height ? `${b.width}×${b.height} · ` : '';
      return chip('image', b.filename || 'Image', `${dim}Not downloaded — captured as a reference`);
    }
    case 'citation':
      return chip('external', b.title || b.url || 'Citation', b.url || '');
    default: {
      const d = details(`Unrecognised block · ${b.type}`, 'tool');
      d.lastChild.append(codeBlock(JSON.stringify(b, null, 2), 'json'));
      return d;
    }
  }
}

/**
 * An image that was captured with the chat. Read from this browser's own
 * storage; if it is not there after all, say so rather than show a hole.
 */
export function storedImage(b, cls = 'img') {
  const fig = el('figure', cls);
  const img = el('img');
  img.alt = b.alt || b.filename || 'Image';
  img.loading = 'lazy';
  img.decoding = 'async';
  if (b.width && b.height) { img.width = b.width; img.height = b.height; }
  fig.append(img);
  blobUrl(b.blobHash).then((url) => {
    if (url) {
      img.src = url;
      img.title = 'Open full size';
      img.onclick = () => window.open(url, '_blank', 'noopener');
    } else {
      fig.replaceWith(chip('image', b.filename || 'Image', 'Not saved in this library — captured as a reference'));
    }
  });
  return fig;
}

const fmtBytes = (n) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} bytes`);

/** Save a stored blob to disk under its own name — it is already local. */
async function saveBlob(b) {
  const url = await blobUrl(b.blobHash);
  if (!url) { toast('That file is not saved in this library'); return; }
  const a = el('a');
  a.href = url;
  a.download = b.filename || 'file';
  a.click();
}

/** A file that was captured: its name, and Save / Open. */
export function storedFile(b) {
  const c = el('div', 'attach saved');
  const size = b.meta?.declaredBytes ? ` · ${fmtBytes(b.meta.declaredBytes)}` : '';
  c.append(icon('file'), el('span', 'an', b.filename || 'File'), el('span', 'as', `${b.mime || 'file'}${size} · saved`), el('span', 'grow'));
  if (/^(application\/pdf|image\/|text\/plain)/.test(b.mime || '')) {
    c.append(btn('external', 'Open', async () => {
      const url = await blobUrl(b.blobHash);
      if (url) window.open(url, '_blank', 'noopener'); else toast('That file is not saved in this library');
    }, 'ghost'));
  }
  c.append(btn('save', 'Save', () => saveBlob(b), 'ghost'));
  // Claim "saved" only once the bytes are confirmed to be here.
  blobUrl(b.blobHash).then((url) => {
    if (url) return;
    c.classList.remove('saved');
    for (const x of c.querySelectorAll('.btn')) x.remove();
    c.querySelector('.as').textContent = 'Not saved in this library — captured as a reference';
  });
  return c;
}

function details(label, kind) {
  const d = el('details', `blk ${kind}`);
  const s = el('summary');
  s.append(icon('chevR'), el('span', null, label));
  d.append(s, el('div', 'inner'));
  return d;
}

function chip(ico, name, sub) {
  const c = el('div', 'attach');
  c.append(icon(ico), el('span', 'an', name), el('span', 'as', sub));
  return c;
}

function codeBlock(text, lang) {
  const w = el('div', 'code');
  const bar = el('div', 'code-bar');
  bar.append(el('span', null, lang || ''), el('span', 'grow'));
  const kind = drawable(lang, text);
  const copy = iconBtn('copy', 'Copy', async () => {
    try { await navigator.clipboard.writeText(text); copy.classList.add('done'); setTimeout(() => copy.classList.remove('done'), 1200); }
    catch { /* clipboard refused — nothing useful to say */ }
  });
  bar.append(copy);
  const pre = el('pre');
  pre.append(el('code', null, text));
  if (!kind) { w.append(bar, pre); return w; }

  // Drawable: show it drawn, with the source a click away.
  const view = el('div', 'pv');
  const tabs = el('div', 'pv-tabs');
  const tab = (label, which) => {
    const b = el('button', 'pv-tab', label);
    b.type = 'button';
    b.onclick = () => show(which);
    return b;
  };
  const tP = tab('Preview', 'preview'), tS = tab('Source', 'source');
  const show = (which) => {
    view.textContent = '';
    view.append(which === 'preview' ? preview(text, kind) : pre);
    tP.classList.toggle('on', which === 'preview');
    tS.classList.toggle('on', which === 'source');
  };
  tabs.append(tP, tS);
  bar.insertBefore(tabs, bar.children[1]);
  w.append(bar, view);
  show('preview');
  return w;
}

/* -------------------------------------------------------------- messages */

function renderMessage(msg, kids, ctx) {
  const box = el('div', `msg ${msg.role}`);
  const who = el('div', 'who');
  who.append(el('span', 'wn', msg.role === 'user' ? 'You' : msg.role === 'assistant' ? ctx.assistant : msg.role));
  if (msg.model) who.append(el('span', 'wm', msg.model));
  if (msg.status && msg.status !== 'complete') who.append(el('span', 'wm', msg.status));

  const sibs = kids.get(msg.parentId) || [];
  if (sibs.length > 1) {
    const idx = sibs.findIndex((s) => s.id === msg.id);
    const br = el('span', 'branch');
    br.title = 'This message has alternatives — a regenerate or an edit';
    const goB = (d) => {
      S.branchPick.set(msg.parentId, sibs[(idx + d + sibs.length) % sibs.length].id);
      R.reader();
      R.inspector();
      ctx.onChange?.();
    };
    br.append(icon('branch'), iconBtn('chevL', 'Previous version', () => goB(-1)),
      el('span', null, `${idx + 1} / ${sibs.length}`), iconBtn('chevR', 'Next version', () => goB(1)));
    if (S.template !== 'branches') {
      br.append(btn(null, 'Compare', () => {
        S.template = 'branches';
        PREFS.save();
        closeSheet();
        R.reader();
        R.inspector();
        document.querySelector(`.fork[data-parent="${CSS.escape(msg.parentId ?? '')}"]`)?.scrollIntoView({ block: 'center' });
      }, 'ghost bcmp'));
    }
    who.append(br);
  }

  // Starting a section is offered on your messages, where topics begin.
  if (msg.role === 'user' && ctx.turnKey && !ctx.startsSection) {
    who.append(el('span', 'grow'), iconBtn('bookmark', 'Start a section here', async () => { await newSection(ctx.convId, ctx.turnKey); ctx.onChange?.(); }, 'hover'));
  }
  box.append(who);

  const body = el('div', 'body');
  for (const b of msg.content) body.append(renderBlock(b));
  box.append(body);
  return box;
}

/* --------------------------------------------------------------- sections */

export async function newSection(convId, key) {
  const t = await askText({ title: 'Start a section here', placeholder: 'Section name', ok: 'Add section' });
  if (!t) return;
  await setSection(convId, key, t);
  R.reader();
  R.inspector();
}

export async function renameSection(convId, key, current) {
  const t = await askText({ title: 'Rename section', value: current, ok: 'Rename' });
  if (!t) return;
  await setSection(convId, key, t);
  R.reader();
  R.inspector();
}

export async function removeSection(convId, key) {
  await clearSection(convId, key);
  R.reader();
  R.inspector();
}

/* ------------------------------------------------------------ suggestions */

export function suggestSections(convId, turns) {
  const n = runSuggest(convId, turns);
  R.reader();
  R.inspector();
  toast(n
    ? `${plural(n, 'suggested section')} — keep the ones that fit`
    : 'No clear change of topic found. Start a section yourself from the bookmark on any message.');
}
export async function keepOne(convId, key) {
  await keepSuggestions(convId, [key]);
  R.reader();
  R.inspector();
}
export async function dismissOne(convId, key) {
  await dismissSuggestion(convId, key);
  R.reader();
  R.inspector();
}

/** Keep and Dismiss, as buttons you can see — a guess must be easy to answer. */
function suggestionButtons(convId, key, small = false) {
  return small
    ? [iconBtn('check', 'Keep this section', () => keepOne(convId, key), 'sgk'),
      iconBtn('x', 'Dismiss this suggestion', () => dismissOne(convId, key))]
    : [btn('check', 'Keep', () => keepOne(convId, key), 'sgk'),
      btn(null, 'Dismiss', () => dismissOne(convId, key), 'ghost')];
}

function suggestionBar(convId) {
  const n = suggestionsOf(convId).length;
  if (!n) return null;
  const bar = el('div', 'note sugbar');
  bar.append(icon('wand'), el('span', null,
    `${plural(n, 'suggested section')}, guessed from pauses and changes of subject. Keep the ones that fit.`),
  el('span', 'grow'),
  btn('check', 'Keep all', async () => {
    const kept = await keepSuggestions(convId);
    R.reader(); R.inspector();
    toast(`Kept ${plural(kept.length, 'section')}`, {
      label: 'Undo', run: async () => { await unkeepSuggestions(convId, kept); R.reader(); R.inspector(); },
    });
  }, 'sgk'),
  btn(null, 'Dismiss all', async () => {
    for (const x of suggestionsOf(convId)) await dismissSuggestion(convId, x.startStableKey);
    R.reader(); R.inspector();
  }, 'ghost'));
  return bar;
}

function sectionHeading(convId, sec) {
  const h = el('div', `sec${sec.suggested ? ' sug' : ''}`);
  h.append(el('span', 'st', sec.title || 'Beginning'), el('span', 'sn', plural(sec.turns.length, 'exchange')));
  if (sec.suggested) {
    const tag = el('span', 'sgtag', 'Suggested');
    tag.title = 'A guess. Keep it to make it a section, or dismiss it.';
    h.append(tag, el('span', 'grow'), ...suggestionButtons(convId, sec.startKey));
  } else if (sec.startKey) {
    h.append(el('span', 'grow'),
      iconBtn('pencil', 'Rename section', () => renameSection(convId, sec.startKey, sec.title), 'hover'),
      iconBtn('x', 'Remove this section break', () => removeSection(convId, sec.startKey), 'hover'));
  }
  return h;
}

/* ------------------------------------------------------------- templates */

function transcript(col, groups, kids, ctx) {
  let i = 0;
  for (const sec of groups) {
    if (groups.length > 1) col.append(sectionHeading(ctx.convId, sec));
    for (const t of sec.turns) {
      const n = i++;
      const key = SEC.turnKey(t);
      const tctx = { ...ctx, turnKey: key, startsSection: sec.startKey === key };
      let first = null;
      for (const msg of [t.user, ...t.replies].filter(Boolean)) {
        const box = renderMessage(msg, kids, tctx);
        first ||= box;
        col.append(box);
      }
      if (first) { first.dataset.turn = n; S.turnEls[n] = first; }
    }
  }
}

function outline(col, groups, kids, ctx) {
  const total = groups.reduce((n, g) => n + g.turns.length, 0);
  const bar = el('div', 'obar');
  bar.append(el('span', null, plural(total, 'exchange') + (groups.length > 1 ? ` · ${plural(groups.length, 'section')}` : '')));
  const all = btn(null, S.openTurns.size === total ? 'Collapse all' : 'Expand all', () => {
    const open = S.openTurns.size !== total;
    S.openTurns = open ? new Set(Array.from({ length: total }, (_, k) => k)) : new Set();
    R.reader();
  }, 'ghost');
  bar.append(el('span', 'grow'), btn('wand', 'Suggest sections', () => suggestSections(ctx.convId, ctx.turns), 'ghost'), all);
  col.append(bar);

  let i = 0;
  for (const sec of groups) {
    if (groups.length > 1) col.append(sectionHeading(ctx.convId, sec));
    for (const t of sec.turns) {
      const n = i++;
      const key = SEC.turnKey(t);
      const open = S.openTurns.has(n);
      const row = el('div', `oturn${open ? ' open' : ''}`);
      row.dataset.turn = n;
      S.turnEls[n] = row;

      const head = el('button', 'ohead');
      head.type = 'button';
      head.append(el('span', 'onum', String(n + 1)), turnSummary(t), icon('chevR'));
      head.onclick = () => {
        if (S.openTurns.has(n)) S.openTurns.delete(n); else S.openTurns.add(n);
        R.reader();
      };
      row.append(head);
      if (open) {
        const detail = el('div', 'odetail');
        const tctx = { ...ctx, turnKey: key, startsSection: sec.startKey === key };
        for (const msg of [t.user, ...t.replies].filter(Boolean)) detail.append(renderMessage(msg, kids, tctx));
        row.append(detail);
      }
      col.append(row);
    }
  }
}

/**
 * One exchange as a page: your question as its title, the answer as a
 * document under it, and the answer's own headings as a way in. Focus shows
 * this inline; the board shows it as a pop-up. It is what makes Focus read
 * differently from Transcript, rather than being Transcript with less in it.
 */
function exchangePage(t, { n, total, where, kids, ctx }) {
  const page = el('div', 'xpage');
  const eyebrow = el('div', 'eyebrow');
  eyebrow.append(el('span', null, `Exchange ${n + 1} of ${total}`));
  if (where) eyebrow.append(el('span', null, '·'), el('span', null, where));
  page.append(eyebrow);

  const key = SEC.turnKey(t);
  const tctx = { ...ctx, turnKey: key };
  if (t.user) {
    const q = renderMessage(t.user, kids, tctx);
    // A pasted essay is not a title; only a question that reads as one gets
    // set as one.
    const len = (t.user.content || []).map(blockText).join(' ').length;
    q.classList.add(len > 280 ? 'long' : 'title');
    page.append(q);
  }
  const toc = el('nav', 'ptoc');
  const answer = el('div', 'xanswer');
  for (const m of t.replies) answer.append(renderMessage(m, kids, tctx));
  page.append(toc, answer);

  const hs = [...answer.querySelectorAll('.prose h1, .prose h2, .prose h3')];
  if (hs.length >= 2) {
    toc.append(el('span', 'ptl', 'In this answer'));
    for (const h of hs) {
      const b = el('button', 'pchip', h.textContent);
      b.type = 'button';
      b.onclick = () => h.scrollIntoView({ block: 'start', behavior: 'smooth' });
      toc.append(b);
    }
  } else toc.remove();
  return page;
}

function focus(col, groups, kids, ctx) {
  const flat = groups.flatMap((g) => g.turns.map((t) => ({ t, sec: g })));
  if (!flat.length) return;
  const n = Math.max(0, Math.min(S.focusAt, flat.length - 1));
  S.focusAt = n;
  const { t, sec } = flat[n];
  const key = SEC.turnKey(t);

  // Where you are, always in view: one tick per exchange, a gap between
  // sections, the ones behind you filled in. Click one to go there.
  const strip = el('div', 'fstrip');
  const ticks = el('div', 'fticks');
  flat.forEach((f, k) => {
    const b = el('button', `ftick${k === n ? ' on' : k < n ? ' done' : ''}${k && f.sec !== flat[k - 1].sec ? ' sb' : ''}`);
    b.type = 'button';
    b.title = `${k + 1}. ${f.t.user ? O.clip(O.plain(O.gist([f.t.user], 200)), 90) : '(continues)'}`;
    b.onclick = () => goTurn(k);
    ticks.append(b);
  });
  strip.append(ticks, el('span', 'fpos', `${n + 1} / ${flat.length}`));
  col.append(strip);

  const wrap = el('div', 'focus');
  wrap.dataset.turn = n;
  S.turnEls = [];
  S.turnEls[n] = wrap;
  wrap.append(exchangePage(t, {
    n, total: flat.length, where: groups.length > 1 ? sec.title || 'Beginning' : null,
    kids, ctx: { ...ctx, startsSection: sec.startKey === key },
  }));
  col.append(wrap);

  const nav = el('div', 'fnav');
  const side = (d, label, ico) => {
    const k = n + d;
    const b = el('button', `fbtn${d < 0 ? ' prev' : ' next'}`);
    b.type = 'button';
    if (k < 0 || k >= flat.length) { b.disabled = true; b.append(el('span', 'fl', label)); return b; }
    const q = flat[k].t.user ? O.clip(O.plain(O.gist([flat[k].t.user], 200)), 80) : '(continues)';
    b.append(el('span', 'fl', label), el('span', 'fq', q));
    b.prepend(icon(ico));
    b.onclick = () => goTurn(k);
    return b;
  };
  nav.append(side(-1, 'Previous', 'arrowL'), side(1, 'Next', 'arrowR'));
  col.append(nav);
}

/* ------------------------------------------------------------------ sheet */

/**
 * An exchange, full size, over whatever you were looking at — how the board
 * is read, since a card is a summary and a summary is not the answer.
 *
 * Previous and next go in true conversation order, not board order: the board
 * is where you file things, the order is what actually happened.
 */
let sheet = null;

function currentTurns() {
  const conv = convById(S.openId);
  if (!conv) return null;
  const { path, kids } = mainPath(conv);
  const turns = O.turns(path);
  return { conv, kids, turns, ctx: { convId: conv.id, assistant: provName(conv.provider), turns } };
}

export const sheetOpen = () => Boolean(sheet);
export function closeSheet() { sheet?.close(); }

export function openSheet(n) {
  if (sheet) { sheet.go(n); return; }
  const back = document.activeElement;
  const veil = el('div', 'sheet-veil');
  const panel = el('div', 'sheet');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  veil.append(panel);
  let i = n;

  const draw = () => {
    const cur = currentTurns();
    if (!cur || !cur.turns.length) { close(); return; }
    const { conv, kids, turns, ctx } = cur;
    i = Math.max(0, Math.min(i, turns.length - 1));
    const t = turns[i];
    const onBoard = S.template === 'columns';
    const groups = onBoard ? boardOf(conv.id, turns) : SEC.group(turns, shownSections(conv.id));
    const g = groups.find((x) => x.turns.includes(t));
    const where = groups.length > 1 && g ? g.title || 'Beginning' : null;
    const key = SEC.turnKey(t);

    panel.textContent = '';
    const top = el('div', 'sheet-top');
    const prev = iconBtn('arrowL', 'Previous exchange  ←', () => go(i - 1));
    const next = iconBtn('arrowR', 'Next exchange  →', () => go(i + 1));
    prev.disabled = i === 0;
    next.disabled = i === turns.length - 1;
    top.append(prev, next, el('span', 'sheet-pos', `${i + 1} of ${turns.length}`), el('span', 'grow'));
    if (onBoard && key) {
      const mv = btn('columns', g?.title || 'Beginning', (e) => cardPicker(conv.id, turns, key, at(e), draw));
      mv.title = 'Move this card to another column';
      top.append(mv);
    }
    top.append(iconBtn('x', 'Close  Esc', close, 'sheet-x'));

    const body = el('div', 'sheet-body');
    body.append(exchangePage(t, {
      n: i, total: turns.length, where, kids,
      ctx: { ...ctx, startsSection: g?.startKey === key, onChange: draw },
    }));
    panel.append(top, body);

    S.activeTurn = i;
    R.markActive(i);
    for (const c of $$('.colcard.on')) c.classList.remove('on');
    S.turnEls[i]?.classList.add('on');
  };
  const go = (k) => { i = k; draw(); };

  const onKey = (e) => {
    if (document.querySelector('dialog[open]')) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (floatOpen()) closeFloat(); else close();
    } else if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (e.key === 'ArrowLeft' || e.key === 'k') { e.preventDefault(); e.stopPropagation(); go(i - 1); }
      else if (e.key === 'ArrowRight' || e.key === 'j') { e.preventDefault(); e.stopPropagation(); go(i + 1); }
    }
  };
  function close() {
    document.removeEventListener('keydown', onKey, true);
    veil.remove();
    sheet = null;
    // Leave the card you were reading in view, so closing puts you back on
    // the board at what you just read.
    S.turnEls[i]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    (S.turnEls[i]?.querySelector('.cchead') || back)?.focus?.({ preventScroll: true });
  }
  veil.addEventListener('mousedown', (e) => { if (e.target === veil) close(); });
  document.addEventListener('keydown', onKey, true);
  sheet = { close, go };
  document.body.append(veil);
  draw();
  panel.querySelector('.sheet-x')?.focus({ preventScroll: true });
}

/* ------------------------------------------------------------------ board */

const DT_CARD = 'application/x-organizer-card';
const NEW_COL = '__new';

/** The board's columns: sections, then any made on the board, with moves applied. */
const boardOf = (convId, turns) =>
  SEC.applyMoves(turns, shownSections(convId), cardMovesOf(convId), boardColsOf(convId));

/** File a card under a column. Back to its own section clears the move
    rather than recording one that changes nothing. */
async function fileCard(convId, turns, key, target) {
  const natural = SEC.group(turns, shownSections(convId))
    .find((g) => g.turns.some((t) => SEC.turnKey(t) === key));
  const naturalKey = natural ? natural.startKey ?? SEC.BEGIN : SEC.BEGIN;
  const before = cardMovesOf(convId)[key];
  if (target === naturalKey) await resetCard(convId, key); else await moveCard(convId, key, target);
  R.reader();
  R.inspector();
  const name = boardOf(convId, turns).find((g) => g.key === target)?.title || 'Beginning';
  toast(`Moved to “${name}”`, {
    label: 'Undo',
    run: async () => {
      if (before == null) await resetCard(convId, key); else await moveCard(convId, key, before);
      R.reader(); R.inspector();
    },
  });
}

async function newColumn(convId, key = null) {
  const title = await askText({
    title: key ? 'Move to a new column' : 'New column',
    body: 'Columns made here arrange this board only. The conversation, and every other view of it, stay as they are.',
    placeholder: 'Column name', ok: 'Create',
  });
  if (!title) return;
  const id = await addBoardCol(convId, title, key);
  R.reader();
  R.inspector();
  toast(`Created “${title}”`, {
    label: 'Undo',
    run: async () => { await dropBoardCol(convId, id); R.reader(); R.inspector(); },
  });
}

function cardPicker(convId, turns, key, anchor, after) {
  const board = boardOf(convId, turns);
  const here = board.find((g) => g.turns.some((t) => SEC.turnKey(t) === key))?.key;
  const items = board.filter((g) => g.key !== here)
    .map((g) => ({ label: g.title || 'Beginning', value: g.key, icon: 'columns' }));
  items.push({ label: 'New column…', value: NEW_COL, icon: 'plus' });
  picker({
    items, anchor, placeholder: 'Move to a column…',
    onPick: async (v) => {
      if (v === NEW_COL) await newColumn(convId, key); else await fileCard(convId, turns, key, v);
      after?.();
    },
  });
}

function columnHead(convId, g) {
  const head = el('div', 'colhead');
  head.append(el('span', 'st', g.title || 'Beginning'), el('span', 'sn', String(g.turns.length)));
  if (g.suggested) {
    head.classList.add('sug');
    head.append(...suggestionButtons(convId, g.startKey, true));
  } else if (g.extra) {
    head.append(
      iconBtn('pencil', 'Rename column', async () => {
        const t = await askText({ title: 'Rename column', value: g.title, ok: 'Rename' });
        if (!t) return;
        await renameBoardCol(convId, g.key, t);
        R.reader();
      }, 'hover'),
      iconBtn('x', 'Remove column — its cards go back to their sections', async () => {
        const undo = await dropBoardCol(convId, g.key);
        R.reader(); R.inspector();
        toast(`Removed “${g.title}”`, { label: 'Undo', run: async () => { await undo(); R.reader(); R.inspector(); } });
      }, 'hover'));
  } else if (g.startKey) {
    head.append(
      iconBtn('pencil', 'Rename section', () => renameSection(convId, g.startKey, g.title), 'hover'),
      iconBtn('x', 'Remove this section break', () => removeSection(convId, g.startKey), 'hover'));
  }
  return head;
}

/** Make an element somewhere a card can be dropped. */
function dropTarget(node, onDrop) {
  node.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes(DT_CARD)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    node.classList.add('drop');
  });
  node.addEventListener('dragleave', (e) => {
    if (!node.contains(e.relatedTarget)) node.classList.remove('drop');
  });
  node.addEventListener('drop', (e) => {
    node.classList.remove('drop');
    if (!e.dataTransfer.types.includes(DT_CARD)) return;
    e.preventDefault();
    const key = e.dataTransfer.getData(DT_CARD);
    if (key) onDrop(key);
  });
}

/**
 * The board: one column per section, cards stacking down it — the layout for
 * "the main thread was A→B→C, but A had follow-ups".
 *
 * A card is a summary; click it to read the exchange in full, in a pop-up.
 * Drag it, or use its move button, to file it under another column — or into
 * a new one, which is how a chat with no sections gets arranged at all. That
 * is a board-only override (`SEC.applyMoves`) on top of the real grouping
 * every other view reads; see its doc comment for why it must stay that way.
 * Within a column cards stay in conversation order, and keep their numbers.
 */
function columns(col, groups, kids, ctx) {
  const convId = ctx.convId;
  const board = boardOf(convId, ctx.turns);
  const total = ctx.turns.length;

  const bar = el('div', 'obar');
  bar.append(el('span', null, `${plural(board.length, 'column')} · ${plural(total, 'exchange')}`));
  bar.append(el('span', 'bhint', '· click a card to read it, drag it to file it elsewhere'));
  bar.append(el('span', 'grow'));
  bar.append(btn('wand', 'Suggest columns', () => suggestSections(convId, ctx.turns), 'ghost'));
  bar.append(btn('plus', 'New column', () => newColumn(convId), 'ghost'));
  bar.append(iconBtn(S.colsTransposed ? 'columns' : 'swap',
    S.colsTransposed ? 'Lay columns out side by side' : 'Stack columns as rows',
    () => { S.colsTransposed = !S.colsTransposed; PREFS.save(); R.reader(); }));
  col.append(bar);

  const naturalOf = new Map();
  const titleOf = new Map();
  for (const g of groups) {
    const gk = g.startKey ?? SEC.BEGIN;
    titleOf.set(gk, g.title || 'Beginning');
    for (const t of g.turns) naturalOf.set(t, gk);
  }
  const trueIndex = new Map(ctx.turns.map((t, k) => [t, k]));

  const wrap = el('div', `cols${S.colsTransposed ? ' transposed' : ''}`);
  for (const g of board) {
    const section = el('div', `colsec${g.extra ? ' extra' : ''}${g.suggested ? ' sug' : ''}`);
    section.append(columnHead(convId, g));
    const list = el('div', 'collist');
    dropTarget(section, (key) => {
      if (!g.turns.some((t) => SEC.turnKey(t) === key)) fileCard(convId, ctx.turns, key, g.key);
    });

    if (!g.turns.length) list.append(el('div', 'colempty', 'Drop a card here'));
    for (const t of g.turns) {
      const n = trueIndex.get(t);
      const key = SEC.turnKey(t);
      const card = el('div', `colcard${sheetOpen() && n === S.activeTurn ? ' on' : ''}`);
      card.dataset.turn = n;
      S.turnEls[n] = card;

      const open = el('button', 'cchead');
      open.type = 'button';
      open.title = 'Read this exchange';
      open.append(el('span', 'onum', String(n + 1)), turnSummary(t, 140));
      open.onclick = () => openSheet(n);
      card.append(open);
      if (naturalOf.get(t) !== g.key) {
        card.append(el('div', 'cfrom', `from ${titleOf.get(naturalOf.get(t)) || 'Beginning'}`));
      }

      if (key) {
        card.append(iconBtn('columns', 'Move to another column', (e) => cardPicker(convId, ctx.turns, key, at(e)), 'cmove'));
        // The whole card is the handle. It never shows selectable prose — that
        // is in the pop-up — so there is no text selection for a drag to steal.
        card.draggable = true;
        card.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData(DT_CARD, key);
          e.dataTransfer.effectAllowed = 'move';
          card.classList.add('dragging');
          wrap.classList.add('dragging');
        });
        card.addEventListener('dragend', () => { card.classList.remove('dragging'); wrap.classList.remove('dragging'); });
      }
      list.append(card);
    }
    section.append(list);
    wrap.append(section);
  }

  // Always somewhere to start a new column, and to drop a card to do it.
  const add = el('button', 'colnew');
  add.type = 'button';
  add.append(icon('plus'), el('span', 'cn-t', 'New column'), el('span', 'cn-sub', 'or drop a card here'));
  add.onclick = () => newColumn(convId);
  dropTarget(add, (key) => newColumn(convId, key));
  wrap.append(add);
  col.append(wrap);
}

/* --------------------------------------------------------------- branches */

/** The words of a message worth comparing: its prose and code, not its
    thinking or tool calls, which differ between any two runs. */
const comparable = (m) => (m?.content || [])
  .filter((b) => b.type === 'text' || b.type === 'code')
  .map((b) => b.text || '').join('\n\n');

function follow(f, v) {
  const prev = S.branchPick.get(f.parentId);
  S.branchPick.set(f.parentId, v.msg.id);
  R.reader();
  R.inspector();
  toast(`Now reading version ${v.n}`, {
    label: 'Undo',
    run: () => {
      if (prev) S.branchPick.set(f.parentId, prev); else S.branchPick.delete(f.parentId);
      R.reader(); R.inspector();
    },
  });
}

function diffView(a, b) {
  const box = el('div', 'fdiff');
  const head = el('div', 'fdh');
  head.append(el('span', 'fdt', `What changed from version ${a.n} to version ${b.n}`), el('span', 'grow'));
  const leg = el('span', 'fleg');
  leg.append(el('del', null, 'removed'), el('ins', null, 'added'));
  head.append(leg);
  box.append(head);

  const d = diffWords(comparable(a.msg), comparable(b.msg));
  if (d.same < 0.15) {
    box.append(el('div', 'fdnote',
      'These two versions have almost nothing in common, so a word-by-word comparison would be one long deletion and one long insertion. Read them side by side above instead.'));
    return box;
  }
  const body = el('div', 'fdbody');
  for (const o of d.ops) body.append(o.op === '=' ? document.createTextNode(o.text) : el(o.op === '-' ? 'del' : 'ins', null, o.text));
  box.append(body);
  box.append(el('div', 'fdnote', `${Math.round(d.same * 100)}% unchanged`));
  return box;
}

function forkBlock(f, kids) {
  const box = el('div', 'fork');
  box.dataset.parent = f.parentId ?? '';
  const head = el('div', 'fkh');
  head.append(icon('branch'), el('span', null,
    `${f.versions.length} versions of ${f.role === 'user' ? 'your question' : 'the reply'}`));
  box.append(head);

  // Which version the comparison is against. Open by default: seeing what
  // changed is the reason to come here. Closing it is remembered per fork.
  const others = f.versions.filter((v) => !v.onPath);
  const pick = S.compare.has(f.parentId) ? S.compare.get(f.parentId) : others[0]?.msg.id;
  const base = f.versions.find((v) => v.onPath);
  const against = others.find((v) => v.msg.id === pick) || null;

  const track = el('div', 'ftrack');
  for (const v of f.versions) {
    const card = el('div', `fver${v.onPath ? ' on' : ''}${against?.msg.id === v.msg.id ? ' cmp' : ''}`);
    const vh = el('div', 'fvh');
    vh.append(el('span', 'fvn', `Version ${v.n}`));
    if (v.onPath) vh.append(el('span', 'fvtag', 'Showing'));
    vh.append(el('span', 'grow'), el('span', 'fvd', fmtDate(v.msg.createdAt, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })));
    card.append(vh);

    const body = el('div', 'fvbody');
    for (const b of v.msg.content || []) body.append(renderBlock(b));
    // An edited question is known by where it led, not just by its wording.
    if (f.role === 'user') {
      const reply = (kids.get(v.msg.id) || []).at(-1);
      const g = reply && O.gist([reply], 220);
      if (g) body.append(el('div', 'fvreply', g));
    }
    card.append(body);

    const foot = el('div', 'fvf');
    foot.append(el('span', 'fva', v.after ? `then ${plural(v.after, 'more message')}` : 'ends here'), el('span', 'grow'));
    const more = btn(null, 'Show all', () => {
      const full = card.classList.toggle('full');
      more.lastChild.textContent = full ? 'Show less' : 'Show all';
    }, 'ghost');
    foot.append(more);
    if (!v.onPath) {
      if (others.length > 1 || !against) {
        foot.append(btn(null, against?.msg.id === v.msg.id ? 'Comparing' : 'Compare', () => {
          S.compare.set(f.parentId, v.msg.id); R.reader();
        }, 'ghost'));
      }
      foot.append(btn('branch', 'Follow this version', () => follow(f, v)));
    }
    card.append(foot);
    track.append(card);
  }
  box.append(track);

  if (against && base) {
    const d = diffView(base, against);
    d.querySelector('.fdh').append(iconBtn('x', 'Hide the comparison', () => { S.compare.set(f.parentId, ''); R.reader(); }));
    box.append(d);
  }
  return box;
}

/**
 * The conversation's real shape: the path you are reading runs down the page,
 * and wherever a message has other versions — a regenerate, an edit — they
 * sit side by side at that point, with what changed between them. Built only
 * from the captured tree; nothing here is inferred.
 */
function branches(col, groups, kids, ctx) {
  const fs = BR.forks(ctx.path, kids);
  const turnOf = new Map();
  ctx.turns.forEach((t, i) => { for (const m of [t.user, ...t.replies]) if (m) turnOf.set(m.id, i); });
  const at = new Map();
  for (const f of fs) {
    const i = turnOf.get(ctx.path[f.at].id);
    (at.get(i) ?? at.set(i, []).get(i)).push(f);
  }

  const bar = el('div', 'obar');
  bar.append(el('span', null, fs.length
    ? `${plural(fs.length, 'fork')} · ${plural(ctx.turns.length, 'exchange')} on the path you are reading`
    : plural(ctx.turns.length, 'exchange')));
  col.append(bar);
  if (!fs.length) {
    col.append(el('div', 'note',
      'Nothing branches here. A fork appears when you regenerate a reply or edit a question — then every version shows up here side by side, with what changed between them.'));
  }

  const spine = el('div', 'bspine');
  ctx.turns.forEach((t, i) => {
    const row = el('button', `brow${at.has(i) ? ' forked' : ''}`);
    row.type = 'button';
    row.title = 'Read this exchange';
    row.dataset.turn = i;
    row.append(el('span', 'onum', String(i + 1)), turnSummary(t, 160));
    row.onclick = () => openSheet(i);
    S.turnEls[i] = row;
    spine.append(row);
    for (const f of at.get(i) || []) spine.append(forkBlock(f, kids));
  });
  col.append(spine);
}

/* ---------------------------------------------------------------- digest */

/** A question as plain text, with anything attached named rather than lost. */
function questionText(m) {
  if (!m) return '';
  const parts = [];
  for (const b of m.content || []) {
    if (b.type === 'text' && b.text) parts.push(b.text.trim());
    else if (b.type === 'code') parts.push(`[code${b.lang ? ` · ${b.lang}` : ''}]`);
    else if (b.type === 'file' || b.type === 'image') parts.push(`[${b.filename || b.type}]`);
  }
  return parts.join('\n');
}

/**
 * Only your questions, in full, in order — for finding the thing you know you
 * asked somewhere in a long session. Answers open in the pop-up, so the list
 * stays a list you can scan.
 */
function digest(col, groups, kids, ctx) {
  const bar = el('div', 'obar');
  bar.append(el('span', null, plural(ctx.turns.filter((t) => t.user).length, 'question')));
  const find = el('input', 'dfind');
  find.type = 'search';
  find.placeholder = 'Find a question';
  find.value = S.digestFilter;
  bar.append(el('span', 'grow'), find);
  bar.append(btn('copy', 'Copy questions', async () => {
    const text = ctx.turns.map((t, i) => (t.user ? `${i + 1}. ${questionText(t.user)}` : null)).filter(Boolean).join('\n\n');
    try { await navigator.clipboard.writeText(text); toast(`Copied ${plural(ctx.turns.filter((t) => t.user).length, 'question')}`); }
    catch { toast('The browser did not allow copying here'); }
  }, 'ghost'));
  col.append(bar);

  const words = (t) => O.stats(t.replies).words;
  const max = Math.max(1, ...ctx.turns.map(words));
  const rows = [];
  const heads = [];
  let i = 0;
  for (const sec of groups) {
    let h = null;
    if (groups.length > 1) { h = el('div', `dsec${sec.suggested ? ' sug' : ''}`, sec.title || 'Beginning'); col.append(h); }
    const from = rows.length;
    for (const t of sec.turns) {
      const n = i++;
      const q = questionText(t.user) || '(continues from the previous reply)';
      const row = el('button', `dq${t.user ? '' : ' none'}`);
      row.type = 'button';
      row.dataset.turn = n;
      row.title = 'Read the answer';
      const w = words(t);
      const len = el('span', 'dlen');
      len.style.setProperty('--w', `${Math.round(Math.sqrt(w / max) * 100)}%`);
      len.title = `${w.toLocaleString()} words in the answer`;
      row.append(el('span', 'onum', String(n + 1)), el('span', 'dqt', q), len);
      row.onclick = () => openSheet(n);
      row._hay = q.toLowerCase();
      S.turnEls[n] = row;
      rows.push(row);
      col.append(row);
    }
    if (h) heads.push({ h, from, to: rows.length });
  }
  const none = el('div', 'dnone', 'No question matches.');
  col.append(none);

  // Hide rather than re-render, so typing keeps its place.
  const apply = () => {
    const q = S.digestFilter.trim().toLowerCase();
    for (const r of rows) r.hidden = Boolean(q) && !r._hay.includes(q);
    for (const { h, from, to } of heads) h.hidden = rows.slice(from, to).every((r) => r.hidden);
    none.hidden = !q || rows.some((r) => !r.hidden);
  };
  find.oninput = () => { S.digestFilter = find.value; apply(); };
  apply();
}

/* --------------------------------------------------------------- gallery */

const KIND_ICON = { artifact: 'file', code: 'code', table: 'table', image: 'image', file: 'file', tool: 'tool', link: 'link' };

function galleryCard(it, t, n) {
  const card = el('div', `gitem k-${it.kind}${it.isError ? ' err' : ''}`);
  const head = el('div', 'gh');
  let label;
  switch (it.kind) {
    case 'code': label = it.lang || 'code'; break;
    case 'table': label = `${plural(it.columns.length, 'column')} × ${plural(it.rows, 'row')}`; break;
    case 'link': try { label = new URL(it.url).hostname.replace(/^www\./, ''); } catch { label = 'link'; } break;
    default: label = it.title;
  }
  head.append(icon(KIND_ICON[it.kind]), el('span', 'gl', label), el('span', 'grow'));
  const from = el('button', 'gfrom', `#${n + 1}`);
  from.type = 'button';
  from.title = `From exchange ${n + 1}${t.user ? ` — ${O.clip(O.plain(O.gist([t.user], 200)), 80)}` : ''}. Open it.`;
  from.onclick = () => openSheet(n);
  head.append(from);
  card.append(head);

  const body = el('div', 'gb');
  let long = false;
  const drawn = it.kind === 'code' && drawable(it.lang, it.text);
  if (drawn) {
    body.append(preview(it.text, drawn));
  } else if (it.kind === 'code' || it.kind === 'tool' || (it.kind === 'file' && it.text && !it.blobHash)) {
    const pre = el('pre');
    pre.append(el('code', null, it.text || ''));
    body.append(pre);
    long = (it.text || '').split('\n').length > 12;
  } else if (it.kind === 'table') {
    const d = el('div', 'prose');
    d.innerHTML = md(it.text);
    body.append(d);
    long = it.rows > 6;
  } else if (it.kind === 'link') {
    const a = el('a', 'glink', it.title || it.url);
    a.href = it.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    body.append(a);
    if (it.title) body.append(el('div', 'gurl', it.url));
  } else if (it.blobHash && it.kind === 'image') {
    body.append(storedImage(it, 'gimg'));
  } else if (it.blobHash) {
    body.append(storedFile(it));
  } else {
    body.append(el('div', 'gref', `${it.kind === 'image' && it.width ? `${it.width}×${it.height} · ` : ''}Not downloaded — captured as a reference`));
  }
  card.append(body);

  if (it.text || long) {
    const foot = el('div', 'gf');
    foot.append(el('span', 'grow'));
    if (long) {
      const more = btn(null, 'Show all', () => {
        more.lastChild.textContent = card.classList.toggle('full') ? 'Show less' : 'Show all';
      }, 'ghost');
      foot.append(more);
    }
    if (it.text) {
      const copy = iconBtn('copy', 'Copy', async () => {
        try { await navigator.clipboard.writeText(it.text); copy.classList.add('done'); setTimeout(() => copy.classList.remove('done'), 1200); }
        catch { /* refused */ }
      });
      foot.append(copy);
    }
    card.append(foot);
  }
  return card;
}

const ART_LABEL = { html: 'HTML page', svg: 'SVG drawing', react: 'React component', mermaid: 'Mermaid diagram', markdown: 'Document', code: 'Code' };
const ART_EXT = { html: 'html', svg: 'svg', react: 'jsx', mermaid: 'mmd', markdown: 'md' };
const LANG_EXT = { python: 'py', javascript: 'js', typescript: 'ts', rust: 'rs', bash: 'sh', ruby: 'rb', csharp: 'cs', markdown: 'md', yaml: 'yml' };

/** Save a document to disk. Made here, from text already on the page; nothing is fetched. */
function saveText(text, name, mime = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const a = el('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** A rebuilt artifact: the finished document, drawn when it can be. */
function artifactCard(a) {
  const card = el('div', `gitem k-artifact kind-${a.kind}`);
  const head = el('div', 'gh');
  head.append(icon('file'), el('span', 'gl', a.title), el('span', 'grow'));
  const from = el('button', 'gfrom', `#${a.turn + 1}`);
  from.type = 'button';
  from.title = `Last changed in exchange ${a.turn + 1}. Open it.`;
  from.onclick = () => openSheet(a.turn);
  head.append(from);
  card.append(head);

  const sub = [ART_LABEL[a.kind] + (a.kind === 'code' && a.lang ? ` · ${a.lang}` : ''),
    a.edits > 1 ? `${a.edits} versions` : 'one version'];
  const meta = el('div', 'gsub', sub.join(' · '));
  if (a.failed) {
    meta.append(el('span', 'gwarn', ` · ${plural(a.failed, 'edit')} could not be applied — shown as far as it could be rebuilt`));
  }
  card.append(meta);

  const body = el('div', 'gb');
  const drawn = preview(a.content, a.kind);
  if (drawn) body.append(drawn);
  else if (a.kind === 'markdown') { const d = el('div', 'prose'); d.innerHTML = md(a.content); body.append(d); }
  else {
    const pre = el('pre');
    pre.append(el('code', null, a.content));
    body.append(pre);
    if (a.kind === 'react' || a.kind === 'mermaid') {
      card.append(el('div', 'gnote', 'Displaying this would mean running code the model wrote, so it is shown as source.'));
    }
  }
  card.append(body);

  const foot = el('div', 'gf');
  foot.append(el('span', 'grow'));
  if (!drawn && a.content.split('\n').length > 12) {
    const more = btn(null, 'Show all', () => {
      more.lastChild.textContent = card.classList.toggle('full') ? 'Show less' : 'Show all';
    }, 'ghost');
    foot.append(more);
  }
  const base = String(a.key).split('/').pop();
  const ext = ART_EXT[a.kind] || LANG_EXT[a.lang] || a.lang || 'txt';
  const name = /\.[a-z0-9]+$/i.test(base) ? base : `${(a.title || 'artifact').replace(/[\\/:*?"<>|]+/g, ' ').trim()}.${ext}`;
  foot.append(iconBtn('save', `Save as ${name}`, () => saveText(a.content, name, a.kind === 'svg' ? 'image/svg+xml' : a.kind === 'html' ? 'text/html' : 'text/plain')));
  const copy = iconBtn('copy', 'Copy', async () => {
    try { await navigator.clipboard.writeText(a.content); copy.classList.add('done'); setTimeout(() => copy.classList.remove('done'), 1200); }
    catch { /* refused */ }
  });
  foot.append(copy);
  card.append(foot);
  return card;
}

/**
 * Everything that is not prose — code, tables, images, files, tool calls,
 * links — as a grid, filterable by kind, each with its way back to the
 * exchange it came from. The answer to "where was that snippet".
 */
function gallery(col, groups, kids, ctx) {
  const arts = ART.artifacts(ctx.turns).map((a) => ({ kind: 'artifact', turn: a.turn, art: a }));
  const all = [...arts, ...GAL.items(ctx.turns)];
  const c = GAL.counts(all);
  if (S.galleryKind && !c[S.galleryKind]) S.galleryKind = '';

  const bar = el('div', 'obar gbar');
  const chip = (kind, label, n) => {
    const b = el('button', `gchip${S.galleryKind === kind ? ' on' : ''}`);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(S.galleryKind === kind));
    if (kind) b.append(icon(KIND_ICON[kind]));
    b.append(el('span', null, label), el('span', 'gn', String(n)));
    b.onclick = () => { S.galleryKind = kind; R.reader(); };
    return b;
  };
  bar.append(chip('', 'All', all.length));
  for (const [k, label] of Object.entries(GAL.KINDS)) if (c[k]) bar.append(chip(k, label, c[k]));
  col.append(bar);

  if (!all.length) {
    col.append(el('div', 'note', 'Nothing but prose here — no code, tables, images, files, tool calls or links.'));
    return;
  }
  const grid = el('div', 'gal');
  for (const it of all) {
    if (S.galleryKind && it.kind !== S.galleryKind) continue;
    grid.append(it.kind === 'artifact' ? artifactCard(it.art) : galleryCard(it, ctx.turns[it.turn], it.turn));
  }
  col.append(grid);
}

/** The one line that stands in for a whole exchange. */
export function turnSummary(t, width = 160) {
  const mid = el('span', 'osum');
  const q = t.user ? O.clip(O.plain(O.gist([t.user], 400) || '(no text)'), width) : '(continues)';
  mid.append(el('span', 'oq', q));
  // A reply the model gave sections to is better summarised by those sections.
  const hs = O.headings(t.replies, 4);
  const g = hs.length > 1 ? hs.map((h) => h.text).join('  ·  ') : O.gist(t.replies);
  if (g) mid.append(el('span', 'og', g));
  const bits = O.badges(O.stats(t.replies));
  if (bits.length) mid.append(el('span', 'ob', bits.join(' · ')));
  return mid;
}

/* ------------------------------------------------------------ navigation */

/** Go to exchange i, however the current template reaches one. */
export function goTurn(i) {
  const n = Math.max(0, Math.min(i, (S.turnCount || 1) - 1));
  if (S.template === 'focus') {
    S.focusAt = n;
    S.activeTurn = n;
    R.reader();
    R.markActive(n);
    $('.rd-scroll')?.scrollTo({ top: 0 });
    return;
  }
  if (S.template === 'columns' || S.template === 'digest' || S.template === 'gallery') {
    // Where exchanges are summaries, going to one means reading it.
    S.turnEls[n]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    openSheet(n);
    return;
  }
  if (S.template === 'outline' && !S.openTurns.has(n)) {
    S.openTurns.add(n);
    R.reader();
  }
  const node = S.turnEls[n];
  if (!node) return;
  // Columns scrolls in two directions — centre the target column as well as
  // bringing the card into view, or the jump can land off to the side.
  node.scrollIntoView({ block: 'start', behavior: 'smooth' });
  S.activeTurn = n;
  R.markActive(n);
}

function trackActive() {
  // Neither template has one reading order to track a position along:
  // Focus shows a single exchange, and Columns is a 2D board.
  if (S.template === 'focus' || S.template === 'columns' || S.template === 'gallery' || S.template === 'digest') return;
  const sc = $('.rd-scroll');
  if (!sc) return;
  const top = sc.getBoundingClientRect().top + 60;
  const tops = S.turnEls.map((n) => (n?.isConnected ? n.getBoundingClientRect().top : Infinity));
  const i = O.activeIndex(tops, top);
  if (i !== S.activeTurn) { S.activeTurn = i; R.markActive(i); }
}

/* ------------------------------------------------------------------ top */

function topbar(conv) {
  const bar = el('div', 'rd-top');
  bar.append(iconBtn('sidebarL', 'Show or hide the sidebar  [', () => {
    S.showExplorer = !S.showExplorer; PREFS.save(); R.all();
  }, S.showExplorer ? 'on' : ''));

  const crumb = el('div', 'crumb');
  if (conv) {
    const m = metaOf(conv.id);
    const path = m.folderId ? folderPath(m.folderId).split(' / ') : ['Unsorted'];
    path.forEach((p, k) => {
      if (k) crumb.append(icon('chevR'));
      crumb.append(el('span', null, p));
    });
    crumb.title = 'Show in the sidebar';
    crumb.onclick = () => {
      S.showExplorer = true; S.view = { kind: 'all', id: null }; S.query = '';
      const q = $('#q'); if (q) q.value = '';
      openConvReveal(conv.id);
    };
  }
  bar.append(crumb, el('span', 'grow'));

  if (conv) {
    const seg = el('div', 'seg');
    seg.setAttribute('role', 'radiogroup');
    for (const [key, t] of Object.entries(TEMPLATES)) {
      const b = el('button');
      b.type = 'button';
      b.title = t.hint;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(S.template === key));
      b.append(icon(t.icon), el('span', null, t.label));
      b.onclick = () => {
        if (S.template === 'focus' && key !== 'focus') S.focusAt = S.activeTurn;
        if (key === 'focus') S.focusAt = S.activeTurn;
        S.template = key;
        PREFS.save();
        R.reader();
        R.inspector();
      };
      seg.append(b);
    }
    bar.append(seg);
  }
  bar.append(iconBtn('sidebarR', 'Show or hide the outline  ]', () => {
    S.showInspector = !S.showInspector; PREFS.save(); R.all();
  }, S.showInspector ? 'on tg-in' : 'tg-in'));
  return bar;
}

/** Open the sidebar at the folder this chat lives in, and scroll to it. */
function openConvReveal(id) {
  const m = metaOf(id);
  if (m.folderId) revealFolder(m.folderId);
  else S.collapsed.delete('__unsorted');
  S.revealPending = true;
  R.all();
}

function header(conv, path) {
  const m = metaOf(conv.id);
  const h = el('header', 'rd-head');
  h.append(el('h1', null, conv.title || '(untitled)'));

  const meta = el('div', 'rd-meta');
  meta.append(el('span', `pdot ${conv.provider}`), el('span', null, provName(conv.provider)));
  if (conv.model) meta.append(el('span', 'sep', '·'), el('span', null, conv.model));
  meta.append(el('span', 'sep', '·'), el('span', null, fmtDate(conv.createdAt)));
  const n = conv.messages.length;
  meta.append(el('span', 'sep', '·'), el('span', null,
    path.length === n ? plural(n, 'message') : `${path.length} of ${n} messages on this branch`));
  h.append(meta);

  const acts = el('div', 'rd-acts');
  const st = btn('star', m.starred ? 'Starred' : 'Star', () => star([conv.id], !m.starred), m.starred ? 'on' : '');
  const mv = btn(m.folderId ? 'folder' : 'tray', m.folderId ? folderPath(m.folderId) : 'Unsorted',
    (e) => movePicker([conv.id], at(e)));
  mv.title = 'Move to another folder';
  acts.append(st, mv);

  for (const t of m.tags) {
    const c = el('span', 'tchip');
    c.append(el('span', null, `#${t}`), iconBtn('x', `Remove #${t}`, async () => { await removeTag([conv.id], t); R.all(); }));
    acts.append(c);
  }
  acts.append(btn('plus', 'Tag', (e) => tagPicker([conv.id], at(e)), 'ghost'));
  acts.append(el('span', 'grow'));
  acts.append(iconBtn('dots', 'More', (e) => menu([
    conv.sourceUrl ? { label: 'Open the original', icon: 'external', run: () => window.open(conv.sourceUrl, '_blank', 'noopener,noreferrer') } : null,
    { label: m.archived ? 'Restore from archive' : 'Archive', icon: 'archive', run: () => archive([conv.id], !m.archived) },
    '-',
    { label: 'Remove from library', icon: 'trash', danger: true, run: () => remove([conv.id]) },
  ], at(e))));
  h.append(acts);
  return h;
}

/* ---------------------------------------------------------------- empty */

function emptyReader() {
  const d = el('div', 'rd-empty');
  if (!S.convs.length) {
    d.append(el('h1', null, 'Your chats, organised'));
    d.append(el('p', null, 'Everything stays in this browser. Nothing is uploaded anywhere.'));
    const b = btn('import', 'Import chats', () => $('#file').click(), 'primary');
    d.append(b);
    const ol = el('ol', 'steps');
    ol.append(
      el('li', null, 'Load the extension from the extension/ folder and click its icon — or paste tools/dist/export.js into the console on claude.ai or chatgpt.com.'),
      el('li', null, 'Pick the conversations you want and export.'),
      el('li', null, 'Import the downloaded file here, or drop it anywhere on this page.'),
    );
    d.append(ol);
    return d;
  }
  d.append(el('h2', null, 'Pick a chat'));
  d.append(el('p', null, 'Choose one from the sidebar, or search every message with /.'));
  const recent = S.convs.filter((c) => !metaOf(c.id).archived).slice(0, 6);
  if (recent.length) {
    const list = el('div', 'recent');
    list.append(el('div', 'rh', 'Recent'));
    for (const c of recent) {
      const r = el('button', 'rr');
      r.type = 'button';
      const m = metaOf(c.id);
      r.append(el('span', `pdot ${c.provider}`), el('span', 'rt', c.title || '(untitled)'),
        el('span', 'rm', m.folderId ? folderPath(m.folderId) : fmtDate(c.updatedAt || c.createdAt)));
      r.onclick = () => openConv(c.id);
      list.append(r);
    }
    d.append(list);
  }
  return d;
}

/* ---------------------------------------------------------------- render */

export function renderReader() {
  if (S.openNoteId && !S.openId) { renderNoteReader(); return; }
  const host = $('#reader');
  const conv = convById(S.openId);
  const same = host.dataset.conv === (conv?.id || '') && host.dataset.tmpl === S.template;
  const keep = same ? ($('.rd-scroll', host)?.scrollTop || 0) : 0;
  // The board scrolls inside itself, both ways and per column. A move re-renders
  // it, and a re-render must not throw you back to the first column.
  const board = same && $('.cols', host);
  const keepBoard = board ? {
    x: board.scrollLeft, y: board.scrollTop,
    cols: $$('.colsec', board).map((c) => [c.scrollLeft, $('.collist', c)?.scrollTop || 0]),
  } : null;

  host.textContent = '';
  host.dataset.conv = conv?.id || '';
  host.dataset.tmpl = S.template;
  host.append(topbar(conv));

  const scroll = el('div', S.template === 'columns' && conv ? 'rd-scroll board' : 'rd-scroll');
  host.append(scroll);
  S.turnEls = [];
  if (!conv) { scroll.append(emptyReader()); return; }

  const col = el('article', S.template === 'columns' ? 'rd-col wide' : S.template === 'branches' || S.template === 'gallery' ? 'rd-col mid' : 'rd-col');
  scroll.append(col);
  const { path, kids, rootCount } = mainPath(conv);
  col.append(header(conv, path));

  if (rootCount > 1) {
    col.append(el('div', 'note', `This conversation has ${rootCount} separate starting points — showing the first. That usually means some messages were not captured.`));
  }

  const turns = O.turns(path);
  S.turnCount = turns.length;
  const sections = sectionsOf(conv.id);
  const groups = SEC.group(turns, shownSections(conv.id));
  const lost = SEC.orphaned(turns, sections);
  if (lost.length) {
    const n = el('div', 'note');
    n.append(el('span', null,
      `${plural(lost.length, 'section break')} ${lost.length > 1 ? 'are' : 'is'} not on this branch — ` +
      `${lost.map((s) => `“${s.title}”`).join(', ')}. Kept in case the message comes back.`));
    n.append(btn(null, 'Discard', async () => {
      const ok = await confirmDialog({
        title: lost.length > 1 ? `Discard ${lost.length} section breaks?` : `Discard “${lost[0].title}”?`,
        body: 'They no longer match any message on this branch.',
        ok: 'Discard', danger: true,
      });
      if (!ok) return;
      await dropSections(conv.id, new Set(lost.map((s) => s.startStableKey)));
      R.reader(); R.inspector();
    }, 'ghost'));
    col.append(n);
  }

  const sug = suggestionBar(conv.id);
  if (sug) col.append(sug);

  const ctx = { convId: conv.id, assistant: provName(conv.provider), turns, path };
  ({ transcript, outline, digest, focus, branches, columns, gallery }[S.template] || transcript)(col, groups, kids, ctx);

  scroll.addEventListener('scroll', trackActive, { passive: true });
  scroll.scrollTop = keep;
  const cols = keepBoard && $('.cols', host);
  if (cols) {
    cols.scrollLeft = keepBoard.x; cols.scrollTop = keepBoard.y;
    $$('.colsec', cols).forEach((c, k) => {
      const v = keepBoard.cols[k];
      if (!v) return;
      c.scrollLeft = v[0];
      const l = $('.collist', c); if (l) l.scrollTop = v[1];
    });
  }
  if (!same) S.activeTurn = S.template === 'focus' ? S.focusAt : 0;
}

/* Handy for the search haystack of a turn — used by the inspector filter. */
export const turnText = (t) =>
  [t.user, ...t.replies].filter(Boolean).flatMap((m) => (m.content || []).map(blockText)).join(' ').toLowerCase();
