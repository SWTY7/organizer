/*
 * ORGANIZER - Phase 0 probe
 * ===========================================================================
 * Paste this into the DevTools console on EITHER claude.ai OR chatgpt.com.
 * It detects which site you're on and runs the right checks. There is nothing
 * to configure and no wrong tab to paste it into - if the site isn't supported
 * it says so and stops.
 *
 * WHAT IT DOES
 *   Calls the same JSON endpoints the site's own web app calls, using the
 *   session you're already logged in with, and reports the SHAPE of the
 *   responses.
 *
 * WHAT IT DOES NOT DO
 *   No outbound requests to anywhere else. Nothing is uploaded. The schema
 *   summary contains NO message text and NO conversation titles - only key
 *   names, types, and string lengths. Access tokens are never printed or saved.
 *
 * HOW TO RUN
 *   1. Open claude.ai or chatgpt.com, logged in.
 *   2. F12 -> Console. If Chrome blocks the paste, type:  allow pasting
 *   3. Paste this whole file, press Enter.
 *   4. Then:
 *        copy(__probe.schema)   -> safe schema to your clipboard (share this)
 *        __probe.save()         -> downloads full raw JSON (private, stays local)
 */

(async () => {
  // ---------------------------------------------------------------- styling
  const tag = (bg) => `background:${bg};color:#fff;padding:1px 4px;border-radius:3px`;
  const log = (...a) => console.log('%c probe ', tag('#555'), ...a);
  const ok = (...a) => console.log('%c  OK   ', tag('#2d7d46'), ...a);
  const bad = (...a) => console.log('%c FAIL  ', tag('#b3261e'), ...a);
  const warn = (...a) => console.log('%c NOTE  ', tag('#b26a00'), ...a);
  const big = (msg, color) => console.log(`%c${msg}`, `font-size:14px;font-weight:bold;color:${color}`);

  // ------------------------------------------------------- site detection
  const host = location.hostname;
  const SITES = {
    'claude.ai': 'claude',
    'chatgpt.com': 'chatgpt',
    'chat.openai.com': 'chatgpt',
  };
  const site = SITES[host];

  if (!site) {
    big('Wrong site.', '#b3261e');
    console.log(
      `This probe runs on claude.ai or chatgpt.com.\n` +
      `You are on: ${host}\n\n` +
      `Open one of those in a tab, then paste this script into ITS console.`
    );
    return;
  }
  big(`Probing ${host}`, site === 'claude' ? '#c96442' : '#10a37f');
  log('nothing leaves your browser; the schema output has no message text in it');

  // --------------------------------------------------------- redacting dump
  // Values of these keys are enums/identifiers we genuinely need in order to
  // design the data model. Everything else is reduced to type + length.
  const SAFE_KEYS = new Set([
    'sender', 'role', 'type', 'content_type', 'model', 'model_slug',
    'stop_reason', 'end_turn', 'status', 'recipient', 'rendering_mode',
    'finish_type', 'is_starred', 'is_archived', 'kind', 'voice',
    'default_model_slug', 'parent', 'current_node',
  ]);

  function summarize(v, key, depth = 0, maxDepth = 8) {
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    if (Array.isArray(v)) {
      if (!v.length) return '[] (empty)';
      const shapes = [];
      for (const el of v.slice(0, 4)) {
        const s = summarize(el, key, depth + 1, maxDepth);
        if (!shapes.some((x) => JSON.stringify(x) === JSON.stringify(s))) shapes.push(s);
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
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i.test(v)) return 'uuid';
      if (/^\d{4}-\d{2}-\d{2}T/.test(v)) return 'iso-datetime';
      if (/^https?:\/\//.test(v)) return 'url';
      return `string(len=${v.length})`;
    }
    return typeof v;
  }

  // ------------------------------------------------------------ http helper
  // Distinguishes the three failure modes that actually happen:
  //   - real HTTP error
  //   - 200 with an HTML SPA shell (unknown route, or logged out)
  //   - 200 with JSON
  let authHeader = null;
  async function get(url, label) {
    let res;
    try {
      const headers = { accept: 'application/json' };
      if (authHeader) headers.authorization = authHeader;
      res = await fetch(url, { credentials: 'include', headers });
    } catch (e) {
      bad(`${label}: network error - ${e.message}`);
      return { ok: false, reason: 'network', status: 0 };
    }
    const text = await res.text();
    const looksHtml = /^\s*<(!doctype|html)/i.test(text);

    if (looksHtml) {
      bad(`${label}: got HTML instead of JSON (status ${res.status})`);
      console.log('   This usually means the route does not exist on this site, or');
      console.log('   your session expired. Check you are logged in and on the right site.');
      return { ok: false, reason: 'html', status: res.status };
    }
    if (!res.ok) {
      bad(`${label}: HTTP ${res.status}`);
      console.log('   body preview:', text.slice(0, 200));
      return { ok: false, reason: 'http', status: res.status, text };
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      bad(`${label}: 200 but body is not JSON`);
      console.log('   body preview:', text.slice(0, 200));
      return { ok: false, reason: 'notjson', status: res.status, text };
    }
    return { ok: true, status: res.status, json };
  }

  const result = { probedAt: new Date().toISOString(), site: host, steps: [] };
  const raw = {};
  const step = (name, r, extra = {}) =>
    result.steps.push({ step: name, status: r.status, ok: r.ok, ...extra });

  // ===================================================================
  //  CLAUDE
  // ===================================================================
  async function probeClaude() {
    // -- org uuid, with fallbacks ------------------------------------------
    let orgId = null;
    const orgs = await get('/api/organizations', 'GET /api/organizations');
    step('organizations', orgs);
    if (orgs.ok && Array.isArray(orgs.json) && orgs.json.length) {
      orgId = orgs.json[0].uuid;
      raw.organizations = orgs.json;
      result.organizationsShape = summarize(orgs.json, 'organizations');
      ok(`organizations -> ${orgs.json.length} org(s); using ${String(orgId).slice(0, 8)}...`);
    } else {
      const boot = await get('/api/bootstrap', 'GET /api/bootstrap (fallback)');
      step('bootstrap', boot);
      const memberships = boot.ok && boot.json && boot.json.account
        && boot.json.account.memberships;
      if (Array.isArray(memberships) && memberships.length) {
        orgId = memberships[0].organization && memberships[0].organization.uuid;
        ok(`bootstrap fallback resolved org ${String(orgId).slice(0, 8)}...`);
      }
    }
    if (!orgId) {
      bad('could not resolve an organization uuid - are you logged in to claude.ai?');
      result.fatal = 'no organization uuid';
      return;
    }
    result.orgResolved = true;

    // -- list ---------------------------------------------------------------
    const listUrl = `/api/organizations/${orgId}/chat_conversations`;
    const list = await get(listUrl, 'GET chat_conversations');
    step('list', list, { url: '/api/organizations/{org}/chat_conversations' });
    let first = null;
    if (list.ok && Array.isArray(list.json)) {
      raw.list = list.json;
      first = list.json[0];
      result.listCount = list.json.length;
      result.listItemKeys = first ? Object.keys(first).sort() : [];
      result.listShape = summarize(list.json.slice(0, 2), 'list');
      ok(`list -> ${list.json.length} conversations`);
      const updKey = result.listItemKeys.find((k) => /updated?_?at/i.test(k));
      result.deltaSyncViable = Boolean(updKey);
      result.deltaSyncKey = updKey || null;
      big(updKey
        ? `DELTA SYNC: VIABLE (list carries "${updKey}")`
        : 'DELTA SYNC: NOT from the list - no updated-at field',
        updKey ? '#2d7d46' : '#b26a00');
    }

    // -- detail, both variants ---------------------------------------------
    if (first && first.uuid) {
      result.detail = {};
      for (const v of [
        { name: 'tree', qs: '?tree=True&rendering_mode=messages' },
        { name: 'plain', qs: '' },
      ]) {
        const d = await get(
          `/api/organizations/${orgId}/chat_conversations/${first.uuid}${v.qs}`,
          `GET conversation (${v.name})`
        );
        step(`detail:${v.name}`, d, { qs: v.qs || '(none)' });
        if (!d.ok) continue;
        raw[`detail_${v.name}`] = d.json;
        const msgs = d.json.chat_messages || d.json.messages || [];
        const keys = Array.isArray(msgs) && msgs.length ? Object.keys(msgs[0]) : [];
        const parentKey = keys.find((k) => /parent/i.test(k)) || null;
        result.detail[v.name] = {
          topLevelKeys: Object.keys(d.json).sort(),
          messageCount: Array.isArray(msgs) ? msgs.length : null,
          messageKeys: keys.sort(),
          parentKey,
          shape: summarize(d.json, 'conversation'),
        };
        ok(`detail (${v.name}) -> ${Array.isArray(msgs) ? msgs.length : '?'} messages`);
        log(`   message keys: ${keys.join(', ') || '(none)'}`);
        big(parentKey
          ? `   TREE: branches preserved via "${parentKey}"`
          : `   TREE: no parent pointer in "${v.name}" - branches not recoverable here`,
          parentKey ? '#2d7d46' : '#b26a00');

        // Which content block types actually occur?
        if (Array.isArray(msgs)) {
          const types = new Set(), senders = new Set();
          for (const m of msgs) {
            if (m.sender) senders.add(m.sender);
            for (const c of (m.content || [])) if (c && c.type) types.add(c.type);
          }
          result.detail[v.name].contentTypes = [...types];
          result.detail[v.name].senders = [...senders];
          log(`   content block types: ${[...types].join(', ') || '(none)'}`);
          log(`   senders: ${[...senders].join(', ') || '(none)'}`);
        }
      }
    }

    // -- projects -----------------------------------------------------------
    const proj = await get(`/api/organizations/${orgId}/projects`, 'GET projects');
    step('projects', proj);
    if (proj.ok) {
      raw.projects = proj.json;
      result.projectsShape = summarize(proj.json, 'projects');
      ok(`projects -> ${Array.isArray(proj.json) ? proj.json.length : '?'}`);
    }
  }

  // ===================================================================
  //  CHATGPT
  // ===================================================================
  async function probeChatGPT() {
    // -- bearer token -------------------------------------------------------
    const sess = await get('/api/auth/session', 'GET /api/auth/session');
    step('session', sess);
    if (sess.ok && sess.json && sess.json.accessToken) {
      authHeader = `Bearer ${sess.json.accessToken}`;
      ok('session -> accessToken acquired (not printed, not saved)');
    } else {
      warn('no accessToken; trying cookie-only auth for /backend-api/');
    }

    // -- list ---------------------------------------------------------------
    const listUrl = '/backend-api/conversations?offset=0&limit=20&order=updated';
    const list = await get(listUrl, 'GET /backend-api/conversations');
    step('list', list, { url: listUrl });
    let items = [];
    if (list.ok && list.json) {
      raw.list = list.json;
      items = list.json.items || [];
      result.listEnvelopeKeys = Object.keys(list.json).sort();
      result.listTotal = list.json.total ?? null;
      result.listItemKeys = items.length ? Object.keys(items[0]).sort() : [];
      result.listShape = summarize({ ...list.json, items: items.slice(0, 2) }, 'list');
      ok(`list -> ${items.length} items (total reported: ${list.json.total ?? '?'})`);
      const updKey = result.listItemKeys.find((k) => /update/i.test(k));
      result.deltaSyncViable = Boolean(updKey);
      result.deltaSyncKey = updKey || null;
      big(updKey
        ? `DELTA SYNC: VIABLE (list carries "${updKey}")`
        : 'DELTA SYNC: NOT from the list - no update timestamp',
        updKey ? '#2d7d46' : '#b26a00');
    }

    // -- detail -------------------------------------------------------------
    if (items.length && items[0].id) {
      const d = await get(`/backend-api/conversation/${items[0].id}`, 'GET conversation');
      step('detail', d);
      if (d.ok) {
        raw.detail = d.json;
        const mapping = d.json.mapping || {};
        const nodes = Object.values(mapping);
        const branchPoints = nodes.filter(
          (n) => Array.isArray(n.children) && n.children.length > 1
        ).length;
        result.detail = {
          topLevelKeys: Object.keys(d.json).sort(),
          nodeCount: nodes.length,
          hasCurrentNode: 'current_node' in d.json,
          branchPoints,
          shape: summarize(d.json, 'conversation'),
        };
        ok(`detail -> ${nodes.length} mapping nodes`);
        big(branchPoints
          ? `   TREE CONFIRMED: ${branchPoints} branch point(s) - flattening would lose data`
          : '   This conversation is linear. Re-run with a chat where you EDITED a prompt.',
          branchPoints ? '#2d7d46' : '#b26a00');

        // Walk the main path the way the UI does.
        if (d.json.current_node) {
          let cur = d.json.current_node, n = 0; const roles = new Set();
          while (cur && mapping[cur] && n < 10000) {
            const m = mapping[cur].message;
            if (m && m.author && m.author.role) roles.add(m.author.role);
            cur = mapping[cur].parent; n++;
          }
          result.detail.mainPathLength = n;
          result.detail.mainPathRoles = [...roles];
          log(`   main path: ${n} nodes; roles: ${[...roles].join(', ')}`);
        }

        const ctypes = new Set(), roles = new Set(), recips = new Set();
        for (const nd of nodes) {
          const m = nd.message;
          if (!m) continue;
          if (m.content && m.content.content_type) ctypes.add(m.content.content_type);
          if (m.author && m.author.role) roles.add(m.author.role);
          if (m.recipient) recips.add(m.recipient);
        }
        Object.assign(result.detail, {
          contentTypes: [...ctypes], roles: [...roles], recipients: [...recips],
        });
        log(`   content_types: ${[...ctypes].join(', ') || '(none)'}`);
        log(`   roles: ${[...roles].join(', ')}`);
      }
    }
  }

  // ------------------------------------------------------------------ run
  try {
    if (site === 'claude') await probeClaude();
    else await probeChatGPT();
  } catch (e) {
    bad('probe threw:', e && e.message);
    console.error(e);
    result.threw = String(e && e.message);
  }

  // --------------------------------------------------------------- output
  function download() {
    for (const [name, data] of [['raw', raw], ['schema', result]]) {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `probe-${site}-${name}-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    }
    log('downloaded. the "raw" file has your real conversations in it - keep it local.');
  }
  window.__probe = { schema: result, raw, save: download };

  console.log('\n');
  log('DONE.');
  console.table(result.steps);
  console.log(JSON.stringify(result, null, 2));
  big('NEXT:  copy(__probe.schema)   then paste that back to Claude', '#444');
  console.log('%c       __probe.save()          downloads full raw JSON (stays local)',
    'color:#777');
})();
