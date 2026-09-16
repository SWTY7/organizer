/**
 * The capture UI.
 *
 * Runs as an ordinary extension page so it inherits host permissions and is not
 * subject to the service worker's idle timeout. Provider logic is untouched —
 * it imports the same adapters the console tools use.
 */

import { ADAPTERS } from './adapters/index.js';
import { SCHEMA_VERSION, sleep, RATE_MS } from './adapters/shared.js';

const $ = (s) => document.querySelector(s);
const el = (t, cls, txt) => {
  const n = document.createElement(t);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};

/** provider id -> { adapter, items, loaded, error } */
const P = new Map(ADAPTERS.map((a) => [a.id, {
  adapter: a, items: [], loaded: false, loading: false, error: null,
}]));
const selected = new Set();       // `${providerId}:${conversationId}`
let filterText = '';
let onlyNew = false;
let onlyStar = false;
let groupBy = 'none';
let exporting = false;

/* Loading is tracked per provider, not globally: the two are independent
   requests and a shared flag meant clicking the second button while the first
   was still going silently did nothing. */
const anyLoading = () => [...P.values()].some((s) => s.loading);

/* ------------------------------------------------------------ capture log */
/* What was captured before, so "new & updated" means something. Keyed by
   provider; stores each conversation's updatedAt at the time it was captured. */

const LOG_KEY = 'captureLog';
let log = {};

/* Falls back to a no-op when opened outside an extension, so the page renders
   instead of dying on an undefined API. */
const storage = globalThis.chrome?.storage?.local ?? {
  get: async () => ({}),
  set: async () => {},
};

async function loadLog() {
  const got = await storage.get(LOG_KEY);
  log = got[LOG_KEY] || {};
}
async function saveLog() {
  await storage.set({ [LOG_KEY]: log });
}

/** 'new' (never captured) | 'updated' (changed since) | null (unchanged) */
function changeState(providerId, item) {
  const prev = log[providerId]?.[item.id];
  if (!prev) return 'new';
  const now = new Date(typeof item.updatedAt === 'number' ? item.updatedAt * 1000 : item.updatedAt);
  return isNaN(now) || String(prev) === String(now.toISOString()) ? null : 'updated';
}

/* ------------------------------------------------------------------- cards */

function renderCards() {
  const wrap = $('#cards');
  wrap.textContent = '';
  for (const [id, st] of P) {
    const card = el('div', 'card');
    const h = el('h2');
    h.append(el('span', `dot ${id}`), el('span', null, st.adapter.label));
    card.append(h);

    const status = el('div', 'status');
    if (st.loading) { status.textContent = 'loading…'; }
    else if (st.error) { status.className = 'status bad'; status.textContent = st.error; }
    else if (st.loaded) {
      status.className = 'status ok';
      const n = st.items.filter((i) => changeState(id, i)).length;
      status.textContent = `${st.items.length} conversations` + (n ? ` · ${n} new or updated` : ' · all captured');
    } else {
      status.textContent = log[id]
        ? `last captured ${Object.keys(log[id]).length} conversations`
        : 'not loaded';
    }
    card.append(status);

    const actions = el('div', 'actions');
    const btn = el('button', 'btn', st.loading ? 'Loading…' : st.loaded ? 'Reload' : 'Load conversations');
    btn.disabled = st.loading || exporting;
    btn.onclick = () => loadProvider(id);
    actions.append(btn);
    card.append(actions);
    wrap.append(card);
  }
}

async function loadProvider(id) {
  const st = P.get(id);
  st.error = null;
  st.loaded = false;
  st.loading = true;
  renderCards();
  try {
    await st.adapter.init();
    st.items = await st.adapter.list();
    st.loaded = true;
  } catch (e) {
    // Three things actually go wrong here. Name which one, rather than
    // surfacing a bare status code or "Failed to fetch".
    const m = e.message || '';
    if (/HTML instead of JSON|401|403|accessToken|no organizations/i.test(m)) {
      st.error = `Not signed in to ${st.adapter.label}, or the session expired. ` +
                 `Open ${st.adapter.origin}, sign in, then reload here.`;
    } else if (/failed to fetch|networkerror|load failed/i.test(m)) {
      st.error = `Could not reach ${st.adapter.label}. Either you are offline, or the ` +
                 `extension is missing permission for ${st.adapter.origin} — check it at ` +
                 `chrome://extensions.`;
    } else {
      st.error = `${st.adapter.label} responded unexpectedly: ${m}. ` +
                 `The endpoint may have changed; the console tools still work.`;
    }
  } finally {
    st.loading = false;
    renderCards();
    renderList();
  }
}

