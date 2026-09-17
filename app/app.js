/* ==========================================================================
   organizer — reader + organizer

   No framework, no dependencies, no network calls. Storage is IndexedDB behind
   the STORE object; swapping in SQLite-WASM later means reimplementing those
   methods and nothing else.

   Imported conversations are never modified. Everything the user does — folder,
   tags, star, archive — lives in a separate `meta` store keyed by conversation
   id, so a re-import overwrites the conversation and leaves the organization
   untouched.
   ========================================================================== */

import * as T from '../packages/organize/folders.js';
import * as O from '../packages/organize/outline.js';

const $ = (s, r = document) => r.querySelector(s);
const el = (t, cls, txt) => {
  const n = document.createElement(t);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));

/* ------------------------------------------------------------------ store */

const STORES = ['conversations', 'meta', 'folders', 'smart'];

const STORE = {
  db: null,
  ephemeral: false,
  reason: null,
  mem: { conversations: new Map(), meta: new Map(), folders: new Map(), smart: new Map() },

  async open() {
    // Chrome denies IndexedDB to file:// and other opaque origins. Fall back to
    // memory for the session rather than dying, and say so in the UI.
    try {
      this.db = await new Promise((res, rej) => {
        const r = indexedDB.open('organizer', 2);
        r.onupgradeneeded = () => {
          const db = r.result;
          if (!db.objectStoreNames.contains('conversations')) {
            db.createObjectStore('conversations', { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'convId' });
          if (!db.objectStoreNames.contains('folders')) db.createObjectStore('folders', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('smart')) db.createObjectStore('smart', { keyPath: 'id' });
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
        r.onblocked = () => rej(new Error('another tab is holding an older version open'));
      });
    } catch (e) {
      this.ephemeral = true;
      this.reason = e.message;
    }
  },

  async put(store, rows) {
    if (!rows.length) return;
    if (this.ephemeral) {
      const key = store === 'meta' ? 'convId' : 'id';
      for (const r of rows) this.mem[store].set(r[key], r);
      return;
    }
    const tx = this.db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    for (const r of rows) os.put(r);
    return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  },

  async del(store, keys) {
    if (!keys.length) return;
    if (this.ephemeral) { for (const k of keys) this.mem[store].delete(k); return; }
    const tx = this.db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    for (const k of keys) os.delete(k);
    return new Promise((res) => { tx.oncomplete = res; });
  },

  async all(store) {
    if (this.ephemeral) return [...this.mem[store].values()];
    return new Promise((res, rej) => {
      const r = this.db.transaction(store, 'readonly').objectStore(store).getAll();
      r.onsuccess = () => res(r.result || []);
      r.onerror = () => rej(r.error);
    });
  },

  async clearAll() {
    if (this.ephemeral) { for (const s of STORES) this.mem[s].clear(); return; }
    const tx = this.db.transaction(STORES, 'readwrite');
    for (const s of STORES) tx.objectStore(s).clear();
    return new Promise((res) => { tx.oncomplete = res; });
  },
};

/* ------------------------------------------------------------------ state */

const S = {
  convs: [],
  meta: new Map(),      // convId -> {convId, folderId, tags[], starred, archived}
  folders: [],          // {id, name, parentId}
  smart: [],            // {id, name, q}
  index: new Map(),
  providers: new Set(),
  openId: null,
  query: '',
  provider: null,
  view: { kind: 'all', id: null },
  sel: new Set(),
  branchPick: new Map(),
  collapsed: new Set(),  // folder ids; view state, so localStorage not IndexedDB
  subfolders: true,      // does a folder view include the folders beneath it
  template: 'transcript',
  anchor: new Map(),     // message id -> the element showing it, for the ribbon
  bars: [],
};

/* Per-device view state. Deliberately not in the store: it is about this
   screen, not about the library, and it must not travel with an export. */
const PREFS = {
  load() {
    try {
      S.collapsed = new Set(JSON.parse(localStorage.getItem('organizer.collapsed') || '[]'));
      S.subfolders = localStorage.getItem('organizer.subfolders') !== '0';
      S.template = localStorage.getItem('organizer.template') || 'transcript';
    } catch { /* private mode, or storage off — defaults are fine */ }
  },
  save() {
    try {
      localStorage.setItem('organizer.collapsed', JSON.stringify([...S.collapsed]));
      localStorage.setItem('organizer.subfolders', S.subfolders ? '1' : '0');
      localStorage.setItem('organizer.template', S.template);
    } catch {}
  },
};

const metaOf = (id) =>
  S.meta.get(id) || { convId: id, folderId: null, tags: [], starred: false, archived: false };

async function setMeta(ids, patch) {
  const rows = ids.map((id) => {
    const m = { ...metaOf(id), ...(typeof patch === 'function' ? patch(metaOf(id)) : patch) };
    S.meta.set(id, m);
    return m;
  });
  await STORE.put('meta', rows);
}

/* ---------------------------------------------------------------- import */

function readPayload(json, filename) {
  const out = [];
  const take = (c) => {
    if (c && c.kind === 'conversation' && Array.isArray(c.messages)) out.push(c);
  };
  if (json && json.kind === 'conversation') take(json);
  else if (json && Array.isArray(json.conversations)) json.conversations.forEach(take);
  else if (Array.isArray(json)) json.forEach(take);

  if (!out.length) throw new Error(`${filename}: no conversations found — is this a .chat file?`);
  for (const c of out) {
    const v = String(c.schemaVersion || '0');
    if (!/^0\./.test(v)) throw new Error(`${filename}: schemaVersion ${v} is newer than this reader.`);
  }
  return out;
}

/**
 * Claude's conversation list carries project membership, so an import can build
 * the folder tree from Projects the user already made. Only ever seeds a
 * conversation that has no meta yet — it must not override filing you did
 * yourself when you re-import.
 */
async function seedFolders(convs) {
  const byName = new Map(S.folders.map((f) => [f.name.toLowerCase(), f]));
  const newFolders = [];
  const newMeta = [];
  for (const c of convs) {
    const name = c.projectRef?.name;
    if (!name || S.meta.has(c.id)) continue;
    let f = byName.get(name.toLowerCase());
    if (!f) {
      f = { id: uid(), name, parentId: null };
      byName.set(name.toLowerCase(), f);
      newFolders.push(f);
      S.folders.push(f);
    }
    const m = { convId: c.id, folderId: f.id, tags: [], starred: !!c.starred, archived: false };
    S.meta.set(c.id, m);
    newMeta.push(m);
  }
  await STORE.put('folders', newFolders);
  await STORE.put('meta', newMeta);
  return newFolders.length;
}

async function importFiles(files) {
  const added = [];
  const errors = [];
  for (const f of files) {
    try {
      added.push(...readPayload(JSON.parse(await f.text()), f.name));
    } catch (e) { errors.push(e.message); }
  }
  if (added.length) {
    // Keyed by conversation id, so re-importing an overlapping export updates
    // in place rather than duplicating the library.
    await STORE.put('conversations', added);
    S.meta = new Map((await STORE.all('meta')).map((m) => [m.convId, m]));
    const seeded = await seedFolders(added);
    await load();
    toast(`Imported ${added.length} conversation${added.length > 1 ? 's' : ''}` +
          (seeded ? `, ${seeded} folder${seeded > 1 ? 's' : ''} from projects` : ''));
  }
  if (errors.length) alert(errors.join('\n'));
}

/* ------------------------------------------------------------- text index */

const blockText = (b) => {
  if (!b) return '';
  if (b.type === 'thinking') return [b.text || '', ...(b.summaries || [])].join(' ');
  return b.text || b.filename || '';
};
const convText = (c) =>
  [c.title, c.summary || '', ...c.messages.flatMap((m) => m.content.map(blockText))].join('\n');

function reindex() {
  S.index.clear();
  S.providers = new Set();
  for (const c of S.convs) {
    S.index.set(c.id, convText(c).toLowerCase());
    S.providers.add(c.provider);
  }
}

/* -------------------------------------------------------------- filtering */

function inView(c) {
  const m = metaOf(c.id);
  switch (S.view.kind) {
    case 'all': return !m.archived;
    case 'starred': return m.starred && !m.archived;
    case 'archived': return m.archived;
    case 'untagged': return !m.folderId && !m.tags.length && !m.archived;
    case 'folder':
      if (m.archived || !m.folderId) return false;
      return S.subfolders ? subtree(S.view.id).has(m.folderId) : m.folderId === S.view.id;
    case 'tag': return m.tags.includes(S.view.id) && !m.archived;
    default: return !m.archived;
  }
}

function matches(c) {
  if (!inView(c)) return false;
  if (S.provider && c.provider !== S.provider) return false;
  if (!S.query) return true;
  const hay = S.index.get(c.id) || '';
  return S.query.split(/\s+/).filter(Boolean).every((t) => hay.includes(t));
}

const shown = () => S.convs.filter(matches);

function snippet(c) {
  if (!S.query) return '';
  const terms = S.query.split(/\s+/).filter(Boolean);
  const raw = convText(c);
  const low = raw.toLowerCase();
  let at = -1;
  for (const t of terms) { const i = low.indexOf(t); if (i >= 0 && (at < 0 || i < at)) at = i; }
  if (at < 0) return '';
  const from = Math.max(0, at - 45);
  let frag = raw.slice(from, from + 190).replace(/\s+/g, ' ');
  if (from > 0) frag = '…' + frag;
  let html = esc(frag);
  for (const t of terms) {
    html = html.replace(new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<mark>$1</mark>');
  }
  return html;
}

/* ------------------------------------------------------------- rendering */

function renderMath(tex, display) {
  if (typeof katex !== 'undefined') {
    try {
      return katex.renderToString(tex, { displayMode: display, throwOnError: false, output: 'html' });
    } catch { /* fall through to source */ }
  }
  return `<span class="math${display ? ' block' : ''}">${esc(tex)}</span>`;
}

/** `$…$` collides with currency. Reject "a number, a space, a word". */
const looksLikeMoney = (t) => /^\d[\d,]*(\.\d+)?\s+\w/.test(t);

function md(src) {
  const slots = [];
  const slot = (html) => ` S${slots.push(html) - 1} `;
  let s = String(src ?? '').replace(/\r\n/g, '\n');

  // Fences, then inline code, then maths — so `$5` in backticks stays currency.
  s = s.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (_, lang, code) =>
    slot(`<pre><code data-lang="${esc(lang)}">${esc(code.replace(/\n$/, ''))}</code></pre>`));
  s = s.replace(/`([^`\n]+)`/g, (_, c) => slot(`<code>${esc(c)}</code>`));
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, (_, m) => slot(renderMath(m.trim(), true)));
  s = s.replace(/\\\[([\s\S]+?)\\\]/g, (_, m) => slot(renderMath(m.trim(), true)));
  s = s.replace(/\\\(([\s\S]+?)\\\)/g, (_, m) => slot(renderMath(m.trim(), false)));
  s = s.replace(/\$([^$\n]+)\$/g, (whole, m) =>
    looksLikeMoney(m) ? whole : slot(renderMath(m, false)));

  s = esc(s);

  const inline = (t) => t
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\W)\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
      '<a href="$2" rel="noopener noreferrer" target="_blank">$1</a>');

  const out = [];
  const lines = s.split('\n');
  let list = null, para = [], table = null;

  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  const flushList = () => {
    if (list) {
      out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`);
      list = null;
    }
  };
  const flushTable = () => {
    if (!table) return;
    const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
    const head = `<tr>${cells(table[0]).map((c) => `<th>${c}</th>`).join('')}</tr>`;
    const body = table.slice(2).map((r) => `<tr>${cells(r).map((c) => `<td>${c}</td>`).join('')}</tr>`).join('');
    out.push(`<table>${head}${body}</table>`);
    table = null;
  };
  const flushAll = () => { flushPara(); flushList(); flushTable(); };

  for (let li = 0; li < lines.length; li++) {
    const t = lines[li].trim();
    if (table) {
      if (/^\|.*\|$/.test(t)) { table.push(t); continue; }
      flushTable();
    }
    if (!t) { flushAll(); continue; }
    if (/^ S\d+ $/.test(t)) { flushAll(); out.push(slots[+t.slice(2, -1)]); continue; }

    const h = t.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushAll();
      const n = Math.min(h[1].length, 3);
      out.push(`<h${n}>${inline(h[2])}</h${n}>`);
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { flushAll(); out.push('<hr>'); continue; }
    if (/^&gt;\s?/.test(t)) { flushAll(); out.push(`<blockquote>${inline(t.replace(/^&gt;\s?/, ''))}</blockquote>`); continue; }

    if (/^\|.*\|$/.test(t)) {
      const next = lines[li + 1];
      if (next && /^\s*\|[\s:|-]+\|\s*$/.test(next)) { flushPara(); flushList(); table = [t]; continue; }
    }

    const ul = t.match(/^[-*+]\s+(.*)$/);
    const ol = t.match(/^\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      flushPara(); flushTable();
      const tag = ul ? 'ul' : 'ol';
      if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
      list.items.push((ul || ol)[1]);
      continue;
    }
    flushList(); flushTable();
    para.push(t);
  }
  flushAll();
  return out.join('\n').replace(/ S(\d+) /g, (_, i) => slots[+i]);
}

