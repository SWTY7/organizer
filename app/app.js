/* ==========================================================================
   organizer — boot and wiring.

   No framework, no dependencies, no network calls. The pieces:

     core.js        storage, state, import, search, every mutation
     explorer.js    the tree, the result list, the bulk bar
     reader.js      one conversation, in three templates
     inspector.js   that conversation's outline and details
     actions.js     what you can do to a chat, from anywhere
     lib/           DOM helpers, dialogs and menus, markdown, icons

   Layout and interaction rules are in DESIGN.md.
   ========================================================================== */

import { S, R, PREFS, STORE, load, importFiles } from './core.js';
import { initExplorer, renderExplorer, renderBulk } from './explorer.js';
import { renderReader, goTurn } from './reader.js';
import { renderInspector, markActive } from './inspector.js';
import { $, el, toast, dialog, closeFloat, floatOpen } from './lib/dom.js';
import { plural } from './actions.js';

function layout() {
  document.body.classList.toggle('hide-ex', !S.showExplorer);
  document.body.classList.toggle('hide-in', !S.showInspector);
}

Object.assign(R, {
  all() { layout(); renderExplorer(); renderReader(); renderInspector(); renderBulk(); },
  explorer: renderExplorer,
  reader: renderReader,
  inspector: renderInspector,
  bulk: renderBulk,
  goTurn,
  markActive,
});

/* --------------------------------------------------------------- import */

async function doImport(files) {
  const json = [...files].filter((f) => /\.json$/i.test(f.name));
  if (!json.length) { toast('Only .chat.json and .chatpack.json files can be imported'); return; }
  const r = await importFiles(json);
  R.all();
  if (r.added) {
    toast(`Imported ${plural(r.added, 'chat')}` +
      (r.folders ? ` · ${plural(r.folders, 'folder')} from Claude projects` : ''));
  }
  if (r.errors.length) {
    await dialog({ title: r.added ? 'Some files were skipped' : 'Nothing was imported', body: r.errors, ok: 'OK', cancel: null });
  }
}

/**
 * KaTeX is optional and local. If `npm run math` vendored it, use it;
 * otherwise maths shows as source. These are same-origin files that may simply
 * not exist — the app never reaches the network.
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

/* ---------------------------------------------------------------- wiring */

function wire() {
  $('#file').addEventListener('change', (e) => { doImport(e.target.files); e.target.value = ''; });

  // Dropping files anywhere imports them. Internal drags — chats onto folders —
  // carry no Files, so they never raise the veil.
  const veil = $('#veil');
  const hasFiles = (e) => e.dataTransfer?.types?.includes('Files');
  document.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    veil.hidden = false;
  });
  document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) veil.hidden = true; });
  document.addEventListener('drop', (e) => {
    veil.hidden = true;
    if (!hasFiles(e)) return;
    e.preventDefault();
    doImport(e.dataTransfer.files);
  });

  document.addEventListener('keydown', (e) => {
    if (document.querySelector('dialog[open]')) return; // it handles its own keys
    const a = document.activeElement;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(a?.tagName || '') || a?.isContentEditable;

    if (e.key === 'Escape') {
      if (floatOpen()) { closeFloat(); return; }
      if (S.sel.size) { S.sel.clear(); R.explorer(); R.bulk(); return; }
      if (typing) a.blur();
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;

    if (e.key === '/') {
      e.preventDefault();
      if (!S.showExplorer) { S.showExplorer = true; PREFS.save(); R.all(); }
      $('#q').focus();
    } else if ((e.key === 'j' || e.key === 'k') && S.openId) {
      e.preventDefault();
      const cur = S.template === 'focus' ? S.focusAt : S.activeTurn;
      goTurn(cur + (e.key === 'j' ? 1 : -1));
    } else if (e.key === '[') {
      S.showExplorer = !S.showExplorer; PREFS.save(); R.all();
    } else if (e.key === ']') {
      S.showInspector = !S.showInspector; PREFS.save(); R.all();
    }
  });
}

/* ------------------------------------------------------------------ boot */

PREFS.load();
PREFS.setTheme(PREFS.theme());
initExplorer({ onImport: () => $('#file').click() });
wire();
await loadMath();
await STORE.open();

if (STORE.ephemeral) {
  const n = el('div', 'notice');
  n.innerHTML = location.protocol === 'file:' || location.origin === 'null'
    ? '<b>Nothing will be saved.</b> Browsers block storage for files opened directly. Run <code>npm start</code> and use the localhost address.'
    : '<b>Nothing will be saved.</b> This browser has storage turned off here.';
  $('#explorer').insertBefore(n, $('#exbody'));
}

await load();
R.all();
