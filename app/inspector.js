/* ==========================================================================
   The inspector: the open conversation's outline, and its details.

   One navigator for every template. Each exchange is a row with a bar for how
   long it is — what the ribbon used to show — and the one you are reading is
   highlighted as you scroll. In Focus it is the list you pick from.
   ========================================================================== */

import * as O from '../packages/organize/outline.js';
import * as SEC from '../packages/organize/sections.js';
import * as BR from '../packages/organize/branches.js';
import { S, R, metaOf, convById, mainPath, folderPath, sectionsOf, revealFolder } from './core.js';
import { $, $$, el, icon, iconBtn, fmtDate } from './lib/dom.js';
import { newSection, renameSection, removeSection, turnText } from './reader.js';
import { provName } from './explorer.js';
import { plural } from './actions.js';

/** How much there is in an exchange, on the same square-root scale the
    ribbon used: longer reads longer, but one essay cannot flatten the rest. */
const weight = (t) => {
  const s = O.stats([t.user, ...t.replies].filter(Boolean));
  return Math.sqrt(s.words + s.code * 40 + s.tool * 20 + s.image * 30);
};

export function renderInspector() {
  const host = $('#inspector');
  const conv = convById(S.openId);
  const same = host.dataset.conv === (conv?.id || '');
  const keep = same ? ($('.in-list', host)?.scrollTop || 0) : 0;
  host.textContent = '';
  host.dataset.conv = conv?.id || '';

  const head = el('div', 'in-head');
  head.append(el('span', 'in-title', 'Outline'));
  host.append(head);

  if (!conv) {
    host.append(el('div', 'in-empty', 'Open a chat to see its outline here.'));
    return;
  }

  const { path, kids } = mainPath(conv);
  const turns = O.turns(path);
  // Exchanges with another version somewhere in them get a mark, so forks can
  // be found from any view, not just Branches.
  const forked = new Set(BR.forks(path, kids).map((f) => path[f.at].id));
  const hasFork = turns.map((t) => [t.user, ...t.replies].some((m) => m && forked.has(m.id)));
  const groups = SEC.group(turns, sectionsOf(conv.id));
  head.append(el('span', 'n', String(turns.length)));

  const filter = el('input', 'in-filter');
  filter.type = 'search';
  filter.placeholder = `Filter ${plural(turns.length, 'exchange')}`;
  filter.value = S.outlineFilter;
  host.append(filter);

  const list = el('div', 'in-list');
  const max = Math.max(1, ...turns.map(weight));
  const rows = [];
  const heads = [];
  let i = 0;
  for (const sec of groups) {
    let h = null;
    if (groups.length > 1) {
      h = el('div', 'isec');
      h.append(icon('bookmark'), el('span', 'st', sec.title || 'Beginning'));
      if (sec.startKey) {
        h.append(
          iconBtn('pencil', 'Rename section', () => renameSection(conv.id, sec.startKey, sec.title), 'hover'),
          iconBtn('x', 'Remove this section break', () => removeSection(conv.id, sec.startKey), 'hover'),
        );
      }
      list.append(h);
    }
    const from = i;
    for (const t of sec.turns) {
      const n = i++;
      const key = SEC.turnKey(t);
      const row = el('div', 'irow');
      row.dataset.turn = n;
      row.tabIndex = 0;
      if (n === S.activeTurn) row.classList.add('on');
      const q = t.user ? O.clip(O.plain(O.gist([t.user], 300) || '(no text)'), 110) : '(continues)';
      const txt = el('span', 'iq', q);
      const bar = el('span', 'ibar');
      bar.style.setProperty('--w', `${Math.round((weight(t) / max) * 100)}%`);
      const num = el('span', 'inum', String(n + 1));
      if (hasFork[n]) { num.append(icon('branch')); num.title = 'Has other versions — see Branches'; }
      row.append(num, txt);
      if (sec.startKey !== key && key) {
        row.append(iconBtn('bookmark', 'Start a section here', () => newSection(conv.id, key), 'hover'));
      }
      row.append(bar);
      row.onclick = () => R.goTurn(n);
      row.onkeydown = (e) => { if (e.key === 'Enter') R.goTurn(n); };
      row._hay = turnText(t);
      rows.push(row);
      list.append(row);
    }
    if (h) heads.push({ h, from, to: i });
  }
  host.append(list);

  // Filtering hides rows rather than re-rendering, so typing keeps its caret.
  const apply = () => {
    const q = S.outlineFilter.trim().toLowerCase();
    rows.forEach((r) => { r.hidden = Boolean(q) && !r._hay.includes(q); });
    // A section heading with nothing left under it is a lie about the filter.
    for (const { h, from, to } of heads) h.hidden = rows.slice(from, to).every((r) => r.hidden);
  };
  filter.oninput = () => { S.outlineFilter = filter.value; apply(); };
  apply();
  list.scrollTop = keep;

  host.append(detailsBlock(conv, path));
}

function detailsBlock(conv, path) {
  const m = metaOf(conv.id);
  const d = el('div', 'in-details');
  d.append(el('div', 'in-title', 'Details'));
  const row = (label, value) => {
    const r = el('div', 'drow');
    r.append(el('span', 'dl', label));
    const v = el('span', 'dv');
    if (value instanceof Node) v.append(value); else v.textContent = value;
    r.append(v);
    d.append(r);
    return v;
  };

  const loc = el('button', 'link', m.folderId ? folderPath(m.folderId) : 'Unsorted');
  loc.type = 'button';
  loc.title = 'Show in the sidebar';
  loc.onclick = () => {
    if (m.folderId) revealFolder(m.folderId); else S.collapsed.delete('__unsorted');
    S.showExplorer = true;
    S.view = { kind: 'all', id: null };
    S.revealPending = true;
    R.all();
  };
  row('Folder', loc);
  if (m.tags.length) row('Tags', m.tags.map((t) => `#${t}`).join('  '));
  row('From', `${provName(conv.provider)}${conv.model ? ` · ${conv.model}` : ''}`);
  row('Started', fmtDate(conv.createdAt));
  if (conv.updatedAt && conv.updatedAt !== conv.createdAt) row('Updated', fmtDate(conv.updatedAt));
  row('Messages', path.length === conv.messages.length
    ? String(conv.messages.length)
    : `${path.length} on this branch, ${conv.messages.length} in all`);

  let files = 0, images = 0;
  for (const msg of conv.messages) for (const b of msg.content) {
    if (b.type === 'file') files++;
    if (b.type === 'image') images++;
  }
  if (files || images) row('Attached', [files && plural(files, 'file'), images && plural(images, 'image')].filter(Boolean).join(', '));
  return d;
}

/** Highlight the exchange being read, and keep it in view in the list. */
export function markActive(i) {
  const list = $('.in-list');
  if (!list) return;
  let on = null;
  for (const r of $$('.irow', list)) {
    const hit = Number(r.dataset.turn) === i;
    r.classList.toggle('on', hit);
    if (hit) on = r;
  }
  if (!on) return;
  const a = on.getBoundingClientRect(), b = list.getBoundingClientRect();
  if (a.top < b.top || a.bottom > b.bottom) on.scrollIntoView({ block: 'nearest' });
}