/* ------------------------------------------------------------ thread path */

function mainPath(conv) {
  const byId = new Map(conv.messages.map((m) => [m.id, m]));
  const kids = new Map();
  for (const m of conv.messages) {
    if (!kids.has(m.parentId)) kids.set(m.parentId, []);
    kids.get(m.parentId).push(m);
  }
  for (const l of kids.values()) l.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));

  const roots = kids.get(null) || [];
  if (!roots.length) return { path: conv.messages.slice(), kids, byId, rootCount: 0 };

  let node = roots[0];
  const path = [node];
  for (let i = 0; i < conv.messages.length + 1; i++) {
    const children = kids.get(node.id) || [];
    if (!children.length) break;
    let next = children[0];
    const picked = S.branchPick.get(node.id);
    if (picked && byId.has(picked)) next = byId.get(picked);
    else if (children.length > 1 && conv.currentLeafId) {
      // Prefer the child whose subtree holds the provider's own leaf.
      const anc = new Set();
      let c = byId.get(conv.currentLeafId);
      while (c) { anc.add(c.id); c = c.parentId ? byId.get(c.parentId) : null; }
      next = children.find((ch) => anc.has(ch.id)) || children[0];
    }
    path.push(next);
    node = next;
  }
  return { path, kids, byId, rootCount: roots.length };
}

