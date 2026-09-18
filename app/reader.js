/* ==========================================================================
   The reader: one conversation, in a centred column.

   Four templates, switched from the top bar:
     Transcript  every message, top to bottom
     Outline     one line per exchange, open the ones you want
     Focus       one exchange at a time — the inspector is its list
     Columns     one column per section, turns stacking down it

   The inspector (inspector.js) is the navigator for all three, so the reader
   has no rail or ribbon of its own any more.
   ========================================================================== */

import * as O from '../packages/organize/outline.js';
import * as SEC from '../packages/organize/sections.js';
import {
  S, R, PREFS, metaOf, convById, mainPath, folderPath, sectionsOf, setSection, clearSection,
  dropSections, removeTag, openConv, blockText, revealFolder,
} from './core.js';
import { $, el, icon, iconBtn, btn, menu, at, askText, confirmDialog, fmtDate } from './lib/dom.js';
import { md } from './lib/md.js';
import { movePicker, tagPicker, star, archive, remove, plural } from './actions.js';
import { provName } from './explorer.js';

export const TEMPLATES = {
  transcript: { label: 'Transcript', icon: 'rows', hint: 'Every message, top to bottom' },
  outline: { label: 'Outline', icon: 'outline', hint: 'One line per exchange — open the ones you want' },
  focus: { label: 'Focus', icon: 'focus', hint: 'One exchange at a time · j / k to move' },
  columns: { label: 'Columns', icon: 'columns', hint: 'One column per section — scroll sideways between topics' },
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
    };
    br.append(icon('branch'), iconBtn('chevL', 'Previous version', () => goB(-1)),
      el('span', null, `${idx + 1} / ${sibs.length}`), iconBtn('chevR', 'Next version', () => goB(1)));
    who.append(br);
  }

  // Starting a section is offered on your messages, where topics begin.
  if (msg.role === 'user' && ctx.turnKey && !ctx.startsSection) {
    who.append(el('span', 'grow'), iconBtn('bookmark', 'Start a section here', () => newSection(ctx.convId, ctx.turnKey), 'hover'));
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

function focus(col, groups, kids, ctx) {
  const flat = groups.flatMap((g) => g.turns.map((t) => ({ t, sec: g })));
  if (!flat.length) return;
  const n = Math.max(0, Math.min(S.focusAt, flat.length - 1));
  S.focusAt = n;
  const { t, sec } = flat[n];
  const key = SEC.turnKey(t);

  const eyebrow = el('div', 'eyebrow');
  eyebrow.append(el('span', null, `Exchange ${n + 1} of ${flat.length}`));
  if (groups.length > 1) eyebrow.append(el('span', null, '·'), el('span', null, sec.title || 'Beginning'));
  col.append(eyebrow);

  const wrap = el('div', 'focus');
  wrap.dataset.turn = n;
  S.turnEls = [];
  S.turnEls[n] = wrap;
  for (const msg of [t.user, ...t.replies].filter(Boolean)) {
    wrap.append(renderMessage(msg, kids, { ...ctx, turnKey: key, startsSection: sec.startKey === key }));
  }
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

/**
 * One column per section, turns stacking down it — the layout for "the main
 * thread was A→B→C, but A had follow-ups". Needs sections; with none, there is
 * only one column, which is not what this template is for, so it says so
 * rather than quietly rendering a single narrow list.
 */
function columns(col, groups, kids, ctx) {
  const total = groups.reduce((n, g) => n + g.turns.length, 0);
  const bar = el('div', 'obar');
  bar.append(el('span', null, groups.length > 1
    ? `${plural(groups.length, 'section')} · ${plural(total, 'exchange')}`
    : plural(total, 'exchange')));
  bar.append(el('span', 'grow'));
  if (groups.length > 1) {
    bar.append(iconBtn(S.colsTransposed ? 'columns' : 'swap',
      S.colsTransposed ? 'Lay sections out as columns' : 'Lay sections out as rows',
      () => { S.colsTransposed = !S.colsTransposed; PREFS.save(); R.reader(); }));
  }
  col.append(bar);

  if (groups.length < 2) {
    col.append(el('div', 'note',
      'This template shows one column per section. Bookmark a message to start one — the button appears when you hover it.'));
  }

  const board = el('div', `cols${S.colsTransposed ? ' transposed' : ''}`);
  let i = 0;
  for (const sec of groups) {
    const section = el('div', 'colsec');
    const head = el('div', 'colhead');
    head.append(el('span', 'st', sec.title || 'Beginning'), el('span', 'sn', plural(sec.turns.length, 'exchange')));
    section.append(head);

    for (const t of sec.turns) {
      const n = i++;
      const key = SEC.turnKey(t);
      const open = S.openTurns.has(n);
      const card = el('div', `colcard${open ? ' open' : ''}`);
      card.dataset.turn = n;
      S.turnEls[n] = card;

      const chead = el('button', 'cchead');
      chead.type = 'button';
      chead.append(el('span', 'onum', String(n + 1)), turnSummary(t, 90), icon('chevR'));
      chead.onclick = () => {
        if (S.openTurns.has(n)) S.openTurns.delete(n); else S.openTurns.add(n);
        R.reader();
      };
      card.append(chead);
      if (open) {
        const detail = el('div', 'odetail');
        const tctx = { ...ctx, turnKey: key, startsSection: sec.startKey === key };
        for (const msg of [t.user, ...t.replies].filter(Boolean)) detail.append(renderMessage(msg, kids, tctx));
        card.append(detail);
      }
      section.append(card);
    }
    board.append(section);
  }
  col.append(board);
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
  if ((S.template === 'outline' || S.template === 'columns') && !S.openTurns.has(n)) {
    S.openTurns.add(n);
    R.reader();
  }
  const node = S.turnEls[n];
  if (!node) return;
  // Columns scrolls in two directions — centre the target column as well as
  // bringing the card into view, or the jump can land off to the side.
  node.scrollIntoView(S.template === 'columns'
    ? { block: 'nearest', inline: 'center', behavior: 'smooth' }
    : { block: 'start', behavior: 'smooth' });
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

  host.textContent = '';
  host.dataset.conv = conv?.id || '';
  host.dataset.tmpl = S.template;
  host.append(topbar(conv));

  const scroll = el('div', 'rd-scroll');
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

  const ctx = { convId: conv.id, assistant: provName(conv.provider) };
  ({ transcript, outline, focus, columns }[S.template] || transcript)(col, groups, kids, ctx);

  scroll.addEventListener('scroll', trackActive, { passive: true });
  scroll.scrollTop = keep;
  if (!same) S.activeTurn = S.template === 'focus' ? S.focusAt : 0;
}

/* Handy for the search haystack of a turn — used by the inspector filter. */
export const turnText = (t) =>
  [t.user, ...t.replies].filter(Boolean).flatMap((m) => (m.content || []).map(blockText)).join(' ').toLowerCase();