/* -------------------------------------------------------------------- list */

const dateOf = (item) => {
  const d = new Date(typeof item.updatedAt === 'number' ? item.updatedAt * 1000 : item.updatedAt);
  return isNaN(d) ? null : d;
};
const fmt = (d) => (d ? d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');

function visibleRows() {
  const rows = [];
  for (const [id, st] of P) {
    if (!st.loaded) continue;
    for (const item of st.items) {
      const state = changeState(id, item);
      if (onlyNew && !state) continue;
      if (onlyStar && !item.facets?.starred) continue;
      if (filterText && !(item.title || '').toLowerCase().includes(filterText)) continue;
      rows.push({ providerId: id, item, state, key: `${id}:${item.id}` });
    }
  }
  rows.sort((a, b) => (dateOf(b.item) || 0) - (dateOf(a.item) || 0));
  return rows;
}

/**
 * Group on facets the provider's list already carries, so nothing here costs a
 * detail fetch. What is available differs by provider — ChatGPT's list has no
 * model at all — so a missing facet lands in an explicit "no model" bucket
 * rather than silently vanishing.
 */
const GROUPERS = {
  none: null,
  provider: (r) => P.get(r.providerId).adapter.label,
  project: (r) => r.item.facets?.project || 'No project',
  model: (r) => r.item.facets?.model || 'No model on this provider’s list',
  month: (r) => {
    const d = dateOf(r.item);
    return d ? d.toLocaleDateString(undefined, { year: 'numeric', month: 'long' }) : 'No date';
  },
};

/** @returns {{name: string, rows: object[]}[]} one entry when grouping is off */
function grouped(rows) {
  const fn = GROUPERS[groupBy];
  if (!fn) return [{ name: null, rows }];
  const map = new Map();
  for (const r of rows) {
    const k = fn(r);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  // Biggest groups first, but always park the "missing" buckets at the end.
  const isNone = (n) => /^No /.test(n);
  return [...map.entries()]
    .map(([name, rs]) => ({ name, rows: rs }))
    .sort((a, b) => (isNone(a.name) - isNone(b.name)) || b.rows.length - a.rows.length);
}

function renderList() {
  const list = $('#list');
  list.textContent = '';
  const rows = visibleRows();
  const anyLoaded = [...P.values()].some((s) => s.loaded);

  $('#empty').hidden = rows.length > 0;
  $('#empty').textContent = anyLoaded
    ? 'Nothing matches those filters.'
    : 'Load a provider above to choose conversations.';
  $('#bar').hidden = !anyLoaded;
  $('#shown').textContent = anyLoaded ? `${rows.length} shown` : '';

  for (const g of grouped(rows)) {
    if (g.name) {
      const head = el('li', 'group');
      head.append(el('span', 'gname', g.name));
      head.append(el('span', 'gcount', `${g.rows.length}`));
      const allIn = g.rows.every((r) => selected.has(r.key));
      const b = el('button', 'linkbtn', allIn ? 'deselect group' : 'select group');
      b.onclick = () => {
        for (const r of g.rows) {
          if (allIn) selected.delete(r.key); else selected.add(r.key);
        }
        renderList();
      };
      head.append(b);
      list.append(head);
    }
    for (const r of g.rows) renderRow(list, r);
  }
  renderCount();
}

function renderRow(list, r) {
  {
    const li = el('li');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = selected.has(r.key);
    cb.onchange = () => {
      if (cb.checked) selected.add(r.key); else selected.delete(r.key);
      renderCount();
    };
    li.append(cb);

    const ti = el('div', 'ti');
    ti.append(el('div', 't', r.item.title || '(untitled)'));
    const m = el('div', 'm');
    m.append(el('span', `dot ${r.providerId}`));
    m.append(el('span', null, P.get(r.providerId).adapter.label));
    m.append(el('span', null, '·'));
    m.append(el('span', null, fmt(dateOf(r.item))));
    const f = r.item.facets || {};
    if (f.starred) m.append(el('span', null, '★'));
    if (f.project) { m.append(el('span', null, '·')); m.append(el('span', null, f.project)); }
    if (f.model) { m.append(el('span', null, '·')); m.append(el('span', null, f.model)); }
    if (f.archived) m.append(el('span', 'pill', 'archived'));
    if (r.state === 'new') m.append(el('span', 'pill new', 'new'));
    if (r.state === 'updated') m.append(el('span', 'pill upd', 'updated'));
    ti.append(m);

    // Clicking the row toggles it — a 15px checkbox is a small target.
    ti.onclick = () => { cb.checked = !cb.checked; cb.onchange(); };
    li.append(ti);
    list.append(li);
  }
}

function renderCount() {
  const n = selected.size;
  $('#selCount').textContent = n
    ? `${n} selected · about ${Math.max(1, Math.round((n * RATE_MS) / 1000))}s`
    : 'Nothing selected';
  $('#export').disabled = !n || exporting || anyLoading();
}

/* ------------------------------------------------------------------ export */

async function runExport() {
  const rows = [];
  for (const [id, st] of P) {
    for (const item of st.items) {
      if (selected.has(`${id}:${item.id}`)) rows.push({ providerId: id, item });
    }
  }
  if (!rows.length) return;

  exporting = true;
  const prog = $('#prog');
  prog.hidden = false;
  prog.max = rows.length;
  prog.value = 0;
  renderCards();
  renderCount();

  const conversations = [];
  const failures = [];
  for (let i = 0; i < rows.length; i++) {
    const { providerId, item } = rows[i];
    const adapter = P.get(providerId).adapter;
    try {
      const conv = await adapter.convert(await adapter.detail(item.id), item);
      conversations.push(conv);
      // Record what was captured so "new & updated" is meaningful next time.
      (log[providerId] ||= {})[item.id] = conv.updatedAt;
    } catch (e) {
      failures.push({ title: item.title, error: e.message });
    }
    prog.value = i + 1;
    $('#selCount').textContent = `${i + 1} of ${rows.length}…`;
    if (i < rows.length - 1) await sleep(RATE_MS);
  }

  const providers = [...new Set(conversations.map((c) => c.provider))];
  const pack = {
    manifest: {
      schemaVersion: SCHEMA_VERSION,
      kind: 'chatpack',
      generator: { name: 'organizer-extension', version: '0.2.0' },
      capturedAt: new Date().toISOString(),
      conversationCount: conversations.length,
      providers,
      hasOverlay: false,
    },
    conversations,
  };

  const name = `${providers.join('-') || 'chats'}-${conversations.length}-${Date.now()}.chatpack.json`;
  const url = URL.createObjectURL(new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);

  await saveLog();
  selected.clear();
  exporting = false;
  prog.hidden = true;
  renderCards();
  renderList();

  $('#selCount').textContent = failures.length
    ? `Saved ${conversations.length}; ${failures.length} failed`
    : `Saved ${conversations.length} to ${name}`;
  if (failures.length) console.table(failures);
}

/* -------------------------------------------------------------------- wire */

$('#filter').addEventListener('input', (e) => {
  filterText = e.target.value.trim().toLowerCase();
  renderList();
});
$('#onlyNew').addEventListener('change', (e) => { onlyNew = e.target.checked; renderList(); });
$('#onlyStar').addEventListener('change', (e) => { onlyStar = e.target.checked; renderList(); });
$('#groupBy').addEventListener('change', (e) => { groupBy = e.target.value; renderList(); });
$('#selAll').onclick = () => { for (const r of visibleRows()) selected.add(r.key); renderList(); };
$('#selNone').onclick = () => { selected.clear(); renderList(); };
$('#selInvert').onclick = () => {
  for (const r of visibleRows()) {
    if (selected.has(r.key)) selected.delete(r.key); else selected.add(r.key);
  }
  renderList();
};
$('#export').onclick = runExport;

await loadLog();
renderCards();
renderList();