/* -------------------------------------------------------------------- nav */

/* Bound to the loaded tree; the logic itself lives in packages/organize. */
const folderById = (id) => T.byId(S.folders, id);
const folderChildren = (pid) => T.childrenOf(S.folders, pid);
const subtree = (id) => T.subtree(S.folders, id);
const folderPath = (id) => T.pathOf(S.folders, id);
const folderList = () => T.flatten(S.folders);
const canMove = (id, toId) => T.canMove(S.folders, id, toId);

/**
 * A parentId pointing at a folder that no longer exists makes its whole branch
 * unreachable — nothing walks to it, so it disappears from the tree while
 * staying in the store. Re-root those instead of leaving them invisible.
 */
async function repairFolders() {
  const lost = T.orphans(S.folders);
  for (const f of lost) f.parentId = null;
  if (lost.length) await STORE.put('folders', lost);
}

function counts() {
  const c = { all: 0, starred: 0, archived: 0, untagged: 0, folder: new Map(), tag: new Map() };
  for (const conv of S.convs) {
    const m = metaOf(conv.id);
    if (m.archived) { c.archived++; continue; }
    c.all++;
    if (m.starred) c.starred++;
    if (!m.folderId && !m.tags.length) c.untagged++;
    if (m.folderId) c.folder.set(m.folderId, (c.folder.get(m.folderId) || 0) + 1);
    for (const t of m.tags) c.tag.set(t, (c.tag.get(t) || 0) + 1);
  }
  // A folder whose conversations all live in its subfolders would otherwise
  // read as empty, which is just wrong.
  c.folderAll = T.rollUp(S.folders, c.folder);
  return c;
}

/* ------------------------------------------------------------ folder edits */

function toggleFolder(id) {
  if (S.collapsed.has(id)) S.collapsed.delete(id); else S.collapsed.add(id);
  PREFS.save();
  renderNav();
}

/** Open every ancestor, so selecting a folder can never scroll to nothing. */
function revealFolder(id) {
  for (let f = folderById(id), i = 0; f && f.parentId && i < 64; f = folderById(f.parentId), i++) {
    S.collapsed.delete(f.parentId);
  }
  PREFS.save();
}

async function newFolder(parentId = null) {
  const name = prompt(parentId ? `New folder inside "${folderPath(parentId)}"` : 'Folder name');
  if (!name?.trim()) return;
  const f = { id: uid(), name: name.trim(), parentId };
  S.folders.push(f);
  if (parentId) { S.collapsed.delete(parentId); PREFS.save(); }
  await STORE.put('folders', [f]);
  renderAll();
}

async function renameFolder(f) {
  const name = prompt('Rename folder', f.name);
  if (!name?.trim() || name.trim() === f.name) return;
  f.name = name.trim();
  await STORE.put('folders', [f]);
  renderAll();
}

async function moveFolder(id, toId) {
  const f = folderById(id);
  if (!f || !canMove(id, toId) || f.parentId === (toId || null)) return;
  f.parentId = toId || null;
  if (toId) { S.collapsed.delete(toId); PREFS.save(); }
  await STORE.put('folders', [f]);
  renderAll();
}

/**
 * Children are reparented rather than dropped. Deleting a folder should lose
 * one folder, not a branch — and orphans would vanish silently.
 */
async function deleteFolder(f) {
  const kids = folderChildren(f.id);
  const ids = S.convs.filter((x) => metaOf(x.id).folderId === f.id).map((x) => x.id);
  const up = f.parentId ? `"${folderPath(f.parentId)}"` : 'the top level';
  const lines = [`Delete the folder "${f.name}"?`, ''];
  if (kids.length) {
    lines.push(kids.length > 1
      ? `Its ${kids.length} subfolders move up to ${up}.`
      : `Its subfolder "${kids[0].name}" moves up to ${up}.`);
  }
  if (ids.length) {
    lines.push(ids.length > 1
      ? `${ids.length} conversations become unfiled. Nothing leaves the library.`
      : `1 conversation becomes unfiled. Nothing leaves the library.`);
  }
  if (!confirm(lines.join('\n'))) return;

  const lifted = T.reparentOnDelete(S.folders, f.id);
  for (const k of lifted) Object.assign(folderById(k.id), k);
  await STORE.put('folders', lifted);
  if (ids.length) await setMeta(ids, { folderId: null });
  S.folders = S.folders.filter((x) => x.id !== f.id);
  await STORE.del('folders', [f.id]);
  if (S.view.kind === 'folder' && S.view.id === f.id) S.view = { kind: 'all', id: null };
  renderAll();
}

