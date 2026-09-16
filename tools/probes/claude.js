/*
 * ORGANIZER — Phase 0 probe: claude.ai
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES
 *   Calls the same JSON endpoints claude.ai's own web app calls, using your
 *   existing logged-in session, and reports the SHAPE of what comes back.
 *
 * WHAT IT DOES NOT DO
 *   It does not send anything anywhere. Everything stays in your browser.
 *   The schema summary it prints contains NO message text, NO conversation
 *   titles - only key names, types and string lengths. It is safe to share.
 *
 * HOW TO RUN
 *   1. Open https://claude.ai and make sure you are logged in.
 *   2. Open DevTools (F12) -> Console tab.
 *   3. If Chrome says "Warning: Don't paste code...", type: allow pasting
 *   4. Paste this whole file, press Enter.
 *   5. Read the output. Then:
 *        copy(__probe.schema)   -> puts the safe schema on your clipboard
 *        __probe.save()         -> downloads the FULL raw JSON (private!)
 */

(async () => {
  const log = (...a) => console.log('%c[probe]', 'color:#c96442;font-weight:bold', ...a);
  const ok = (...a) => console.log('%c  OK  ', 'background:#2d7d46;color:#fff', ...a);
  const bad = (...a) => console.log('%c FAIL ', 'background:#b3261e;color:#fff', ...a);

  // Keys whose VALUES are safe to reveal: they are enums/identifiers that we
  // need in order to design the canonical model. Everything else is redacted
  // to just its type and length.
  const SAFE_KEYS = new Set([
    'sender', 'role', 'type', 'content_type', 'model', 'model_slug',
    'stop_reason', 'end_turn', 'status', 'recipient', 'rendering_mode',
    'finish_type', 'is_starred', 'current_leaf_message_uuid', 'parent_message_uuid',
  ]);

  function summarize(v, key, depth = 0, maxDepth = 8) {
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    if (Array.isArray(v)) {
      if (v.length === 0) return '[] (empty)';
      // Union the shapes of up to 3 elements so we catch heterogeneous arrays
      // (Claude's content[] blocks are exactly this case).
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
      // Preserve the *look* of the value without the content, so we can tell
      // a uuid from an ISO date from prose.
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(v)) return 'uuid';
      if (/^\d{4}-\d{2}-\d{2}T/.test(v)) return 'iso-datetime';
      return `string(len=${v.length})`;
    }
    return typeof v;
  }

  async function get(url) {
    const res = await fetch(url, { credentials: 'include', headers: { accept: 'application/json' } });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { url, status: res.status, contentType: res.headers.get('content-type'), json, text };
  }

  const result = { probedAt: new Date().toISOString(), site: 'claude.ai', steps: [] };
  const raw = {};

  log('starting - claude.ai');
  log('nothing leaves your browser. schema output contains no message text.');

  // --- Step 1: discover the organization uuid --------------------------------
  let orgId = null;
  const orgRes = await get('/api/organizations');
  result.steps.push({ step: 'organizations', url: '/api/organizations', status: orgRes.status });
  if (orgRes.status === 200 && Array.isArray(orgRes.json) && orgRes.json.length) {
    orgId = orgRes.json[0].uuid;
    raw.organizations = orgRes.json;
    result.organizationsShape = summarize(orgRes.json, 'organizations');
    ok(`/api/organizations -> ${orgRes.status}, ${orgRes.json.length} org(s), using first`);
  } else {
    bad(`/api/organizations -> ${orgRes.status}. Are you logged in?`);
    console.log('   response preview:', orgRes.text.slice(0, 300));
    result.fatal = 'could not resolve organization uuid';
    window.__probe = { schema: result, raw, save: () => download(raw, result) };
    return;
  }

  // --- Step 2: list conversations -------------------------------------------
  const listUrl = `/api/organizations/${orgId}/chat_conversations`;
  const listRes = await get(listUrl);
  result.steps.push({ step: 'list', url: listUrl.replace(orgId, '{org}'), status: listRes.status });
  if (listRes.status === 200 && Array.isArray(listRes.json)) {
    raw.list = listRes.json;
    result.listCount = listRes.json.length;
    result.listShape = summarize(listRes.json.slice(0, 2), 'list');
    result.listKeys = listRes.json.length ? Object.keys(listRes.json[0]).sort() : [];
    ok(`list -> ${listRes.status}, ${listRes.json.length} conversations`);
    // Does the list carry updated_at? This is what makes delta sync possible.
    const hasUpdated = result.listKeys.some((k) => /updated?_at/i.test(k));
    result.deltaSyncViable = hasUpdated;
    log(hasUpdated
      ? 'DELTA SYNC: viable - list includes an updated-at field'
      : 'DELTA SYNC: list has no updated-at field; will need per-conversation checks');
  } else {
    bad(`list -> ${listRes.status}`);
    console.log('   response preview:', listRes.text.slice(0, 300));
  }

  // --- Step 3: fetch one conversation, with and without tree=True -----------
  const firstId = Array.isArray(listRes.json) && listRes.json.length ? listRes.json[0].uuid : null;
  if (firstId) {
    const variants = [
      { name: 'tree', qs: '?tree=True&rendering_mode=messages' },
      { name: 'plain', qs: '' },
    ];
    result.detail = {};
    for (const v of variants) {
      const dUrl = `/api/organizations/${orgId}/chat_conversations/${firstId}${v.qs}`;
      const dRes = await get(dUrl);
      result.steps.push({ step: `detail:${v.name}`, qs: v.qs, status: dRes.status });
      if (dRes.status === 200 && dRes.json) {
        raw[`detail_${v.name}`] = dRes.json;
        const msgs = dRes.json.chat_messages || dRes.json.messages || [];
        result.detail[v.name] = {
          topLevelKeys: Object.keys(dRes.json).sort(),
          messageCount: Array.isArray(msgs) ? msgs.length : 'n/a',
          shape: summarize(dRes.json, 'conversation'),
        };
        ok(`detail (${v.name}) -> ${dRes.status}, ${Array.isArray(msgs) ? msgs.length : '?'} messages`);
        // Branch detection: do messages carry parent pointers?
        if (Array.isArray(msgs) && msgs.length) {
          const mk = Object.keys(msgs[0]);
          const parentKey = mk.find((k) => /parent/i.test(k));
          result.detail[v.name].parentKey = parentKey || null;
          log(`   ${v.name}: message keys = ${mk.join(', ')}`);
          log(parentKey
            ? `   ${v.name}: BRANCHES preserved via "${parentKey}"`
            : `   ${v.name}: no parent pointer - branches NOT recoverable from this variant`);
        }
      } else {
        bad(`detail (${v.name}) -> ${dRes.status}`);
      }
    }
  } else {
    log('no conversations found to inspect');
  }

  // --- Step 4: projects ------------------------------------------------------
  const projUrl = `/api/organizations/${orgId}/projects`;
  const projRes = await get(projUrl);
  result.steps.push({ step: 'projects', status: projRes.status });
  if (projRes.status === 200 && projRes.json) {
    raw.projects = projRes.json;
    result.projectsShape = summarize(projRes.json, 'projects');
    ok(`projects -> ${projRes.status}, ${Array.isArray(projRes.json) ? projRes.json.length : '?'} project(s)`);
  } else {
    log(`projects -> ${projRes.status} (not critical)`);
  }

  function download(rawObj, schemaObj) {
    for (const [name, data] of [['raw', rawObj], ['schema', schemaObj]]) {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `probe-claude-${name}-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    }
    log('downloaded. the "raw" file contains your actual conversations - keep it local.');
  }

  window.__probe = { schema: result, raw, save: () => download(raw, result) };

  console.log('\n');
  log('DONE. Summary:');
  console.table(result.steps);
  log('Safe schema (no message content) is below and in __probe.schema');
  console.log(JSON.stringify(result, null, 2));
  console.log('\n%cNEXT: run  copy(__probe.schema)  and paste the result back to Claude.',
    'font-size:13px;font-weight:bold;color:#c96442');
  console.log('%c      run  __probe.save()  to download the full raw JSON (stays local).',
    'font-size:12px;color:#666');
})();
