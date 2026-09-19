/* ==========================================================================
   Notes: documents you write, not conversations you imported.

   A note can [[link]] to another note or to a conversation by title; every
   link back is shown too, on both ends. Nothing here touches imported
   conversations — a note is its own kind of thing, filed the same way a
   conversation is (openConv / openNote are mutually exclusive), but never
   mistaken for one.
   ========================================================================== */

import * as WL from '../packages/organize/wikilinks.js';
import {
  S, R, PREFS, noteById, notesList, createNote, renameNote, saveNoteBody, deleteNote, restoreNote,
  resolveWikiTarget, backlinksToNote, outLinksOf, openConv, openNote,
} from './core.js';
import { $, el, icon, iconBtn, btn, at, confirmDialog, toast, picker, fmtDate } from './lib/dom.js';
import { md } from './lib/md.js';
import { plural } from './actions.js';

/** A note's body, through the ordinary markdown renderer, with its
    [[wikilinks]] resolved against notes and conversations along the way. */
export function noteHtml(body) {
  const { text, tokens } = WL.prepareWikilinks(body, resolveWikiTarget);
  return WL.fillWikilinks(md(text), tokens);
}

/** One click handler for every rendered wikilink in a container: open what
    it resolves to, or create the note it names. Attach once per container. */
function wireWikilinks(host) {
  host.addEventListener('click', (e) => {
    const a = e.target.closest('a.wikilink');
    if (!a || !host.contains(a)) return;
    e.preventDefault();
    if (a.dataset.kind === 'note') openNote(a.dataset.id);
    else if (a.dataset.kind === 'conv') openConv(a.dataset.id);
    else newNoteFrom(a.dataset.target);
  });
}

async function newNoteFrom(title) {
  const n = await createNote(title);
  openNote(n.id);
  toast(`Created “${n.title}”`);
}

/* ------------------------------------------------------------- the link toolbar */

function insertLink(ta, target) {
  const { selectionStart: a, selectionEnd: b, value } = ta;
  const text = `[[${target}]]`;
  ta.value = value.slice(0, a) + text + value.slice(b);
  const at2 = a + text.length;
  ta.setSelectionRange(at2, at2);
  ta.focus();
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

function openLinkPicker(ta, anchor, excludeId) {
  const items = [
    ...notesList().filter((n) => n.id !== excludeId).map((n) => ({ label: n.title, value: n.title, icon: 'file' })),
    ...S.convs.map((c) => ({ label: c.title || '(untitled)', value: c.title || '(untitled)', icon: 'msg' })),
  ];
  picker({
    items, anchor, placeholder: 'Link to a note or a chat…',
    onPick: (v) => insertLink(ta, v),
    create: async (title) => {
      await createNote(title);
      insertLink(ta, title);
      toast(`Created “${title}” — linked, not opened, so you keep writing here`);
    },
  });
}

/* ------------------------------------------------------------------ footer */

function linkChip(label, ico, onClick, extra) {
  const b = el('button', 'lchip');
  b.type = 'button';
  b.append(icon(ico), el('span', null, label));
  if (extra) b.append(el('span', 'lchip-sub', extra));
  b.onclick = onClick;
  return b;
}

function linksFooter(note) {
  const out = outLinksOf(note);
  const back = backlinksToNote(note.id);
  if (!out.length && !back.length) return null;

  const foot = el('div', 'note-links');
  if (out.length) {
    foot.append(el('div', 'nl-h', 'Links to'));
    const row = el('div', 'nl-row');
    for (const l of out) {
      row.append(l.res
        ? linkChip(l.res.title, l.res.kind === 'note' ? 'file' : 'msg', () => (l.res.kind === 'note' ? openNote(l.res.id) : openConv(l.res.id)))
        : linkChip(l.target, 'plus', () => newNoteFrom(l.target), 'not created yet'));
    }
    foot.append(row);
  }
  if (back.length) {
    foot.append(el('div', 'nl-h', `Linked from ${plural(back.length, 'note')}`));
    const row = el('div', 'nl-row');
    for (const l of back) row.append(linkChip(l.from.title, 'file', () => openNote(l.from.id)));
    foot.append(row);
  }
  return foot;
}

/* ------------------------------------------------------------------- topbar */

function topbar(note) {
  const bar = el('div', 'rd-top');
  bar.append(iconBtn('sidebarL', 'Show or hide the sidebar  [', () => {
    S.showExplorer = !S.showExplorer; PREFS.save(); R.all();
  }, S.showExplorer ? 'on' : ''));
  bar.append(el('div', 'crumb', 'Notes'), el('span', 'grow'));

  const seg = el('div', 'seg');
  const tab = (label, ico, mode) => {
    const b = el('button');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(S.noteMode === mode));
    b.append(icon(ico), el('span', null, label));
    b.onclick = () => { S.noteMode = mode; R.reader(); };
    return b;
  };
  seg.append(tab('Write', 'pencil', 'write'), tab('Read', 'outline', 'read'));
  bar.append(seg);

  bar.append(iconBtn('trash', 'Delete this note', () => deleteFlow(note), 'idanger'));
  bar.append(iconBtn('sidebarR', 'Show or hide the outline  ]', () => {
    S.showInspector = !S.showInspector; PREFS.save(); R.all();
  }, S.showInspector ? 'on tg-in' : 'tg-in'));
  return bar;
}

