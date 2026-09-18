/* ==========================================================================
   The explorer: one tree, where conversations live inside their folders.

   There is no separate list pane. Searching, or choosing Starred / Archived /
   a tag / a saved search, swaps the tree for a flat list with a way back.

   Every action on a row has a visible control that appears on hover — `+` and
   `⋯` — and names are typed inline, where the thing will live. Right-click and
   double-click still work, as shortcuts. (DESIGN.md, interaction rule 1.)
   ========================================================================== */

import {
  S, R, PREFS, metaOf, counts, shown, listMode, snippet, openConv,
  folderChildren, folderPath, chatsIn, toggleFolder,
  createFolder, renameFolder, moveFolder, deleteFolder, folderDeleteImpact,
  addTag, renameTag, deleteTag, saveSearch, deleteSearch, restoreSearch, clearLibrary,
} from './core.js';
import {
  $, $$, el, esc, icon, iconBtn, btn, menu, at, confirmDialog, askText, toast, inlineEdit, fmtDate,
} from './lib/dom.js';
import { chatMenu, movePicker, tagPicker, star, archive, remove, move, plural } from './actions.js';

const DT_IDS = 'application/x-organizer-ids';
const DT_FOLDER = 'application/x-organizer-folder';
const UNSORTED = '__unsorted';

/* ---------------------------------------------------------------- setup */

/** The parts that never re-render — above all the search box, which would
    lose its caret mid-word if it were rebuilt on every keystroke. */
export function initExplorer({ onImport }) {
  const host = $('#explorer');
  host.textContent = '';

  const head = el('div', 'ex-head');
  head.append(
    el('span', 'brand', 'Organizer'),
    el('span', 'grow'),
    iconBtn('import', 'Import chats', onImport),
    iconBtn('folderPlus', 'New folder', () => startNewFolder(null)),
    iconBtn('dots', 'More', (e) => moreMenu(at(e), onImport)),
  );

  const sw = el('label', 'ex-search');
  const q = el('input');
  q.id = 'q';
  q.type = 'search';
  q.placeholder = 'Search all messages';
  q.autocomplete = 'off';
  q.spellcheck = false;
  q.oninput = () => {
    S.query = q.value.trim().toLowerCase();
    S.sel.clear();
    renderExplorer();
    renderBulk();
  };
  sw.append(icon('search'), q, el('kbd', null, '/'));

  const body = el('div', 'ex-body');
  body.id = 'exbody';
  host.append(head, sw, body);
}

function moreMenu(anchor, onImport) {
  const t = PREFS.theme();
  menu([
    { heading: 'Theme' },
    { label: 'Match system', icon: 'monitor', checked: !t, run: () => PREFS.setTheme('') },
    { label: 'Light', icon: 'sun', checked: t === 'light', run: () => PREFS.setTheme('light') },
    { label: 'Dark', icon: 'moon', checked: t === 'dark', run: () => PREFS.setTheme('dark') },
    '-',
    { label: 'Import chats…', icon: 'import', run: onImport },
    '-',
    { label: 'Clear the whole library…', icon: 'trash', danger: true, run: clearFlow },
  ], anchor);
}

async function clearFlow() {
  if (!S.convs.length) return;
  const ok = await confirmDialog({
    title: `Clear all ${plural(S.convs.length, 'chat')} from this browser?`,
    body: ['Folders, tags, sections and saved searches go too.',
      'The originals on Claude and ChatGPT are untouched, and you can import them again — but your organisation cannot be recovered.'],
    ok: 'Clear library',
    danger: true,
  });
  if (!ok) return;
  await clearLibrary();
  R.all();
  toast('Library cleared');
}

/* --------------------------------------------------------------- render */

