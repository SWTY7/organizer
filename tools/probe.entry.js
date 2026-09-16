/**
 * Entry point for the pasteable probe. Provider specifics live in
 * packages/adapters/<provider>.js — this file only drives them.
 */

import { adapterForHost, SUPPORTED_HOSTS } from '../packages/adapters/index.js';
import { download } from '../packages/adapters/shared.js';

(async () => {
  const tag = (bg) => `background:${bg};color:#fff;padding:1px 4px;border-radius:3px`;
  const log = (...a) => console.log('%c probe ', tag('#555'), ...a);
  const ok = (...a) => console.log('%c  OK   ', tag('#2d7d46'), ...a);
  const bad = (...a) => console.log('%c FAIL  ', tag('#b3261e'), ...a);
  const big = (m, c) => console.log(`%c${m}`, `font-size:14px;font-weight:bold;color:${c}`);

  const adapter = adapterForHost(location.hostname);
  if (!adapter) {
    big('Wrong site.', '#b3261e');
    console.log(
      `This probe runs on: ${SUPPORTED_HOSTS.join(', ')}\n` +
      `You are on: ${location.hostname}\n\n` +
      `Open one of those in a tab and paste this into ITS console.`
    );
    return;
  }

  big(`Probing ${adapter.label} (${location.hostname})`, adapter.accent);
  log('nothing leaves your browser; the schema output has no message text in it');

  const result = { probedAt: new Date().toISOString(), site: location.hostname,
                   provider: adapter.id };

  try {
    Object.assign(result, { init: await adapter.init() });
    ok('connected');
    await adapter.probe(result);
  } catch (e) {
    bad(e.message);
    result.error = e.message;
    console.error(e);
  }

  if (result.deltaSyncViable != null) {
    big(result.deltaSyncViable
      ? `DELTA SYNC: VIABLE (list carries "${result.deltaSyncKey}")`
      : 'DELTA SYNC: not from the list — no update timestamp',
      result.deltaSyncViable ? '#2d7d46' : '#b26a00');
  }
  if (result.detail?.branchPoints != null) {
    big(result.detail.branchPoints
      ? `TREE CONFIRMED: ${result.detail.branchPoints} branch point(s), ` +
        `${result.detail.nodeCount} nodes vs ${result.detail.mainPathLength} on the main path`
      : 'This conversation is linear. Re-run with a chat where you EDITED a prompt.',
      result.detail.branchPoints ? '#2d7d46' : '#b26a00');
  }
  for (const [name, d] of Object.entries(result.detail || {})) {
    if (d && typeof d === 'object' && 'parentKey' in d) {
      big(d.parentKey
        ? `TREE (${name}): branches preserved via "${d.parentKey}"`
        : `TREE (${name}): no parent pointer — branches not recoverable here`,
        d.parentKey ? '#2d7d46' : '#b26a00');
      log(`  ${name}: content types = ${(d.contentTypes || []).join(', ') || '(none)'}`);
    }
  }

  window.__probe = { schema: result, save: () => download(result, `probe-${adapter.id}.json`) };
  console.log(JSON.stringify(result, null, 2));
  big('NEXT:  copy(__probe.schema)   then paste that back to Claude', '#444');
})();
