/*
 * ORGANIZER - Phase 0 probe: chatgpt.com
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES
 *   Calls the same JSON endpoints ChatGPT's own web app calls, using your
 *   existing logged-in session, and reports the SHAPE of what comes back.
 *
 * WHAT IT DOES NOT DO
 *   It does not send anything anywhere. Everything stays in your browser.
 *   The schema summary contains NO message text and NO conversation titles -
 *   only key names, types and string lengths. It is safe to share.
 *   Your access token is never printed or included in any output.
 *
 * HOW TO RUN
 *   1. Open https://chatgpt.com and make sure you are logged in.
 *   2. Open DevTools (F12) -> Console tab.
 *   3. If Chrome says "Warning: Don't paste code...", type: allow pasting
 *   4. Paste this whole file, press Enter.
 *   5. Read the output. Then:
 *        copy(__probe.schema)   -> puts the safe schema on your clipboard
 *        __probe.save()         -> downloads the FULL raw JSON (private!)
 */

(async () => {
  const log = (...a) => console.log('%c[probe]', 'color:#10a37f;font-weight:bold', ...a);
  const ok = (...a) => console.log('%c  OK  ', 'background:#2d7d46;color:#fff', ...a);
  const bad = (...a) => console.log('%c FAIL ', 'background:#b3261e;color:#fff', ...a);

  const SAFE_KEYS = new Set([
    'role', 'sender', 'type', 'content_type', 'model', 'model_slug',
    'stop_reason', 'end_turn', 'status', 'recipient', 'finish_type',
    'is_archived', 'is_starred', 'default_model_slug', 'current_node',
    'parent', 'voice', 'kind',
  ]);

  function summarize(v, key, depth = 0, maxDepth = 8) {
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    if (Array.isArray(v)) {
      if (v.length === 0) return '[] (empty)';
      const shapes = [];
      for (const el of v.slice(0, 3)) {
        const s = JSON.stringify(summarize(el, key, depth + 1, maxDepth));
        if (!shapes.some((x) => JSON.stringify(x) === s)) {
          shapes.push(summarize(el, key, depth + 1, maxDepth));
        }
      }
      return { __array_of: shapes.length === 1 ? shapes[0] : shapes, __length: v.length };
    }
    if (typeof v === 'object') {
      if (depth >= maxDepth) return '{...depth limit...}';
      const out = {};
      for (const k of Object.keys(v)) out[k] = summarize(v[k], k, depth + 1, maxDepth);
      return out;
    }
    if (typeof v === 'string') {
      if (SAFE_KEYS.has(key)) return `"${v}"`;
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(v)) return 'uuid';
      if (/^\d{4}-\d{2}-\d{2}T/.test(v)) return 'iso-datetime';
      return `string(len=${v.length})`;
    }
    return typeof v;
  }

  // --- Auth: /backend-api/ wants a bearer token from the session endpoint ----
  let token = null;
  try {
    const s = await fetch('/api/auth/session', { credentials: 'include' });
    if (s.ok) {
      const sj = await s.json();
      token = sj.accessToken || null;
      ok(`/api/auth/session -> 200, accessToken ${token ? 'present' : 'MISSING'}`);
    } else {
      bad(`/api/auth/session -> ${s.status}`);
    }
  } catch (e) {
    bad('/api/auth/session threw', e.message);
  }

  async function get(url) {
    const headers = { accept: 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(url, { credentials: 'include', headers });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { url, status: res.status, json, text };
  }

  const result = { probedAt: new Date().toISOString(), site: 'chatgpt.com', steps: [] };
  const raw = {};

  log('starting - chatgpt.com');
  log('nothing leaves your browser. token is never printed or saved.');

  // --- Step 1: list conversations -------------------------------------------
  const listUrl = '/backend-api/conversations?offset=0&limit=20&order=updated';
  const listRes = await get(listUrl);
  result.steps.push({ step: 'list', url: listUrl, status: listRes.status });
  let items = [];
  if (listRes.status === 200 && listRes.json) {
    raw.list = listRes.json;
    items = listRes.json.items || [];
    result.listEnvelopeKeys = Object.keys(listRes.json).sort();
    result.listTotal = listRes.json.total ?? null;
    result.listShape = summarize({ ...listRes.json, items: items.slice(0, 2) }, 'list');
    result.listItemKeys = items.length ? Object.keys(items[0]).sort() : [];
    ok(`list -> 200, ${items.length} items (total reported: ${listRes.json.total ?? '?'})`);
    const hasUpdated = result.listItemKeys.some((k) => /update/i.test(k));
    result.deltaSyncViable = hasUpdated;
    log(hasUpdated
      ? 'DELTA SYNC: viable - list items include an update timestamp'
      : 'DELTA SYNC: no update timestamp on list items');
  } else {
    bad(`list -> ${listRes.status}`);
    console.log('   response preview:', listRes.text.slice(0, 300));
  }

  // --- Step 2: one conversation in full -------------------------------------
  const firstId = items.length ? items[0].id : null;
  if (firstId) {
    const dRes = await get(`/backend-api/conversation/${firstId}`);
    result.steps.push({ step: 'detail', status: dRes.status });
    if (dRes.status === 200 && dRes.json) {
      raw.detail = dRes.json;
      const mapping = dRes.json.mapping || {};
      const nodes = Object.values(mapping);
      result.detail = {
        topLevelKeys: Object.keys(dRes.json).sort(),
        nodeCount: nodes.length,
        hasCurrentNode: 'current_node' in dRes.json,
        shape: summarize(dRes.json, 'conversation'),
      };
      ok(`detail -> 200, ${nodes.length} mapping nodes`);

      // --- Branch analysis: this is the thing we most need to confirm ------
      const withChildren = nodes.filter((n) => Array.isArray(n.children) && n.children.length > 1);
      result.detail.branchPoints = withChildren.length;
      result.detail.isLinear = withChildren.length === 0;
      log(`   mapping nodes: ${nodes.length}, branch points (>1 child): ${withChildren.length}`);
      log(withChildren.length
        ? '   TREE CONFIRMED - this conversation has real branches, flattening would lose data'
        : '   this particular conversation is linear (try one where you edited a prompt)');

      // Walk the main path from current_node up, like the UI does.
      if (dRes.json.current_node) {
        let cur = dRes.json.current_node, steps = 0, roles = [];
        while (cur && mapping[cur] && steps < 10000) {
          const m = mapping[cur].message;
          if (m && m.author) roles.push(m.author.role);
          cur = mapping[cur].parent; steps++;
        }
        result.detail.mainPathLength = steps;
        result.detail.mainPathRoles = [...new Set(roles)];
        log(`   main path from current_node: ${steps} nodes, roles seen: ${[...new Set(roles)].join(', ')}`);
      }

      // What content_types actually occur? Drives the ContentBlock union.
      const ctypes = new Set(), roleSet = new Set(), recipients = new Set();
      for (const n of nodes) {
        const m = n.message;
        if (!m) continue;
        if (m.content && m.content.content_type) ctypes.add(m.content.content_type);
        if (m.author && m.author.role) roleSet.add(m.author.role);
        if (m.recipient) recipients.add(m.recipient);
      }
      result.detail.contentTypes = [...ctypes];
      result.detail.roles = [...roleSet];
      result.detail.recipients = [...recipients];
      log(`   content_types: ${[...ctypes].join(', ') || 'none'}`);
      log(`   roles: ${[...roleSet].join(', ')}`);
    } else {
      bad(`detail -> ${dRes.status}`);
      console.log('   response preview:', dRes.text.slice(0, 300));
    }
  } else {
    log('no conversations found to inspect');
  }

  function download(rawObj, schemaObj) {
    for (const [name, data] of [['raw', rawObj], ['schema', schemaObj]]) {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `probe-chatgpt-${name}-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    }
    log('downloaded. the "raw" file contains your actual conversations - keep it local.');
  }

  window.__probe = { schema: result, raw, save: () => download(raw, result) };

  console.log('\n');
  log('DONE. Summary:');
  console.table(result.steps);
  console.log(JSON.stringify(result, null, 2));
  console.log('\n%cNEXT: run  copy(__probe.schema)  and paste the result back to Claude.',
    'font-size:13px;font-weight:bold;color:#10a37f');
  console.log('%c      run  __probe.save()  to download the full raw JSON (stays local).',
    'font-size:12px;color:#666');
})();