export function renderExplorer() {
  const body = $('#exbody');
  if (!body) return;
  const mode = listMode() ? 'list' : 'tree';
  // Rule 4: a render never moves you — unless you changed what you are looking at.
  const keep = body.dataset.mode === mode ? body.scrollTop : 0;
  body.dataset.mode = mode;
  body.textContent = '';

  if (!S.convs.length) body.append(emptyLibrary());
  else body.append(mode === 'list' ? listView() : treeView());

  body.scrollTop = keep;
  if (S.revealPending) {
    S.revealPending = false;
    $('[aria-current="true"]', body)?.scrollIntoView({ block: 'nearest' });
  }
  $('.editing input', body)?.scrollIntoView({ block: 'nearest' });
}

function emptyLibrary() {
  const d = el('div', 'ex-empty');
  d.append(el('p', null, 'No chats yet.'));
  d.append(el('p', 'muted', 'Import a .chat.json or .chatpack.json from the extension to get started.'));
  return d;
}

const editing = (kind, key) => S.editing?.kind === kind &&
  (S.editing.parentId === key || S.editing.id === key || S.editing.tag === key);

const stopEditing = () => { S.editing = null; renderExplorer(); };

/* ----------------------------------------------------------------- tree */

function treeView() {
  const c = counts();
  const t = el('div', 'tree');
  t.setAttribute('role', 'tree');

  t.append(
    quickRow('star', 'Starred', c.starred, { kind: 'starred' }, (ids) => star(ids, true)),
    quickRow('archive', 'Archived', c.archived, { kind: 'archived' }, (ids) => archive(ids, true)),
  );

  const fh = sectionHead('Folders', iconBtn('plus', 'New folder', () => startNewFolder(null)));
  fh.title = 'Drop a folder here to move it to the top level';
  dropTarget(fh, { onDropFolder: async (id) => { if (await moveFolder(id, null)) R.all(); } });
  t.append(fh);

  if (editing('new-folder', null)) t.append(newFolderRow(null, 0));
  walk(t, null, 0, c);

  const loose = chatsIn(null);
  if (loose.length) {
    const open = !S.collapsed.has(UNSORTED);
    const row = el('div', 'trow folder unsorted');
    row.style.setProperty('--d', 0);
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-expanded', String(open));
    row.title = 'Chats that are not in any folder';
    row.append(twisty(true, open), icon('tray'), el('span', 'lbl', 'Unsorted'), el('span', 'n', String(loose.length)));
    row.onclick = () => { toggleFolder(UNSORTED); renderExplorer(); };
    dropTarget(row, { onDropIds: (ids) => moveTo(ids, null) });
    t.append(row);
    if (open) for (const conv of loose) t.append(chatRow(conv, 1));
  }
  if (!S.folders.length) {
    t.append(el('div', 'hint', 'Drag chats onto a folder to file them. Claude projects become folders on import.'));
  }

  const tags = [...c.tag].sort((a, b) => a[0].localeCompare(b[0]));
  if (tags.length) {
    t.append(sectionHead('Tags'));
    for (const [tag, n] of tags) t.append(tagRow(tag, n));
  }

  t.append(sectionHead('Saved searches'));
  if (S.smart.length) for (const s of S.smart) t.append(smartRow(s));
  else t.append(el('div', 'hint', 'Search, then save it from the results to keep it here.'));
  return t;
}

function walk(t, pid, depth, c) {
  for (const f of folderChildren(pid)) {
    t.append(folderRow(f, depth, c));
    if (S.collapsed.has(f.id)) continue;
    if (editing('new-folder', f.id)) t.append(newFolderRow(f.id, depth + 1));
    walk(t, f.id, depth + 1, c);
    for (const conv of chatsIn(f.id)) t.append(chatRow(conv, depth + 1));
  }
}

const twisty = (has, open) => {
  const s = el('span', 'tw');
  if (has) s.append(icon(open ? 'chevD' : 'chevR'));
  return s;
};

function sectionHead(label, ...actions) {
  const h = el('div', 'sect');
  h.append(el('span', null, label), el('span', 'grow'), ...actions);
  return h;
}

