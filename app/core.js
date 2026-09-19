/* ==========================================================================
   The data layer: storage, state, import, search, and every mutation.

   No DOM in here. UI modules read S, call these functions, then ask R to
   redraw. R is filled in by app.js, which is what lets this file stay free of
   imports from the UI and keeps the dependency graph one-way.

   Imported conversations are never modified. Everything the user does lives in
   `meta`, keyed by conversation id, so re-importing replaces a conversation and
   leaves the organisation of it alone.
   ========================================================================== */

import * as T from '../packages/organize/folders.js';
import * as SEC from '../packages/organize/sections.js';
import * as SUG from '../packages/organize/suggest.js';
import { uid } from './lib/dom.js';
import { unzip, isZip, sha256Bytes } from '../packages/adapters/zip.js';

/** Redraw hooks, assigned by app.js. */
export const R = { all() {}, explorer() {}, reader() {}, inspector() {}, bulk() {} };

/* ------------------------------------------------------------------ store */

export const STORES = ['conversations', 'meta', 'folders', 'smart'];
/* Images and files, by the SHA-256 of their bytes. Kept out of STORES because
   those are all read into memory on load, and these are read one at a time,
   when something on screen needs one. */
const BLOBS = 'blobs';
const EVERY = [...STORES, BLOBS];

