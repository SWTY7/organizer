/* ==========================================================================
   The reader: one conversation, in a centred column.

   Templates, switched from the top bar:
     Transcript  every message, top to bottom, as a chat
     Outline     one line per exchange, open the ones you want
     Focus       one exchange at a time, set as a page
     Board       (`columns`) exchanges as cards in columns you arrange;
                 a card opens in a pop-up, the "sheet"

   The inspector (inspector.js) is the navigator for all three, so the reader
   has no rail or ribbon of its own any more.
   ========================================================================== */

import * as O from '../packages/organize/outline.js';
import * as SEC from '../packages/organize/sections.js';
import {
  S, R, PREFS, metaOf, convById, mainPath, folderPath, sectionsOf, setSection, clearSection,
  dropSections, removeTag, openConv, blockText, revealFolder, cardMovesOf, moveCard, resetCard,
  boardColsOf, addBoardCol, renameBoardCol, dropBoardCol,
} from './core.js';
import {
  $, $$, el, icon, iconBtn, btn, menu, at, askText, confirmDialog, fmtDate, toast, picker, floatOpen, closeFloat,
} from './lib/dom.js';
import { md } from './lib/md.js';
import { movePicker, tagPicker, star, archive, remove, plural } from './actions.js';
import { provName } from './explorer.js';

export const TEMPLATES = {
  transcript: { label: 'Transcript', icon: 'rows', hint: 'Every message, top to bottom' },
  outline: { label: 'Outline', icon: 'outline', hint: 'One line per exchange — open the ones you want' },
  focus: { label: 'Focus', icon: 'focus', hint: 'One exchange at a time, as a page · j / k to move' },
  columns: { label: 'Board', icon: 'columns', hint: 'Exchanges as cards in columns — arrange them, click one to read it' },
};

/* ---------------------------------------------------------------- blocks */

function renderBlock(b) {
  switch (b.type) {
    case 'text': { const d = el('div', 'prose'); d.innerHTML = md(b.text); return d; }
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
      const d = details(`Tool call · ${b.name || 'tool'}`, 'tool');
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
      if (b.text) {
        const d = details(`${b.filename || 'Attached file'} · ${b.text.length.toLocaleString()} characters`, 'file');
        d.lastChild.append(codeBlock(b.text));
        return d;
      }
      return chip('file', b.filename || 'File', 'Not downloaded — captured as a reference');
    }
    case 'image': {
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
  const copy = iconBtn('copy', 'Copy', async () => {
    try { await navigator.clipboard.writeText(text); copy.classList.add('done'); setTimeout(() => copy.classList.remove('done'), 1200); }
    catch { /* clipboard refused — nothing useful to say */ }
  });
  bar.append(copy);
  const pre = el('pre');
  pre.append(el('code', null, text));
  w.append(bar, pre);
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

function sectionHeading(convId, sec) {
  const h = el('div', 'sec');
  h.append(el('span', 'st', sec.title || 'Beginning'), el('span', 'sn', plural(sec.turns.length, 'exchange')));
  if (sec.startKey) {
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
  bar.append(el('span', 'grow'), all);
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
    const groups = onBoard ? boardOf(conv.id, turns) : SEC.group(turns, sectionsOf(conv.id));
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
  SEC.applyMoves(turns, sectionsOf(convId), cardMovesOf(convId), boardColsOf(convId));

/** File a card under a column. Back to its own section clears the move
    rather than recording one that changes nothing. */
async function fileCard(convId, turns, key, target) {
  const natural = SEC.group(turns, sectionsOf(convId))
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
  if (g.extra) {
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
    const section = el('div', `colsec${g.extra ? ' extra' : ''}`);
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
  if (S.template === 'columns') {
    // On the board, going to an exchange means reading it.
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
  if (S.template === 'focus' || S.template === 'columns') return;
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

  const col = el('article', S.template === 'columns' ? 'rd-col wide' : 'rd-col');
  scroll.append(col);
  const { path, kids, rootCount } = mainPath(conv);
  col.append(header(conv, path));

  if (rootCount > 1) {
    col.append(el('div', 'note', `This conversation has ${rootCount} separate starting points — showing the first. That usually means some messages were not captured.`));
  }

  const turns = O.turns(path);
  S.turnCount = turns.length;
  const sections = sectionsOf(conv.id);
  const groups = SEC.group(turns, sections);
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

  const ctx = { convId: conv.id, assistant: provName(conv.provider), turns };
  ({ transcript, outline, focus, columns }[S.template] || transcript)(col, groups, kids, ctx);

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