const DT_IDS = 'application/x-organizer-ids';
const DT_FOLDER = 'application/x-organizer-folder';

/** A small context menu. Items are {label, run, danger} or the string '-'. */
function menu(items, x, y) {
  document.querySelector('.menu')?.remove();
  const m = el('div', 'menu');
  m.style.left = `${x}px`;
  m.style.top = `${y}px`;
  for (const it of items) {
    if (it === '-') { m.append(el('hr')); continue; }
    const b = el('button', it.danger ? 'danger' : null, it.label);
    b.onclick = () => { m.remove(); it.run(); };
    m.append(b);
  }
  document.body.append(m);

  const r = m.getBoundingClientRect();
  if (r.right > innerWidth) m.style.left = `${Math.max(4, innerWidth - r.width - 4)}px`;
  if (r.bottom > innerHeight) m.style.top = `${Math.max(4, innerHeight - r.height - 4)}px`;

  const close = (e) => {
    if (m.contains(e.target)) return;
    m.remove();
    document.removeEventListener('mousedown', close);
  };
  setTimeout(() => document.addEventListener('mousedown', close));
}

/** Accept a drop of conversations, of a folder, or of both. */
function dropTarget(node, { onDropIds, onDropFolder }) {
  // dragover can read types but never data, so the decision is made on type.
  const kind = (dt) =>
    onDropIds && dt.types.includes(DT_IDS) ? 'ids'
      : onDropFolder && dt.types.includes(DT_FOLDER) ? 'folder'
        : null;
  node.addEventListener('dragover', (e) => {
    if (!kind(e.dataTransfer)) return;
    e.preventDefault();
    node.classList.add('drop-hot');
  });
  node.addEventListener('dragleave', () => node.classList.remove('drop-hot'));
  node.addEventListener('drop', (e) => {
    node.classList.remove('drop-hot');
    const k = kind(e.dataTransfer);
    if (!k) return;
    e.preventDefault();
    if (k === 'ids') onDropIds(JSON.parse(e.dataTransfer.getData(DT_IDS)));
    else onDropFolder(e.dataTransfer.getData(DT_FOLDER));
  });
  return node;
}

function navItem({ ico, label, n, active, onClick, onDropIds, onDropFolder, dragFolderId, title }) {
  const b = el('button', 'nav-item');
  b.setAttribute('aria-current', String(!!active));
  if (title) b.title = title;
  b.append(el('span', 'ico', ico));
  b.append(el('span', 'lbl', label));
  if (n != null) b.append(el('span', 'n', String(n)));
  b.onclick = onClick;

  if (dragFolderId) {
    b.draggable = true;
    b.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData(DT_FOLDER, dragFolderId);
      e.dataTransfer.effectAllowed = 'move';
    });
  }
  if (onDropIds || onDropFolder) dropTarget(b, { onDropIds, onDropFolder });
  return b;
}

