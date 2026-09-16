/**
 * Entry point for the pasteable exporter. Provider specifics live in
 * packages/adapters/<provider>.js — this file only drives them.
 */

import { adapterForHost, SUPPORTED_HOSTS } from '../packages/adapters/index.js';
import { SCHEMA_VERSION, download, slug, sleep, RATE_MS } from '../packages/adapters/shared.js';

(() => {
  const tag = (bg) => `background:${bg};color:#fff;padding:1px 4px;border-radius:3px`;
  const log = (...a) => console.log('%c export ', tag('#555'), ...a);
  const ok = (...a) => console.log('%c  OK   ', tag('#2d7d46'), ...a);
  const bad = (...a) => console.log('%c FAIL  ', tag('#b3261e'), ...a);
  const big = (m, c) => console.log(`%c${m}`, `font-size:14px;font-weight:bold;color:${c}`);

  const adapter = adapterForHost(location.hostname);
  if (!adapter) {
    big('Wrong site.', '#b3261e');
    console.log(`Run this on: ${SUPPORTED_HOSTS.join(', ')}. You are on: ${location.hostname}`);
    return;
  }

  const GENERATOR = { name: `organizer-export-console/${adapter.id}`, version: '0.2.0' };
  let ready = null;
  const init = () => (ready ||= adapter.init());

  function stats(conv) {
    const kinds = {};
    for (const b of conv.messages.flatMap((m) => m.content)) {
      kinds[b.type] = (kinds[b.type] || 0) + 1;
    }
    const roots = conv.messages.filter((m) => !m.parentId).length;
    return `${conv.messages.length} messages, ` +
      `blocks: ${Object.entries(kinds).map(([k, v]) => `${k}×${v}`).join(', ')}` +
      (roots > 1 ? ` — NOTE: ${roots} roots (branched or spliced)` : '');
  }

  async function one() {
    await init();
    const id = adapter.currentId();
    if (!id) {
      bad('No conversation in the URL. Open a chat first, then run one() again.');
      return;
    }
    log(`fetching ${id.slice(0, 8)}…`);
    const conv = await adapter.convert(await adapter.detail(id));
    ok(`"${conv.title}" — ${stats(conv)}`);
    download(conv, `${slug(conv.title)}.chat.json`);
    big('Downloaded.', '#2d7d46');
    return (window.__conv = conv);
  }

  async function many(items, label) {
    const conversations = [];
    const failures = [];
    const t0 = Date.now();
    for (let i = 0; i < items.length; i++) {
      try {
        conversations.push(await adapter.convert(await adapter.detail(items[i].id), items[i]));
      } catch (e) {
        failures.push({ id: items[i].id, title: items[i].title, error: e.message });
        bad(`${items[i].title}: ${e.message}`);
      }
      if ((i + 1) % 10 === 0 || i === items.length - 1) {
        log(`${i + 1}/${items.length} (${Math.round(((i + 1) / items.length) * 100)}%)`);
      }
      if (i < items.length - 1) await sleep(RATE_MS);
    }

    const pack = {
      manifest: {
        schemaVersion: SCHEMA_VERSION,
        kind: 'chatpack',
        generator: GENERATOR,
        capturedAt: new Date().toISOString(),
        conversationCount: conversations.length,
        providers: [adapter.id],
        hasOverlay: false,
      },
      conversations,
    };
    ok(`${conversations.length} conversations in ${Math.round((Date.now() - t0) / 1000)}s` +
       (failures.length ? `, ${failures.length} failed` : ''));
    if (failures.length) console.table(failures);
    download(pack, `${adapter.id}-${label}-${Date.now()}.chatpack.json`);
    big('Downloaded.', '#2d7d46');
    return (window.__pack = pack);
  }

  async function recent(n = 20) {
    await init();
    const items = await adapter.list();
    log(`${items.length} conversations available; taking ${Math.min(n, items.length)}`);
    return many(items.slice(0, n), `recent${n}`);
  }

  async function all(opts = {}) {
    await init();
    const items = await adapter.list();
    if (items.length > 50 && !opts.confirm) {
      big(`${items.length} conversations — about ` +
          `${Math.round((items.length * RATE_MS) / 1000)}s at a polite request rate.`, '#b26a00');
      console.log('Run  await all({ confirm: true })  to go ahead,' +
                  ' or  await recent(20)  for a quick sample first.');
      return;
    }
    return many(items, 'all');
  }

  Object.assign(window, { one, recent, all });
  window.__export = { one, recent, all, adapter };

  big(`export ready — ${adapter.label}`, adapter.accent);
  console.log(
    '%cawait one()%c        this conversation -> .chat.json\n' +
    '%cawait recent(20)%c   20 most recent -> .chatpack.json\n' +
    '%cawait all()%c        everything (confirms first if it is a lot)',
    'font-weight:bold', '', 'font-weight:bold', '', 'font-weight:bold', ''
  );
})();