async function deleteFlow(note) {
  const back = backlinksToNote(note.id);
  const ok = await confirmDialog({
    title: `Delete “${note.title}”?`,
    body: back.length ? `${plural(back.length, 'other note links')} here — those links will point at nothing.` : undefined,
    ok: 'Delete note', danger: true,
  });
  if (!ok) return;
  const gone = await deleteNote(note.id);
  R.all();
  toast(`Deleted “${gone.title}”`, { label: 'Undo', run: async () => { await restoreNote(gone); openNote(gone.id); } });
}

/* ------------------------------------------------------------------- body */

function writeMode(note, col) {
  const toolbar = el('div', 'ntool');
  const link = btn('link', 'Link', (e) => openLinkPicker(ta, at(e), note.id), 'ghost');
  toolbar.append(link, el('span', 'grow'), el('span', 'nhint', 'Type [[ to link, or use the button'));
  col.append(toolbar);

  const ta = el('textarea', 'nbody');
  ta.value = note.body;
  ta.placeholder = 'Write here. [[Link]] to a note or a chat by its title.';
  let timer = null;
  ta.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(() => saveNoteBody(note.id, ta.value), 350);
  };
  ta.onblur = () => { clearTimeout(timer); saveNoteBody(note.id, ta.value); };
  col.append(ta);
}

function readMode(note, col) {
  const view = el('div', 'prose note-prose');
  view.innerHTML = note.body.trim() ? noteHtml(note.body) : '<p><em>Nothing written yet.</em></p>';
  wireWikilinks(view);
  col.append(view);
}

export function renderNoteReader() {
  const host = $('#reader');
  const note = noteById(S.openNoteId);
  if (!note) { S.openNoteId = null; R.reader(); return; }

  const same = host.dataset.note === note.id;
  const keep = same ? ($('.rd-scroll', host)?.scrollTop || 0) : 0;
  host.textContent = '';
  host.dataset.conv = '';
  host.dataset.tmpl = 'note';
  host.dataset.note = note.id;
  host.append(topbar(note));

  const scroll = el('div', 'rd-scroll');
  host.append(scroll);
  const col = el('article', 'rd-col note-col');
  scroll.append(col);

  const head = el('header', 'rd-head note-head');
  const titleIn = el('input', 'note-title');
  titleIn.value = note.title;
  titleIn.placeholder = 'Untitled note';
  titleIn.onblur = () => { if (titleIn.value.trim() && titleIn.value !== note.title) { renameNote(note.id, titleIn.value); R.explorer(); } };
  titleIn.onkeydown = (e) => { if (e.key === 'Enter') titleIn.blur(); };
  head.append(titleIn);
  const meta = el('div', 'rd-meta');
  meta.append(el('span', null, `Created ${fmtDate(note.createdAt)}`));
  if (note.updatedAt && note.updatedAt !== note.createdAt) meta.append(el('span', 'sep', '·'), el('span', null, `Updated ${fmtDate(note.updatedAt)}`));
  head.append(meta);
  col.append(head);

  if (S.noteMode === 'read') readMode(note, col); else writeMode(note, col);
  const foot = linksFooter(note);
  if (foot) col.append(foot);

  scroll.scrollTop = keep;
}

/** The inspector's content while a note is open: a light outline of its own
    headings plus its backlinks, so the panel is never simply blank. */
export function renderNoteInspector() {
  const host = $('#inspector');
  const note = noteById(S.openNoteId);
  host.textContent = '';
  const head = el('div', 'in-head');
  head.append(el('span', 'in-title', 'This note'));
  host.append(head);
  if (!note) { host.append(el('div', 'in-empty', 'This note was deleted.')); return; }

  const d = el('div', 'in-details');
  const row = (label, node) => {
    const r = el('div', 'drow');
    r.append(el('span', 'dl', label));
    const v = el('span', 'dv');
    if (node instanceof Node) v.append(node); else v.textContent = node;
    r.append(v);
    d.append(r);
  };
  row('Created', fmtDate(note.createdAt));
  if (note.updatedAt !== note.createdAt) row('Updated', fmtDate(note.updatedAt));
  const back = backlinksToNote(note.id);
  const out = outLinksOf(note).filter((l) => l.res);
  row('Links out', out.length ? String(out.length) : 'None');
  row('Linked from', back.length ? String(back.length) : 'None');
  host.append(d);
}