function renderNav() {
  const body = $('#navbody');
  body.textContent = '';
  const c = counts();
  const go = (kind, id = null) => () => { S.view = { kind, id }; S.sel.clear(); renderAll(); };

  const top = el('div', 'sect');
  top.append(
    navItem({ ico: '◻', label: 'All', n: c.all, active: S.view.kind === 'all', onClick: go('all'),
              onDropIds: (ids) => fileInto(ids, null) }),
    navItem({ ico: '★', label: 'Starred', n: c.starred, active: S.view.kind === 'starred', onClick: go('starred'),
              onDropIds: (ids) => setMeta(ids, { starred: true }).then(renderAll) }),
    navItem({ ico: '⊘', label: 'Unfiled', n: c.untagged, active: S.view.kind === 'untagged', onClick: go('untagged') }),
    navItem({ ico: '▤', label: 'Archived', n: c.archived, active: S.view.kind === 'archived', onClick: go('archived'),
              onDropIds: (ids) => setMeta(ids, { archived: true }).then(renderAll) }),
  );
  body.append(top);

  // --- folders ---------------------------------------------------------
  const fs = el('div', 'sect');
  const fh = el('h2', null, 'Folders');
  fh.title = 'Drop a folder here to move it back to the top level';
  const addF = el('button', 'add', '+');
  addF.title = 'New folder';
  addF.onclick = (e) => { e.stopPropagation(); newFolder(null); };
  fh.append(addF);
  dropTarget(fh, { onDropFolder: (id) => moveFolder(id, null) });
  fs.append(fh);

  const walk = (pid, depth) => {
    for (const f of folderChildren(pid)) {
      const kids = folderChildren(f.id);
      const open = !S.collapsed.has(f.id);
      const item = navItem({
        ico: kids.length ? (open ? '▾' : '▸') : '·',
        label: f.name,
        n: c.folderAll.get(f.id) || 0,
        active: S.view.kind === 'folder' && S.view.id === f.id,
        onClick: () => { revealFolder(f.id); go('folder', f.id)(); },
        onDropIds: (ids) => fileInto(ids, f.id),
        onDropFolder: (id) => moveFolder(id, f.id),
        dragFolderId: f.id,
        title: `${folderPath(f.id)}\nDrag to move · double-click to rename · right-click for more`,
      });
      item.style.paddingLeft = `${8 + depth * 12}px`;

      // The triangle toggles; the rest of the row selects. Capture, so this
      // runs before the button's own click handler.
      if (kids.length) {
        item.querySelector('.ico').style.cursor = 'pointer';
        item.addEventListener('click', (e) => {
          if (!e.target.classList.contains('ico')) return;
          e.stopPropagation();
          toggleFolder(f.id);
        }, true);
      }

      item.ondblclick = () => renameFolder(f);
      item.oncontextmenu = (e) => {
        e.preventDefault();
        menu([
          { label: 'New folder inside', run: () => newFolder(f.id) },
          { label: 'Rename…', run: () => renameFolder(f) },
          ...(f.parentId ? [{ label: 'Move to top level', run: () => moveFolder(f.id, null) }] : []),
          '-',
          { label: 'Delete…', run: () => deleteFolder(f), danger: true },
        ], e.clientX, e.clientY);
      };

      fs.append(item);
      if (open) walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  if (!S.folders.length) fs.append(el('div', 'nav-empty', 'Drag conversations here, or import Claude chats to seed from Projects.'));
  body.append(fs);

  // --- saved searches --------------------------------------------------
  const ss = el('div', 'sect');
  const sh = el('h2', null, 'Saved searches');
  const addS = el('button', 'add', '+');
  addS.title = 'Save the current search and filters';
  addS.onclick = async (e) => {
    e.stopPropagation();
    if (!S.query && !S.provider && S.view.kind === 'all') {
      alert('Type a search or pick a filter first, then save it.');
      return;
    }
    const name = prompt('Name this search', S.query || 'Saved search');
    if (!name?.trim()) return;
    const s = { id: uid(), name: name.trim(), q: { text: S.query, provider: S.provider, view: { ...S.view } } };
    S.smart.push(s);
    await STORE.put('smart', [s]);
    renderAll();
  };
  sh.append(addS);
  ss.append(sh);
  for (const s of S.smart) {
    const item = navItem({
      ico: '⌕', label: s.name, active: false,
      onClick: () => {
        S.query = s.q.text || '';
        S.provider = s.q.provider || null;
        S.view = s.q.view || { kind: 'all', id: null };
        if (S.view.kind === 'folder') revealFolder(S.view.id);
        $('#q').value = S.query;
        S.sel.clear();
        renderAll();
      },
      title: 'Shift-click to delete',
    });
    item.addEventListener('click', async (e) => {
      if (!e.shiftKey) return;
      e.stopPropagation();
      S.smart = S.smart.filter((x) => x.id !== s.id);
      await STORE.del('smart', [s.id]);
      renderAll();
    }, true);
    ss.append(item);
  }
  if (!S.smart.length) ss.append(el('div', 'nav-empty', 'Search, then press + to keep it.'));
  body.append(ss);

  // --- tags ------------------------------------------------------------
  if (c.tag.size) {
    const ts = el('div', 'sect');
    ts.append(el('h2', null, 'Tags'));
    for (const [tag, n] of [...c.tag].sort((a, b) => b[1] - a[1])) {
      ts.append(navItem({
        ico: '#', label: tag, n,
        active: S.view.kind === 'tag' && S.view.id === tag,
        onClick: go('tag', tag),
        onDropIds: (ids) => setMeta(ids, (m) => ({ tags: [...new Set([...m.tags, tag])] })).then(renderAll),
      }));
    }
    body.append(ts);
  }
}

async function fileInto(ids, folderId) {
  await setMeta(ids, { folderId });
  renderAll();
}

/* ------------------------------------------------------------------- list */

const fmtDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};

function scopeLabel() {
  const v = S.view;
  if (v.kind === 'folder') return folderPath(v.id) || 'Folder';
  if (v.kind === 'tag') return `#${v.id}`;
  return { all: 'All', starred: 'Starred', archived: 'Archived', untagged: 'Unfiled' }[v.kind] || 'All';
}

function renderList() {
  const list = $('#list');
  list.textContent = '';
  const rows = shown();
  $('#scope').textContent = `${scopeLabel()} · ${rows.length}`;
  document.body.classList.toggle('selecting', S.sel.size > 0);

  if (!S.convs.length) { list.append(el('div', 'empty', 'Nothing imported yet.')); renderBulk(); return; }
  if (!rows.length) { list.append(el('div', 'empty', 'No conversations here.')); renderBulk(); return; }

  for (const c of rows) {
    const m = metaOf(c.id);
    const row = el('div', 'row');
    row.setAttribute('aria-current', String(c.id === S.openId));
    row.draggable = true;
    row.addEventListener('dragstart', (e) => {
      // Dragging an unselected row drags just that one.
      const ids = S.sel.has(c.id) ? [...S.sel] : [c.id];
      e.dataTransfer.setData(DT_IDS, JSON.stringify(ids));
      e.dataTransfer.effectAllowed = 'move';
    });

    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = S.sel.has(c.id);
    cb.onclick = (e) => e.stopPropagation();
    cb.onchange = () => {
      if (cb.checked) S.sel.add(c.id); else S.sel.delete(c.id);
      document.body.classList.toggle('selecting', S.sel.size > 0);
      renderBulk();
    };
    row.append(cb);

    const main = el('div', 'main');
    main.append(el('div', 't', c.title || '(untitled)'));
    const meta = el('div', 'm');
    meta.append(el('span', `dot ${c.provider}`));
    meta.append(el('span', null, fmtDate(c.updatedAt || c.createdAt)));
    meta.append(el('span', null, '·'));
    meta.append(el('span', null, `${c.messages.length} msg`));
    if (m.starred) meta.append(el('span', null, '★'));
    if (m.folderId) {
      const f = folderById(m.folderId);
      if (f) {
        const chip = el('span', 'tagchip', f.name);
        chip.title = folderPath(f.id);  // the name alone is ambiguous once nested
        meta.append(chip);
      }
    }
    for (const t of m.tags) meta.append(el('span', 'tagchip', `#${t}`));
    main.append(meta);
    const sn = snippet(c);
    if (sn) { const d = el('div', 'snip'); d.innerHTML = sn; main.append(d); }
    main.onclick = () => openConv(c.id);
    row.append(main);
    list.append(row);
  }
  renderBulk();
}

/* -------------------------------------------------------------- bulk bar */

function renderBulk() {
  const bar = $('#bulk');
  bar.textContent = '';
  bar.hidden = S.sel.size === 0;
  if (!S.sel.size) return;
  const ids = [...S.sel];

  bar.append(el('span', 'cnt', `${ids.length} selected`));

  const sel = el('select');
  sel.append(new Option('Move to…', ''));
  sel.append(new Option('— no folder —', '__none'));
  for (const f of folderList()) sel.append(new Option(folderPath(f.id), f.id));
  sel.onchange = async () => {
    if (!sel.value) return;
    await fileInto(ids, sel.value === '__none' ? null : sel.value);
  };
  bar.append(sel);

  const tag = el('button', null, 'Tag…');
  tag.onclick = async () => {
    const t = prompt('Add tag to ' + ids.length + ' conversation(s)');
    if (!t?.trim()) return;
    const name = t.trim().replace(/^#/, '');
    await setMeta(ids, (m) => ({ tags: [...new Set([...m.tags, name])] }));
    renderAll();
  };
  bar.append(tag);

  const allStar = ids.every((i) => metaOf(i).starred);
  const star = el('button', null, allStar ? 'Unstar' : 'Star');
  star.onclick = async () => { await setMeta(ids, { starred: !allStar }); renderAll(); };
  bar.append(star);

  const allArch = ids.every((i) => metaOf(i).archived);
  const arch = el('button', null, allArch ? 'Unarchive' : 'Archive');
  arch.onclick = async () => { await setMeta(ids, { archived: !allArch }); S.sel.clear(); renderAll(); };
  bar.append(arch);

  const rm = el('button', 'danger', 'Remove');
  rm.title = 'Remove from this library. The original chats are untouched.';
  rm.onclick = async () => {
    if (!confirm(`Remove ${ids.length} conversation(s) from this library?\n\n` +
                 `The originals on Claude and ChatGPT are untouched, and you can re-import.`)) return;
    await STORE.del('conversations', ids);
    await STORE.del('meta', ids);
    for (const i of ids) S.meta.delete(i);
    if (ids.includes(S.openId)) S.openId = null;
    S.sel.clear();
    await load();
  };
  bar.append(rm);

  const clear = el('button', null, 'Clear');
  clear.onclick = () => { S.sel.clear(); renderAll(); };
  bar.append(clear);
}

/* ----------------------------------------------------------------- thread */

function renderBlock(b) {
  switch (b.type) {
    case 'text': { const d = el('div'); d.innerHTML = md(b.text); return d; }
    case 'code': {
      const pre = el('pre'); const code = el('code', null, b.text || '');
      if (b.lang) code.dataset.lang = b.lang;
      pre.append(code); return pre;
    }
    case 'thinking': {
      const n = Array.isArray(b.summaries) ? b.summaries.length : 0;
      const d = el('details', 'blk');
      d.append(el('summary', null, n ? `Thought — ${n} step${n > 1 ? 's' : ''}` : 'Thought'));
      const inner = el('div', 'inner');
      if (n) { const ul = el('ul'); for (const s of b.summaries) ul.append(el('li', null, s)); inner.append(ul); }
      if (b.text) { const t = el('div'); t.innerHTML = md(b.text); inner.append(t); }
      d.append(inner); return d;
    }
    case 'tool_use': {
      const d = el('details', 'blk');
      d.append(el('summary', null, `Tool call — ${b.name || 'tool'}`));
      const inner = el('div', 'inner'); const pre = el('pre');
      pre.append(el('code', null, b.text || (b.input != null ? JSON.stringify(b.input, null, 2) : '')));
      inner.append(pre); d.append(inner); return d;
    }
    case 'tool_result': {
      const d = el('details', 'blk');
      d.append(el('summary', null, b.isError ? 'Tool result — error'
        : `Tool result${b.meta?.kind ? ` — ${b.meta.kind}` : ''}`));
      const inner = el('div', 'inner'); const pre = el('pre');
      pre.append(el('code', null, b.text || ''));
      inner.append(pre); d.append(inner); return d;
    }
    case 'image':
    case 'file': {
      const label = b.type === 'image' ? 'Image' : 'File';
      const name = b.filename ? ` · ${b.filename}` : '';
      const dim = b.width && b.height ? ` · ${b.width}×${b.height}` : '';
      return el('div', 'placeholder', `${label}${name}${dim} — not downloaded (attachments are captured as references)`);
    }
    case 'citation':
      return el('div', 'placeholder', `Citation — ${b.title || b.url || ''}`);
    default: {
      const d = el('details', 'blk');
      d.append(el('summary', null, `Unrecognised block — ${b.type}`));
      const inner = el('div', 'inner'); const pre = el('pre');
      pre.append(el('code', null, JSON.stringify(b, null, 2)));
      inner.append(pre); d.append(inner); return d;
    }
  }
}

function renderThread() {
  const main = $('#main');
  main.textContent = '';
  const conv = S.convs.find((c) => c.id === S.openId);

  if (!conv) {
    const w = el('div', 'welcome');
    w.innerHTML = S.convs.length
      ? '<h2>Pick a conversation</h2><p>Search runs across every message, not just titles. Drag conversations onto a folder to file them.</p>'
      : `<h2>Import your chats</h2>
         <p>Nothing is uploaded anywhere. Everything stays in this browser.</p>
         <ol>
           <li>Load <code>extension/</code> unpacked in Chrome and click its icon, or paste
               <code>tools/dist/export.js</code> into the console on claude.ai / chatgpt.com.</li>
           <li>Pick the conversations you want and export.</li>
           <li>Drop the downloaded file into the panel on the left.</li>
         </ol>`;
    main.append(w);
    return;
  }

  const m = metaOf(conv.id);
  const { path, kids, rootCount } = mainPath(conv);
  const wrap = el('div', 'thread');

  const back = el('button', 'icon-btn back', '← all conversations');
  back.onclick = () => document.body.classList.remove('reading');
  wrap.append(back);

  const head = el('div', 'thread-head');
  head.append(el('h2', null, conv.title || '(untitled)'));
  const meta = el('div', 'meta');
  meta.append(el('span', `dot ${conv.provider}`));
  meta.append(el('span', null, conv.provider));
  if (conv.model) { meta.append(el('span', null, '·')); meta.append(el('span', null, conv.model)); }
  meta.append(el('span', null, '·'));
  meta.append(el('span', null, fmtDate(conv.createdAt)));
  meta.append(el('span', null, '·'));
  meta.append(el('span', null, `${path.length} of ${conv.messages.length} messages on this path`));
  if (conv.sourceUrl) {
    const a = el('a', null, 'open original ↗');
    a.href = conv.sourceUrl; a.target = '_blank'; a.rel = 'noopener noreferrer';
    meta.append(el('span', null, '·')); meta.append(a);
  }
  head.append(meta);

  const tools = el('div', 'thread-tools');
  const star = el('button', 'icon-btn', m.starred ? '★ Starred' : '☆ Star');
  star.onclick = async () => { await setMeta([conv.id], { starred: !m.starred }); renderAll(); };
  tools.append(star);

  const fsel = el('select');
  fsel.style.cssText = 'border:1px solid var(--line);background:var(--bg-raise);border-radius:999px;padding:3px 8px;font-size:12px';
  fsel.append(new Option('— no folder —', '__none', false, !m.folderId));
  for (const f of folderList()) fsel.append(new Option(folderPath(f.id), f.id, false, m.folderId === f.id));
  fsel.onchange = () => fileInto([conv.id], fsel.value === '__none' ? null : fsel.value);
  tools.append(fsel);

  for (const t of m.tags) {
    const chip = el('span', 'tagchip', `#${t} ×`);
    chip.title = 'Remove tag';
    chip.onclick = async () => {
      await setMeta([conv.id], (mm) => ({ tags: mm.tags.filter((x) => x !== t) }));
      renderAll();
    };
    tools.append(chip);
  }
  const addTag = el('button', 'icon-btn', '+ tag');
  addTag.onclick = async () => {
    const t = prompt('Add tag');
    if (!t?.trim()) return;
    await setMeta([conv.id], (mm) => ({ tags: [...new Set([...mm.tags, t.trim().replace(/^#/, '')])] }));
    renderAll();
  };
  tools.append(addTag);

  const seg = el('div', 'seg');
  for (const [key, t] of Object.entries(TEMPLATES)) {
    const b = el('button', null, t.label);
    b.setAttribute('aria-pressed', String(S.template === key));
    b.title = t.hint;
    b.onclick = () => { S.template = key; PREFS.save(); renderThread(); };
    seg.append(b);
  }
  tools.append(seg);

  head.append(tools);
  wrap.append(head);

  if (rootCount > 1) {
    wrap.append(el('div', 'banner',
      `This conversation has ${rootCount} separate roots — showing the first. ` +
      `That usually means branching, or messages whose parent was not captured.`));
  }

  S.anchor = new Map();
  const body = el('div', 'thread-body');
  (TEMPLATES[S.template] || TEMPLATES.transcript).render(body, path, kids);
  wrap.append(body);

  const shell = el('div', 'thread-wrap');
  shell.append(wrap, renderRibbon(path));
  main.append(shell);
  main.scrollTop = 0;
  syncRibbon();
}

/* --------------------------------------------------------------- templates */

/** One message, as the transcript draws it. Shared by every template. */
function renderMessage(msg, kids) {
  const box = el('div', `msg ${msg.role}`);
  const who = el('div', 'who');
  who.append(el('span', null, msg.role === 'user' ? 'You' : msg.role));
  if (msg.model) who.append(el('span', 'tagline', msg.model));
  if (msg.status && msg.status !== 'complete') who.append(el('span', 'tagline', msg.status));

  const sibs = kids.get(msg.parentId) || [];
  if (sibs.length > 1) {
    const idx = sibs.findIndex((s) => s.id === msg.id);
    const br = el('div', 'branch');
    br.append(el('span', null, `branch ${idx + 1}/${sibs.length}`));
    const goB = (d) => {
      S.branchPick.set(msg.parentId, sibs[(idx + d + sibs.length) % sibs.length].id);
      renderThread();
    };
    const prev = el('button', null, '‹'); prev.onclick = () => goB(-1);
    const next = el('button', null, '›'); next.onclick = () => goB(1);
    br.append(prev, next);
    who.append(br);
  }
  box.append(who);

  const b = el('div', 'body');
  for (const blk of msg.content) b.append(renderBlock(blk));
  box.append(b);
  return box;
}

const TEMPLATES = {
  transcript: {
    label: 'Transcript',
    hint: 'Every message, top to bottom',
    render(into, path, kids) {
      for (const msg of path) {
        const box = renderMessage(msg, kids);
        S.anchor.set(msg.id, box);
        into.append(box);
      }
    },
  },

  outline: {
    label: 'Outline',
    hint: 'One line per exchange — click to open it',
    render(into, path, kids) {
      const groups = O.turns(path);

      const bar = el('div', 'outline-bar');
      const n = groups.length;
      bar.append(el('span', null, `${n} exchange${n > 1 ? 's' : ''}`));
      const all = el('button', 'icon-btn', 'Expand all');
      all.onclick = () => {
        const open = all.textContent === 'Expand all';
        for (const d of into.querySelectorAll('.oturn')) setOpen(d, open);
        all.textContent = open ? 'Collapse all' : 'Expand all';
      };
      bar.append(all);
      into.append(bar);

      const setOpen = (row, open) => {
        row.classList.toggle('open', open);
        const detail = row.querySelector('.odetail');
        // Built on first open: a 300-message conversation should not render
        // 300 full turns to show you 300 one-line summaries.
        if (open && !detail.dataset.built) {
          detail.dataset.built = '1';
          for (const msg of row._msgs) detail.append(renderMessage(msg, kids));
        }
        detail.hidden = !open;
      };

      for (const [i, t] of groups.entries()) {
        const msgs = [t.user, ...t.replies].filter(Boolean);
        const row = el('div', 'oturn');
        row._msgs = msgs;
        for (const msg of msgs) S.anchor.set(msg.id, row);

        const head = el('button', 'ohead');
        head.append(el('span', 'onum', String(i + 1)));

        const mid = el('span', 'omid');
        const q = t.user ? O.clip(O.plain(O.gist([t.user], 400) || '(no text)'), 160) : '(continues)';
        mid.append(el('span', 'oq', q));
        // A reply the model gave sections to is better summarised by those
        // sections than by its opening sentence.
        const hs = O.headings(t.replies, 4);
        const g = hs.length > 1 ? hs.map((h) => h.text).join('  ·  ') : O.gist(t.replies);
        if (g) mid.append(el('span', `og${hs.length > 1 ? ' sections' : ''}`, g));

        const bits = O.badges(O.stats(t.replies));
        if (bits.length) mid.append(el('span', 'obadges', bits.join(' · ')));
        head.append(mid);
        head.append(el('span', 'ocaret', '▸'));

        const detail = el('div', 'odetail');
        detail.hidden = true;

        head.onclick = () => setOpen(row, !row.classList.contains('open'));
        row.append(head, detail);
        into.append(row);
      }
    },
  },
};

/* ------------------------------------------------------------------ ribbon */

/**
 * A map of the conversation: one bar per message, tall where the message is
 * long. It stays put while the thread scrolls, so a 200-message chat has
 * something you can aim at.
 */
function renderRibbon(path) {
  const strip = el('div', 'ribbon');
  if (path.length < 6) return strip;  // nothing to navigate
  strip.title = 'Map of this conversation — click to jump';

  S.bars = [];
  for (const bar of O.ribbon(path)) {
    const b = el('button', `bar ${bar.role}`);
    b.style.flexGrow = String(bar.weight);
    const marks = [bar.code && 'code', bar.media && 'image', bar.thought && 'thinking', bar.tool && 'tool']
      .filter(Boolean);
    if (marks.length) b.classList.add('marked');
    b.title = `${bar.role === 'user' ? 'You' : bar.role}${marks.length ? ` — ${marks.join(', ')}` : ''}`;
    b.onclick = () => {
      const node = S.anchor.get(bar.id);
      if (!node) return;
      // In Outline the target is a collapsed row; open it, or the jump lands
      // on a line that does not contain what you clicked towards.
      if (node.classList.contains('oturn') && !node.classList.contains('open')) {
        node.querySelector('.ohead').click();
      }
      node.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    S.bars.push({ id: bar.id, node: b });
    strip.append(b);
  }
  return strip;
}

/** Mark the bar for whatever is covering the top of the viewport. */
function syncRibbon() {
  if (!S.bars?.length) return;
  const top = $('#main').getBoundingClientRect().top;
  const tops = S.bars.map((b) => {
    const node = S.anchor.get(b.id);
    return node?.isConnected ? node.getBoundingClientRect().top : Infinity;
  });
  const at = O.activeIndex(tops, top);
  S.bars.forEach((b, i) => b.node.classList.toggle('here', i === at));
}

/* ------------------------------------------------------------------- misc */

function renderFilters() {
  const f = $('#filters');
  f.textContent = '';

  // Only worth showing where it can change the answer.
  if (S.view.kind === 'folder' && folderChildren(S.view.id).length) {
    const b = el('button', 'chip', S.subfolders ? 'with subfolders' : 'this folder only');
    b.setAttribute('aria-pressed', String(S.subfolders));
    b.title = 'Whether this folder also lists conversations filed beneath it';
    b.onclick = () => { S.subfolders = !S.subfolders; PREFS.save(); renderAll(); };
    f.append(b);
  }

  if (S.providers.size < 2) return;
  const mk = (label, val) => {
    const b = el('button', 'chip', label);
    b.setAttribute('aria-pressed', String(S.provider === val));
    b.onclick = () => { S.provider = S.provider === val ? null : val; renderAll(); };
    return b;
  };
  f.append(mk('all', null));
  for (const p of [...S.providers].sort()) f.append(mk(p, p));
}

function openConv(id) {
  S.openId = id;
  S.branchPick.clear();
  document.body.classList.add('reading');
  renderList();
  renderThread();
}

function toast(msg) {
  const t = el('div', 'banner', msg);
  Object.assign(t.style, {
    position: 'fixed', bottom: '18px', left: '50%', transform: 'translateX(-50%)',
    zIndex: 30, boxShadow: '0 4px 20px rgba(0,0,0,.14)',
  });
  document.body.append(t);
  setTimeout(() => t.remove(), 2800);
}

function renderAll() { renderNav(); renderFilters(); renderList(); renderThread(); }

/* ------------------------------------------------------------------- boot */

async function load() {
  const [convs, meta, folders, smart] = await Promise.all(
    STORES.map((s) => STORE.all(s)));
  S.convs = convs.sort((a, b) =>
    String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
  S.meta = new Map(meta.map((m) => [m.convId, { tags: [], ...m }]));
  S.folders = folders;
  S.smart = smart;
  await repairFolders();
  reindex();
  renderAll();
}

/**
 * KaTeX is optional and local-only. If `npm run math` vendored it, use it;
 * otherwise maths falls back to monospace source. These are same-origin files
 * that may simply not exist — the app never reaches the network.
 */
async function loadMath() {
  const add = (tag, attrs) => new Promise((res) => {
    const n = Object.assign(document.createElement(tag), attrs);
    n.onload = () => res(true);
    n.onerror = () => { n.remove(); res(false); };
    document.head.append(n);
  });
  if (!await add('link', { rel: 'stylesheet', href: 'vendor/katex/katex.min.css' })) return false;
  return add('script', { src: 'vendor/katex/katex.min.js' });
}

function wire() {
  $('#q').addEventListener('input', (e) => {
    S.query = e.target.value.trim().toLowerCase();
    renderList();
  });

  $('#file').addEventListener('change', (e) => {
    importFiles([...e.target.files]);
    e.target.value = '';
  });

  const drop = $('#drop');
  document.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    drop.classList.add('hot');
  });
  document.addEventListener('dragleave', (e) => { if (e.target === document) drop.classList.remove('hot'); });
  document.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer?.files || [])].filter((f) => /\.json$/i.test(f.name));
    drop.classList.remove('hot');
    if (!files.length) return;
    e.preventDefault();
    importFiles(files);
  });

  $('#navToggle').onclick = () => document.body.classList.toggle('shownav');

  let queued = false;
  $('#main').addEventListener('scroll', () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; syncRibbon(); });
  }, { passive: true });

  $('#wipe').onclick = async () => {
    if (!S.convs.length) return;
    if (!confirm(`Remove all ${S.convs.length} conversations, folders and tags from this browser?\n\n` +
                 `The originals on Claude and ChatGPT are untouched.`)) return;
    await STORE.clearAll();
    S.openId = null;
    S.meta.clear();
    await load();
  };

  $('#theme').onclick = () => {
    const cur = document.documentElement.getAttribute('data-theme');
    const next = cur === 'dark' ? 'light' : cur === 'light' ? '' : 'dark';
    if (next) document.documentElement.setAttribute('data-theme', next);
    else document.documentElement.removeAttribute('data-theme');
    try { localStorage.setItem('organizer.theme', next); } catch {}
  };

  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== $('#q')) { e.preventDefault(); $('#q').focus(); }
    if (e.key === 'Escape') {
      const m = document.querySelector('.menu');
      if (m) { m.remove(); return; }
      $('#q').blur();
      document.body.classList.remove('reading');
      if (S.sel.size) { S.sel.clear(); renderAll(); }
    }
  });

  try {
    const t = localStorage.getItem('organizer.theme');
    if (t) document.documentElement.setAttribute('data-theme', t);
  } catch {}
}

PREFS.load();
wire();
await loadMath();
await STORE.open();

if (STORE.ephemeral) {
  const b = el('div', 'banner');
  b.style.margin = '10px 12px 0';
  b.innerHTML = location.protocol === 'file:' || location.origin === 'null'
    ? '<b>Nothing will be saved.</b> Browsers block storage for files opened directly. ' +
      'Run <code>npm start</code> and use the localhost address instead — same app, but it remembers.'
    : `<b>Nothing will be saved.</b> Storage is unavailable (${esc(STORE.reason || 'unknown')}).`;
  $('#side').insertBefore(b, $('#list'));
}

await load();