function quickRow(ico, label, n, view, onDrop) {
  const row = el('div', 'trow quick');
  row.style.setProperty('--d', 0);
  if (S.view.kind === view.kind) row.setAttribute('aria-current', 'true');
  row.append(el('span', 'tw'), icon(ico), el('span', 'lbl', label), el('span', 'n', String(n)));
  row.onclick = () => setView(view);
  if (onDrop) dropTarget(row, { onDropIds: onDrop });
  return row;
}

function folderRow(f, depth, c) {
  const open = !S.collapsed.has(f.id);
  const has = folderChildren(f.id).length > 0 || chatsIn(f.id).length > 0;
  const renaming = editing('rename-folder', f.id);

  const row = el('div', `trow folder${renaming ? ' editing' : ''}`);
  row.style.setProperty('--d', depth);
  row.dataset.folder = f.id;
  row.setAttribute('role', 'treeitem');
  if (has) row.setAttribute('aria-expanded', String(open));
  row.title = folderPath(f.id);
  row.append(twisty(has, open), icon(open && has ? 'folderOpen' : 'folder'));

  const lbl = el('span', 'lbl');
  if (renaming) {
    inlineEdit(lbl, {
      value: f.name,
      onCommit: async (v) => { S.editing = null; await renameFolder(f.id, v); R.all(); },
      onCancel: stopEditing,
    });
  } else lbl.textContent = f.name;
  row.append(lbl, el('span', 'n', String(c.folderAll.get(f.id) || 0)));

  const acts = el('span', 'acts');
  acts.append(
    iconBtn('plus', 'New folder inside', () => startNewFolder(f.id)),
    iconBtn('dots', 'Folder options', (e) => folderMenu(f, at(e))),
  );
  row.append(acts);

  row.onclick = () => { toggleFolder(f.id); renderExplorer(); };
  row.ondblclick = (e) => { e.preventDefault(); startRename(f.id); };
  row.oncontextmenu = (e) => { e.preventDefault(); folderMenu(f, at(e)); };

  if (!renaming) {
    row.draggable = true;
    row.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData(DT_FOLDER, f.id);
      e.dataTransfer.effectAllowed = 'move';
    });
  }
  dropTarget(row, {
    onDropIds: (ids) => moveTo(ids, f.id),
    onDropFolder: async (id) => {
      if (await moveFolder(id, f.id)) R.all();
      else if (id !== f.id) toast('A folder cannot go inside one of its own subfolders');
    },
  });
  return row;
}

function newFolderRow(parentId, depth) {
  const row = el('div', 'trow folder editing');
  row.style.setProperty('--d', depth);
  row.append(el('span', 'tw'), icon('folder'));
  const lbl = el('span', 'lbl');
  inlineEdit(lbl, {
    placeholder: parentId ? `New folder in ${folderPath(parentId)}` : 'New folder',
    onCommit: async (v) => { S.editing = null; await createFolder(v, parentId); R.all(); },
    onCancel: stopEditing,
  });
  row.append(lbl);
  return row;
}

function chatRow(conv, depth) {
  const m = metaOf(conv.id);
  const row = el('div', 'trow chat');
  row.style.setProperty('--d', depth);
  row.dataset.id = conv.id;
  row.setAttribute('role', 'treeitem');
  if (conv.id === S.openId) row.setAttribute('aria-current', 'true');
  if (S.sel.has(conv.id)) row.classList.add('sel');
  row.title = `${conv.title || '(untitled)'}\n${fmtDate(conv.updatedAt || conv.createdAt)} · ${plural(conv.messages.length, 'message')}`;

  row.append(el('span', 'tw'), el('span', `pdot ${conv.provider}`), el('span', 'lbl', conv.title || '(untitled)'));
  if (m.starred) row.append(icon('star'));
  const acts = el('span', 'acts');
  acts.append(iconBtn('dots', 'Chat options', (e) => chatMenu(conv, at(e))));
  row.append(acts);
  wireChat(row, conv);
  return row;
}