export const STORE = {
  db: null,
  ephemeral: false,
  reason: null,
  mem: { conversations: new Map(), meta: new Map(), folders: new Map(), smart: new Map(), blobs: new Map() },

  async open() {
    // Chrome denies IndexedDB to file:// and other opaque origins. Fall back to
    // memory for the session rather than dying, and say so in the UI.
    try {
      this.db = await new Promise((res, rej) => {
        const r = indexedDB.open('organizer', 3);
        r.onupgradeneeded = () => {
          const db = r.result;
          if (!db.objectStoreNames.contains('conversations')) db.createObjectStore('conversations', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'convId' });
          if (!db.objectStoreNames.contains('folders')) db.createObjectStore('folders', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('smart')) db.createObjectStore('smart', { keyPath: 'id' });
          if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS, { keyPath: 'hash' });
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
      const key = store === 'meta' ? 'convId' : store === BLOBS ? 'hash' : 'id';
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

  async get(store, key) {
    if (this.ephemeral) return this.mem[store].get(key) || null;
    return new Promise((res, rej) => {
      const r = this.db.transaction(store, 'readonly').objectStore(store).get(key);
      r.onsuccess = () => res(r.result || null);
      r.onerror = () => rej(r.error);
    });
  },

  async keys(store) {
    if (this.ephemeral) return [...this.mem[store].keys()];
    return new Promise((res, rej) => {
      const r = this.db.transaction(store, 'readonly').objectStore(store).getAllKeys();
      r.onsuccess = () => res(r.result || []);
      r.onerror = () => rej(r.error);
    });
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
    if (this.ephemeral) { for (const s of EVERY) this.mem[s].clear(); return; }
    const tx = this.db.transaction(EVERY, 'readwrite');
    for (const s of EVERY) tx.objectStore(s).clear();
    return new Promise((res) => { tx.oncomplete = res; });
  },
};

/* ------------------------------------------------------------------ state */

export const S = {
  convs: [],
  meta: new Map(),        // convId -> {convId, folderId, tags[], starred, archived, sections[]}
  folders: [],            // {id, name, parentId}
  smart: [],              // {id, name, q}
  index: new Map(),
  providers: new Set(),

  openId: null,
  query: '',
  provider: null,
  view: { kind: 'all', id: null },  // 'all' means the tree; anything else is a flat list
  sel: new Set(),
  lastClicked: null,      // anchor for shift-click ranges
  branchPick: new Map(),
  compare: new Map(),
  suggested: new Map(),   // convId -> suggested section breaks, until kept or dismissed; never stored     // Branches: fork parentId -> version shown against it, or "" for none

  // Inline editing in the tree: which row is showing an input right now.
  editing: null,          // {kind: 'new-folder', parentId} | {kind: 'rename-folder', id} | {kind: 'rename-tag', tag}

  // Per-device view state. Deliberately not in the store: it is about this
  // screen, not the library, and must not travel with an export.
  collapsed: new Set(),
  template: 'transcript',
  showExplorer: true,
  showInspector: true,
  focusAt: 0,             // which exchange the Focus template shows
  outlineFilter: '',
  digestFilter: '',
  galleryKind: '',        // Gallery: '' for everything, or one kind
  openTurns: new Set(),   // exchanges expanded in Outline or Columns — survives a re-render
  colsTransposed: false,  // Columns: sections across (default) or sections stacked
  turnEls: [],            // first element of each exchange, for the inspector
  activeTurn: 0,
  revealPending: false,
  blobKeys: null,         // Set of stored blob hashes, read once   // scroll the tree to the open chat, once
};

/**
 * Open a conversation. Everything about the previous one's view is reset, and
 * its folder is expanded so the tree can show where it lives.
 */
export function openConv(id) {
  S.openId = id;
  S.branchPick.clear();
  S.compare.clear();
  S.focusAt = 0;
  S.activeTurn = 0;
  S.outlineFilter = '';
  S.digestFilter = '';
  S.openTurns = new Set();
  const m = metaOf(id);
  if (m.folderId) revealFolder(m.folderId);
  else S.collapsed.delete('__unsorted');
  S.revealPending = true;
  // On a phone-width screen the tree covers the reader; get it out of the way.
  if (typeof matchMedia === 'function' && matchMedia('(max-width: 700px)').matches) S.showExplorer = false;
  R.all();
}

export const PREFS = {
  load() {
    try {
      const ls = localStorage;
      S.collapsed = new Set(JSON.parse(ls.getItem('organizer.collapsed') || '[]'));
      const t = ls.getItem('organizer.template') || 'transcript';
      S.template = t === 'spine' ? 'focus' : t;  // Spine became Focus
      S.showExplorer = ls.getItem('organizer.explorer') !== '0';
      S.showInspector = ls.getItem('organizer.inspector') !== '0';
      S.colsTransposed = ls.getItem('organizer.colsTransposed') === '1';
    } catch { /* private mode, or storage off — defaults are fine */ }
  },
  save() {
    try {
      const ls = localStorage;
      ls.setItem('organizer.collapsed', JSON.stringify([...S.collapsed]));
      ls.setItem('organizer.template', S.template);
      ls.setItem('organizer.explorer', S.showExplorer ? '1' : '0');
      ls.setItem('organizer.inspector', S.showInspector ? '1' : '0');
      ls.setItem('organizer.colsTransposed', S.colsTransposed ? '1' : '0');
    } catch {}
  },
  theme() { try { return localStorage.getItem('organizer.theme') || ''; } catch { return ''; } },
  setTheme(v) {
    if (v) document.documentElement.setAttribute('data-theme', v);
    else document.documentElement.removeAttribute('data-theme');
    try { localStorage.setItem('organizer.theme', v); } catch {}
  },
};

export const metaOf = (id) =>
  S.meta.get(id) || { convId: id, folderId: null, tags: [], starred: false, archived: false, sections: [], cardMoves: {}, boardCols: [] };

export async function setMeta(ids, patch) {
  const rows = ids.map((id) => {
    const m = { ...metaOf(id), ...(typeof patch === 'function' ? patch(metaOf(id)) : patch) };
    S.meta.set(id, m);
    return m;
  });
  await STORE.put('meta', rows);
}

export const convById = (id) => S.convs.find((c) => c.id === id) || null;

/* ---------------------------------------------------------------- import */

function readPayload(json, filename) {
  const out = [];
  const take = (c) => { if (c && c.kind === 'conversation' && Array.isArray(c.messages)) out.push(c); };
  if (json && json.kind === 'conversation') take(json);
  else if (json && Array.isArray(json.conversations)) json.conversations.forEach(take);
  else if (Array.isArray(json)) json.forEach(take);

  if (!out.length) throw new Error(`${filename}: no conversations in it. Is it a .chat file?`);
  for (const c of out) {
    const v = String(c.schemaVersion || '0');
    if (!/^0\./.test(v)) throw new Error(`${filename}: format ${v} is newer than this reader.`);
  }
  return out;
}

/**
 * Claude's conversation list carries project membership, so an import can
 * build the folder tree from Projects you already made. Only ever seeds a
 * conversation with no meta yet — it must not override filing you did.
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
    const m = { convId: c.id, folderId: f.id, tags: [], starred: !!c.starred, archived: false, sections: [], cardMoves: {}, boardCols: [] };
    S.meta.set(c.id, m);
    newMeta.push(m);
  }
  await STORE.put('folders', newFolders);
  await STORE.put('meta', newMeta);
  return newFolders.length;
}

/** What a file is, from its first bytes — for a blob whose block did not say. */
function sniff(b) {
  const at = (i, ...xs) => xs.every((x, k) => b[i + k] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  if (at(0, 0x25, 0x50, 0x44, 0x46)) return 'application/pdf';
  return 'application/octet-stream';
}

/**
 * A .chatpack.zip: conversations/*.json plus blobs/<sha256>. Every blob is
 * checked against its name before it is kept — a file that does not match
 * its own hash is damaged, and is reported rather than shown.
 */
async function readZip(bytes, filename, errors) {
  const files = await unzip(bytes);
  const convs = [];
  for (const [name, data] of files) {
    if (!/\.json$/i.test(name) || /(^|\/)manifest\.json$/i.test(name) || /(^|\/)overlay\.json$/i.test(name)) continue;
    try { convs.push(...readPayload(JSON.parse(new TextDecoder().decode(data)), `${filename} › ${name}`)); }
    catch (e) { errors.push(e instanceof SyntaxError ? `${filename} › ${name}: not valid JSON.` : e.message); }
  }
  if (!convs.length) throw new Error(`${filename}: no conversations in it. Is it a .chatpack.zip?`);

  const mimeOf = new Map();
  for (const c of convs) for (const m of c.messages) for (const b of m.content || []) {
    if (b.blobHash && b.mime) mimeOf.set(b.blobHash, b.mime);
  }
  const blobs = [];
  let bad = 0;
  for (const [name, data] of files) {
    const hash = (name.match(/^blobs\/([0-9a-f]{64})$/i) || [])[1]?.toLowerCase();
    if (!hash) continue;
    if (await sha256Bytes(data) !== hash) { bad++; continue; }
    const mime = mimeOf.get(hash) || sniff(data);
    blobs.push({ hash, mime, size: data.length, data: new Blob([data], { type: mime }) });
  }
  if (bad) errors.push(`${filename}: ${bad} attached file${bad > 1 ? 's were' : ' was'} damaged and left out.`);
  await STORE.put(BLOBS, blobs);
  return { convs, blobs: blobs.length };
}

/** Returns {added, blobs, folders, errors}; the caller decides how to say so. */
export async function importFiles(files) {
  const added = [];
  const errors = [];
  let blobs = 0;
  for (const f of files) {
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      if (isZip(bytes)) {
        const r = await readZip(bytes, f.name, errors);
        added.push(...r.convs);
        blobs += r.blobs;
      } else {
        added.push(...readPayload(JSON.parse(new TextDecoder().decode(bytes)), f.name));
      }
    } catch (e) { errors.push(e instanceof SyntaxError ? `${f.name}: not valid JSON.` : e.message); }
  }
  let seeded = 0;
  if (added.length) {
    // Keyed by conversation id, so re-importing an overlapping export updates
    // in place rather than duplicating the library.
    await STORE.put('conversations', added);
    S.meta = new Map((await STORE.all('meta')).map((m) => [m.convId, m]));
    seeded = await seedFolders(added);
    await load();
  }
  if (blobs) S.blobKeys = null;
  return { added: added.length, blobs, folders: seeded, errors };
}

/* ------------------------------------------------------------------ blobs */

const blobUrls = new Map(); // hash -> object URL, made once per session

/** An object URL for a stored blob, or null if it was never captured. */
export async function blobUrl(hash) {
  if (!hash) return null;
  if (blobUrls.has(hash)) return blobUrls.get(hash);
  const row = await STORE.get(BLOBS, hash);
  if (!row) return null; // not remembered: a later import may bring it
  const url = URL.createObjectURL(row.data);
  blobUrls.set(hash, url);
  return url;
}

/** Which blobs are here, so a block can say "saved" without loading it. */
export async function blobKeys() {
  S.blobKeys ||= new Set(await STORE.keys(BLOBS));
  return S.blobKeys;
}

/** How much space attachments take, for the details panel. */
export async function blobUsage(hashes) {
  let n = 0, bytes = 0;
  for (const h of new Set(hashes)) {
    const r = await STORE.get(BLOBS, h);
    if (r) { n++; bytes += r.size || r.data?.size || 0; }
  }
  return { n, bytes };
}

/* ------------------------------------------------------------- text index */

export const blockText = (b) => {
  if (!b) return '';
  if (b.type === 'thinking') return [b.text || '', ...(b.summaries || [])].join(' ');
  // A file has both, and you might search for either the name or the contents.
  if (b.type === 'file' || b.type === 'image') return [b.filename, b.text].filter(Boolean).join(' ');
  return b.text || '';
};
export const convText = (c) =>
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

export function inView(c, view = S.view) {
  const m = metaOf(c.id);
  switch (view.kind) {
    case 'starred': return m.starred && !m.archived;
    case 'archived': return m.archived;
    case 'unsorted': case 'untagged': return !m.folderId && !m.archived;
    case 'folder': return !m.archived && !!m.folderId && T.subtree(S.folders, view.id).has(m.folderId);
    case 'tag': return m.tags.includes(view.id) && !m.archived;
    default: return !m.archived;
  }
}

export function matches(c) {
  if (!inView(c)) return false;
  if (S.provider && c.provider !== S.provider) return false;
  if (!S.query) return true;
  const hay = S.index.get(c.id) || '';
  return S.query.split(/\s+/).filter(Boolean).every((t) => hay.includes(t));
}

export const shown = () => S.convs.filter(matches);

/** Is the explorer showing a flat list instead of the tree? */
export const listMode = () => Boolean(S.query) || S.view.kind !== 'all';

export function snippet(c, esc) {
  if (!S.query) return '';
  const terms = S.query.split(/\s+/).filter(Boolean);
  const raw = convText(c);
  const low = raw.toLowerCase();
  let at = -1;
  for (const t of terms) { const i = low.indexOf(t); if (i >= 0 && (at < 0 || i < at)) at = i; }
  if (at < 0) return '';
  const from = Math.max(0, at - 40);
  let frag = raw.slice(from, from + 170).replace(/\s+/g, ' ');
  if (from > 0) frag = `…${frag}`;
  let html = esc(frag);
  for (const t of terms) {
    html = html.replace(new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<mark>$1</mark>');
  }
  return html;
}

export function counts() {
  const c = { all: 0, starred: 0, archived: 0, unsorted: 0, folder: new Map(), tag: new Map() };
  for (const conv of S.convs) {
    const m = metaOf(conv.id);
    if (m.archived) { c.archived++; continue; }
    c.all++;
    if (m.starred) c.starred++;
    if (!m.folderId) c.unsorted++;
    if (m.folderId) c.folder.set(m.folderId, (c.folder.get(m.folderId) || 0) + 1);
    for (const t of m.tags) c.tag.set(t, (c.tag.get(t) || 0) + 1);
  }
  // A folder whose conversations all sit in its subfolders would otherwise read
  // as empty, which is simply untrue.
  c.folderAll = T.rollUp(S.folders, c.folder);
  return c;
}

/* ------------------------------------------------------------ thread path */

export function mainPath(conv) {
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

/* ---------------------------------------------------------------- folders */

export const folderById = (id) => T.byId(S.folders, id);
export const folderChildren = (pid) => T.childrenOf(S.folders, pid);
export const folderPath = (id) => T.pathOf(S.folders, id);
export const folderList = () => T.flatten(S.folders);
export const canMove = (id, toId) => T.canMove(S.folders, id, toId);

/** Conversations filed directly in a folder (null = unsorted), newest first. */
export const chatsIn = (folderId) =>
  S.convs.filter((c) => { const m = metaOf(c.id); return !m.archived && (m.folderId || null) === folderId; });

export function toggleFolder(id) {
  if (S.collapsed.has(id)) S.collapsed.delete(id); else S.collapsed.add(id);
  PREFS.save();
}

/** Open every ancestor, so revealing a conversation can never land on nothing. */
export function revealFolder(id) {
  for (let f = folderById(id), i = 0; f && i < 64; f = folderById(f.parentId), i++) S.collapsed.delete(f.id);
  PREFS.save();
}

export async function createFolder(name, parentId = null) {
  const f = { id: uid(), name, parentId };
  S.folders.push(f);
  if (parentId) { S.collapsed.delete(parentId); PREFS.save(); }
  await STORE.put('folders', [f]);
  return f;
}

export async function renameFolder(id, name) {
  const f = folderById(id);
  if (!f) return;
  f.name = name;
  await STORE.put('folders', [f]);
}

export async function moveFolder(id, toId) {
  const f = folderById(id);
  if (!f || !canMove(id, toId) || f.parentId === (toId || null)) return false;
  f.parentId = toId || null;
  if (toId) { S.collapsed.delete(toId); PREFS.save(); }
  await STORE.put('folders', [f]);
  return true;
}

/** What deleting a folder would do, for the confirmation to state plainly. */
export function folderDeleteImpact(id) {
  const f = folderById(id);
  return {
    folder: f,
    kids: folderChildren(id),
    chats: S.convs.filter((x) => metaOf(x.id).folderId === id).map((x) => x.id),
    up: f?.parentId ? folderPath(f.parentId) : null,
  };
}

/**
 * Children are lifted to the grandparent rather than dropped. Deleting a
 * folder should lose one folder, not a branch.
 */
export async function deleteFolder(id) {
  const { chats } = folderDeleteImpact(id);
  const lifted = T.reparentOnDelete(S.folders, id);
  for (const k of lifted) Object.assign(folderById(k.id), k);
  await STORE.put('folders', lifted);
  if (chats.length) await setMeta(chats, { folderId: null });
  S.folders = S.folders.filter((x) => x.id !== id);
  await STORE.del('folders', [id]);
  if (S.view.kind === 'folder' && S.view.id === id) S.view = { kind: 'all', id: null };
}

/**
 * A parentId pointing at a folder that no longer exists makes its branch
 * unreachable: nothing walks to it, so it vanishes from the tree while staying
 * in the store. Re-root those rather than leave them invisible.
 */
async function repairFolders() {
  const lost = T.orphans(S.folders);
  for (const f of lost) f.parentId = null;
  if (lost.length) await STORE.put('folders', lost);
}

/* ------------------------------------------------------ conversations */

export const fileInto = (ids, folderId) => setMeta(ids, { folderId: folderId || null });
export const setStarred = (ids, starred) => setMeta(ids, { starred });
export const setArchived = (ids, archived) => setMeta(ids, { archived });
export const addTag = (ids, tag) =>
  setMeta(ids, (m) => ({ tags: [...new Set([...m.tags, tag.replace(/^#/, '').trim()])] }));
export const removeTag = (ids, tag) => setMeta(ids, (m) => ({ tags: m.tags.filter((t) => t !== tag) }));

export async function removeConvs(ids) {
  await STORE.del('conversations', ids);
  await STORE.del('meta', ids);
  for (const i of ids) { S.meta.delete(i); S.sel.delete(i); }
  if (ids.includes(S.openId)) S.openId = null;
  await load();
}

export async function clearLibrary() {
  await STORE.clearAll();
  S.openId = null;
  S.meta.clear();
  S.sel.clear();
  await load();
}

/* ------------------------------------------------------------------- tags */

export const allTags = () => [...counts().tag.keys()].sort((a, b) => a.localeCompare(b));

/** Renaming onto an existing tag merges the two, which is what you would want. */
export async function renameTag(from, to) {
  const ids = S.convs.filter((c) => metaOf(c.id).tags.includes(from)).map((c) => c.id);
  await setMeta(ids, (m) => ({ tags: [...new Set(m.tags.map((t) => (t === from ? to : t)))] }));
  if (S.view.kind === 'tag' && S.view.id === from) S.view = { kind: 'tag', id: to };
}

export async function deleteTag(tag) {
  const ids = S.convs.filter((c) => metaOf(c.id).tags.includes(tag)).map((c) => c.id);
  await removeTag(ids, tag);
  if (S.view.kind === 'tag' && S.view.id === tag) S.view = { kind: 'all', id: null };
  return ids;
}

/* --------------------------------------------------------- saved searches */

export async function saveSearch(name) {
  const s = { id: uid(), name, q: { text: S.query, provider: S.provider, view: { ...S.view } } };
  S.smart.push(s);
  await STORE.put('smart', [s]);
  return s;
}

export async function deleteSearch(id) {
  const gone = S.smart.find((x) => x.id === id);
  S.smart = S.smart.filter((x) => x.id !== id);
  await STORE.del('smart', [id]);
  return gone;
}

export async function restoreSearch(s) {
  S.smart.push(s);
  await STORE.put('smart', [s]);
}

/* --------------------------------------------------------------- sections */

export const sectionsOf = (convId) => metaOf(convId).sections || [];
export const setSection = (convId, key, title) =>
  setMeta([convId], (m) => ({ sections: SEC.setBreak(m.sections || [], key, title) }));

/** Drop the moves cardMoves owed to a now-gone section, so they never orphan. */
const purgeMoves = (moves, deadKeys) =>
  Object.fromEntries(Object.entries(moves || {}).filter(([, v]) => !deadKeys.has(v)));

export const clearSection = (convId, key) =>
  setMeta([convId], (m) => ({
    sections: SEC.clearBreak(m.sections || [], key),
    cardMoves: purgeMoves(m.cardMoves, new Set([key])),
  }));
/* A suggestion is a guess on screen, not a change: nothing about it is
   stored until you keep it. Keeping one makes it an ordinary section. */
export const suggestionsOf = (convId) => S.suggested.get(convId) || [];
/** What the views show: your sections, plus any suggestions not yet answered. */
export function shownSections(convId) {
  const mine = sectionsOf(convId);
  const taken = new Set(mine.map((x) => x.startStableKey));
  return [...mine, ...suggestionsOf(convId).filter((x) => !taken.has(x.startStableKey))];
}
export function runSuggest(convId, turns) {
  const found = SUG.suggest(turns, sectionsOf(convId));
  if (found.length) S.suggested.set(convId, found); else S.suggested.delete(convId);
  return found.length;
}
export async function dismissSuggestion(convId, key) {
  const rest = suggestionsOf(convId).filter((x) => x.startStableKey !== key);
  if (rest.length) S.suggested.set(convId, rest); else S.suggested.delete(convId);
  // A card dragged onto a suggested column goes back when the column does.
  if (Object.values(cardMovesOf(convId)).includes(key)) {
    await setMeta([convId], (m) => ({ cardMoves: purgeMoves(m.cardMoves, new Set([key])) }));
  }
}
/** Keep some or all suggestions. Returns the keys kept, for Undo. */
export async function keepSuggestions(convId, keys = null) {
  const all = suggestionsOf(convId);
  const keep = keys ? all.filter((x) => keys.includes(x.startStableKey)) : all;
  await setMeta([convId], (m) => ({
    sections: keep.reduce((acc, x) => SEC.setBreak(acc, x.startStableKey, x.title), m.sections || []),
  }));
  const rest = all.filter((x) => !keep.includes(x));
  if (rest.length) S.suggested.set(convId, rest); else S.suggested.delete(convId);
  return keep;
}
export async function unkeepSuggestions(convId, kept) {
  await setMeta([convId], (m) => ({ sections: (m.sections || []).filter((x) => !kept.some((k) => k.startStableKey === x.startStableKey)) }));
  S.suggested.set(convId, [...suggestionsOf(convId), ...kept]);
}

export const dropSections = (convId, keys) =>
  setMeta([convId], (m) => ({
    sections: (m.sections || []).filter((s) => !keys.has(s.startStableKey)),
    cardMoves: purgeMoves(m.cardMoves, keys),
  }));

/* ------------------------------------------------------------------ cards */

/**
 * Which section a card is filed under on the Columns board, when that differs
 * from where `group()` would naturally put it. Read only by Columns — see
 * packages/organize/sections.js `applyMoves` for why every other view ignores
 * this.
 */
export const cardMovesOf = (convId) => metaOf(convId).cardMoves || {};
export const moveCard = (convId, turnKey, targetSectionKey) =>
  setMeta([convId], (m) => ({ cardMoves: { ...(m.cardMoves || {}), [turnKey]: targetSectionKey } }));
export const resetCard = (convId, turnKey) =>
  setMeta([convId], (m) => {
    const c = { ...(m.cardMoves || {}) };
    delete c[turnKey];
    return { cardMoves: c };
  });

/**
 * Columns made on the board itself, not by a section break — so a chat with
 * no sections can still be arranged. Board-only, like card moves.
 */
export const boardColsOf = (convId) => metaOf(convId).boardCols || [];
export async function addBoardCol(convId, title, moveKey = null) {
  const id = `col-${uid()}`;
  await setMeta([convId], (m) => ({
    boardCols: [...(m.boardCols || []), { id, title }],
    cardMoves: moveKey ? { ...(m.cardMoves || {}), [moveKey]: id } : (m.cardMoves || {}),
  }));
  return id;
}
export const renameBoardCol = (convId, id, title) =>
  setMeta([convId], (m) => ({ boardCols: (m.boardCols || []).map((c) => (c.id === id ? { ...c, title } : c)) }));
/** Remove a board column; its cards go back to their own sections. Returns
    what it removed, so the caller can offer Undo. */
export async function dropBoardCol(convId, id) {
  const m = metaOf(convId);
  const before = { boardCols: m.boardCols || [], cardMoves: m.cardMoves || {} };
  await setMeta([convId], {
    boardCols: before.boardCols.filter((c) => c.id !== id),
    cardMoves: purgeMoves(before.cardMoves, new Set([id])),
  });
  return () => setMeta([convId], before);
}

/* ------------------------------------------------------------------- load */

export async function load() {
  const [convs, meta, folders, smart] = await Promise.all(STORES.map((s) => STORE.all(s)));
  S.convs = convs.sort((a, b) =>
    String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
  S.meta = new Map(meta.map((m) => [m.convId, { tags: [], sections: [], cardMoves: {}, boardCols: [], ...m }]));
  S.folders = folders;
  S.smart = smart;
  await repairFolders();
  reindex();
  if (S.openId && !convById(S.openId)) S.openId = null;
}