function tagRow(tag, n) {
  const renaming = editing('rename-tag', tag);
  const row = el('div', `trow tag${renaming ? ' editing' : ''}`);
  row.style.setProperty('--d', 0);
  if (S.view.kind === 'tag' && S.view.id === tag) row.setAttribute('aria-current', 'true');
  row.append(el('span', 'tw'), icon('hash'));
  const lbl = el('span', 'lbl');
  if (renaming) {
    inlineEdit(lbl, {
      value: tag,
      onCommit: async (v) => { S.editing = null; await renameTag(tag, v.replace(/^#/, '')); R.all(); },
      onCancel: stopEditing,
    });
  } else lbl.textContent = tag;
  row.append(lbl, el('span', 'n', String(n)));

  const acts = el('span', 'acts');
  acts.append(iconBtn('dots', 'Tag options', (e) => tagMenu(tag, at(e))));
  row.append(acts);
  row.onclick = () => setView({ kind: 'tag', id: tag });
  row.oncontextmenu = (e) => { e.preventDefault(); tagMenu(tag, at(e)); };
  dropTarget(row, { onDropIds: async (ids) => { await addTag(ids, tag); R.all(); } });
  return row;
}

function smartRow(s) {
  const row = el('div', 'trow smart');
  row.style.setProperty('--d', 0);
  row.append(el('span', 'tw'), icon('search'), el('span', 'lbl', s.name));
  const acts = el('span', 'acts');
  acts.append(iconBtn('x', 'Delete saved search', async () => {
    const gone = await deleteSearch(s.id);
    renderExplorer();
    toast(`Deleted “${s.name}”`, { label: 'Undo', run: async () => { await restoreSearch(gone); renderExplorer(); } });
  }));
  row.append(acts);
  row.onclick = () => {
    S.query = s.q.text || '';
    S.provider = s.q.provider || null;
    S.view = s.q.view || { kind: 'all', id: null };
    $('#q').value = S.query;
    S.sel.clear();
    R.all();
  };
  return row;
}

/* ---------------------------------------------------------------- menus */

function folderMenu(f, anchor) {
  menu([
    { label: 'New folder inside', icon: 'folderPlus', run: () => startNewFolder(f.id) },
    { label: 'Rename', icon: 'pencil', hint: 'double-click', run: () => startRename(f.id) },
    f.parentId ? { label: 'Move to top level', icon: 'arrowL', run: async () => { await moveFolder(f.id, null); R.all(); } } : null,
    { label: 'Show as a list', icon: 'rows', run: () => setView({ kind: 'folder', id: f.id }) },
    '-',
    { label: 'Delete folder…', icon: 'trash', danger: true, run: () => deleteFolderFlow(f.id) },
  ], anchor);
}

async function deleteFolderFlow(id) {
  const { folder, kids, chats, up } = folderDeleteImpact(id);
  const body = [];
  if (kids.length) body.push(kids.length > 1
    ? `Its ${kids.length} subfolders move up to ${up ? `“${up}”` : 'the top level'}.`
    : `Its subfolder “${kids[0].name}” moves up to ${up ? `“${up}”` : 'the top level'}.`);
  if (chats.length) body.push(`${plural(chats.length, 'chat')} ${chats.length > 1 ? 'become' : 'becomes'} unsorted. Nothing leaves the library.`);
  if (!body.length) body.push('It is empty.');
  const ok = await confirmDialog({ title: `Delete “${folder.name}”?`, body, ok: 'Delete folder', danger: true });
  if (!ok) return;
  await deleteFolder(id);
  R.all();
}

function tagMenu(tag, anchor) {
  menu([
    { label: 'Show chats', icon: 'rows', run: () => setView({ kind: 'tag', id: tag }) },
    { label: 'Rename', icon: 'pencil', run: () => { S.editing = { kind: 'rename-tag', tag }; exitList(); } },
    '-',
    {
      label: 'Delete tag', icon: 'trash', danger: true,
      run: async () => {
        const ids = await deleteTag(tag);
        R.all();
        toast(`Deleted #${tag} from ${plural(ids.length, 'chat')}`, {
          label: 'Undo', run: async () => { await addTag(ids, tag); R.all(); },
        });
      },
    },
  ], anchor);
}

/* ----------------------------------------------------------------- edits */

function exitList() {
  if (listMode()) {
    S.query = '';
    S.view = { kind: 'all', id: null };
    $('#q').value = '';
  }
  renderExplorer();
}

export function startNewFolder(parentId) {
  if (parentId) S.collapsed.delete(parentId);
  S.editing = { kind: 'new-folder', parentId };
  exitList();
}

function startRename(id) {
  S.editing = { kind: 'rename-folder', id };
  exitList();
}

function setView(view) {
  S.view = view;
  S.sel.clear();
  renderExplorer();
  renderBulk();
}

const moveTo = (ids, folderId) => move(ids, folderId);

/* ------------------------------------------------------------ list view */

function listTitle() {
  const v = S.view;
  const scope = v.kind === 'starred' ? 'Starred'
    : v.kind === 'archived' ? 'Archived'
      : v.kind === 'unsorted' || v.kind === 'untagged' ? 'Unsorted'
        : v.kind === 'tag' ? `#${v.id}`
          : v.kind === 'folder' ? folderPath(v.id) || 'Folder'
            : null;
  if (!S.query) return scope || 'All chats';
  return scope ? `“${S.query}” in ${scope}` : `“${S.query}”`;
}

function listView() {
  const rows = shown();
  const wrap = el('div', 'list');

  const head = el('div', 'list-head');
  head.append(
    iconBtn('arrowL', 'Back to folders', exitListAndClear),
    el('span', 'lt', listTitle()),
    el('span', 'n', String(rows.length)),
  );
  if (S.query) {
    head.append(iconBtn('save', 'Save this search', async (e) => {
      const name = await askText({ title: 'Save this search', value: S.query, placeholder: 'Name', ok: 'Save' });
      if (!name) return;
      await saveSearch(name);
      toast(`Saved “${name}” — it is under Saved searches`);
    }));
  }
  wrap.append(head);

  if (S.providers.size > 1) {
    const chips = el('div', 'chips');
    for (const [label, val] of [['All', null], ...[...S.providers].sort().map((p) => [provName(p), p])]) {
      const b = el('button', 'chip', label);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(S.provider === val));
      b.onclick = () => { S.provider = val; renderExplorer(); };
      chips.append(b);
    }
    wrap.append(chips);
  }

  if (!rows.length) {
    wrap.append(el('div', 'hint', S.query ? 'Nothing matches. Search covers every message, not only titles.' : 'Nothing here yet.'));
    return wrap;
  }
  for (const c of rows) wrap.append(listRow(c));
  return wrap;
}

function exitListAndClear() {
  S.query = '';
  S.view = { kind: 'all', id: null };
  $('#q').value = '';
  S.sel.clear();
  renderExplorer();
  renderBulk();
}

export const provName = (p) => ({ claude: 'Claude', chatgpt: 'ChatGPT' }[p] || p);

function listRow(c) {
  const m = metaOf(c.id);
  const row = el('div', 'lrow');
  row.dataset.id = c.id;
  if (c.id === S.openId) row.setAttribute('aria-current', 'true');
  if (S.sel.has(c.id)) row.classList.add('sel');

  const t = el('div', 'lt');
  t.append(el('span', `pdot ${c.provider}`), el('span', null, c.title || '(untitled)'));
  if (m.starred) t.append(icon('star'));
  row.append(t);

  const meta = el('div', 'lm');
  meta.append(el('span', null, fmtDate(c.updatedAt || c.createdAt)));
  meta.append(el('span', null, m.folderId ? folderPath(m.folderId) : 'Unsorted'));
  for (const tag of m.tags) meta.append(el('span', 'tagtext', `#${tag}`));
  row.append(meta);

  const sn = snippet(c, esc);
  if (sn) { const d = el('div', 'snip'); d.innerHTML = sn; row.append(d); }

  const acts = el('span', 'acts');
  acts.append(iconBtn('dots', 'Chat options', (e) => chatMenu(c, at(e))));
  row.append(acts);
  wireChat(row, c);
  return row;
}

/* -------------------------------------------------- selection and drag */

/** Click opens; Ctrl/⌘-click toggles selection; Shift-click selects a range. */
function wireChat(row, conv) {
  row.onclick = (e) => {
    if (e.metaKey || e.ctrlKey) {
      // Reading a chat is not selecting it: the selection is exactly what you
      // clicked, so Move never carries along the one that happens to be open.
      if (S.sel.has(conv.id)) S.sel.delete(conv.id); else S.sel.add(conv.id);
      S.lastClicked = conv.id;
      renderExplorer();
      renderBulk();
      return;
    }
    if (e.shiftKey && S.lastClicked) {
      const order = $$('[data-id]', $('#exbody')).map((r) => r.dataset.id);
      const a = order.indexOf(S.lastClicked);
      const b = order.indexOf(conv.id);
      if (a >= 0 && b >= 0) {
        for (const id of order.slice(Math.min(a, b), Math.max(a, b) + 1)) S.sel.add(id);
        renderExplorer();
        renderBulk();
        return;
      }
    }
    S.sel.clear();
    S.lastClicked = conv.id;
    renderBulk();
    openConv(conv.id);
  };
  row.oncontextmenu = (e) => { e.preventDefault(); chatMenu(conv, at(e)); };
  row.draggable = true;
  row.addEventListener('dragstart', (e) => {
    // Dragging an unselected row drags just that one.
    const ids = S.sel.has(conv.id) ? [...S.sel] : [conv.id];
    e.dataTransfer.setData(DT_IDS, JSON.stringify(ids));
    e.dataTransfer.effectAllowed = 'move';
  });
}

/** Accept a drop of conversations, of a folder, or both. */
function dropTarget(node, { onDropIds, onDropFolder }) {
  // dragover can read types but never data, so the decision is made on type.
  const kind = (dt) => (onDropIds && dt.types.includes(DT_IDS) ? 'ids'
    : onDropFolder && dt.types.includes(DT_FOLDER) ? 'folder' : null);
  node.addEventListener('dragover', (e) => {
    if (!kind(e.dataTransfer)) return;
    e.preventDefault();
    node.classList.add('drop');
  });
  node.addEventListener('dragleave', () => node.classList.remove('drop'));
  node.addEventListener('drop', (e) => {
    node.classList.remove('drop');
    const k = kind(e.dataTransfer);
    if (!k) return;
    e.preventDefault();
    e.stopPropagation();
    if (k === 'ids') onDropIds(JSON.parse(e.dataTransfer.getData(DT_IDS)));
    else onDropFolder(e.dataTransfer.getData(DT_FOLDER));
  });
  return node;
}

/* ------------------------------------------------------------- bulk bar */

export function renderBulk() {
  const bar = $('#bulk');
  bar.textContent = '';
  // From the first selected chat: a selection with nothing to do with it is a
  // dead end.
  bar.hidden = S.sel.size === 0;
  if (bar.hidden) return;
  const ids = [...S.sel];
  const allStar = ids.every((i) => metaOf(i).starred);
  bar.append(
    el('span', 'cnt', `${ids.length} selected`),
    btn('folder', 'Move', (e) => movePicker(ids, at(e))),
    btn('hash', 'Tag', (e) => tagPicker(ids, at(e))),
    btn('star', allStar ? 'Unstar' : 'Star', () => star(ids, !allStar)),
    btn('archive', 'Archive', () => archive(ids, true)),
    btn('trash', 'Remove', () => remove(ids), 'danger'),
    iconBtn('x', 'Clear selection (Esc)', () => { S.sel.clear(); renderExplorer(); renderBulk(); }),
  );
}
