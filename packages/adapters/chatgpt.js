/**
 * Adapter: chatgpt.com
 *
 * Everything provider-specific about ChatGPT lives here. Adding another LLM
 * means writing a sibling of this file, not touching anything else.
 */

import {
  SCHEMA_VERSION, iso, stableKey, convId, spliceParents,
  makeHttp, summarize, sleep, RATE_MS,
} from './shared.js';

export const chatgpt = {
  id: 'chatgpt',
  label: 'ChatGPT',
  hosts: ['chatgpt.com', 'chat.openai.com'],
  accent: '#10a37f',

  http: makeHttp(),

  async init() {
    // Cookies alone are not enough for /backend-api/; it wants a bearer token.
    const s = await this.http.getJson('/api/auth/session');
    if (!s.accessToken) throw new Error('no accessToken — logged in?');
    this.http.setAuth(`Bearer ${s.accessToken}`);
    return { tokenAcquired: true };
  },

  async list() {
    const out = [];
    let offset = 0;
    const limit = 100;
    for (;;) {
      const page = await this.http.getJson(
        `/backend-api/conversations?offset=${offset}&limit=${limit}&order=updated`
      );
      const items = page.items || [];
      out.push(...items);
      if (items.length < limit || out.length >= (page.total ?? out.length)) break;
      offset += limit;
      await sleep(RATE_MS);
    }
    return out.map((c) => ({
      id: c.id,
      title: c.title,
      updatedAt: c.update_time,
      _raw: c,
    }));
  },

  async detail(id) {
    return this.http.getJson(`/backend-api/conversation/${id}`);
  },

  currentId() {
    const m = location.pathname.match(/\/c\/([0-9a-f-]{36})/i);
    return m ? m[1] : null;
  },

  // ------------------------------------------------------------- conversion

  /**
   * One ChatGPT message -> zero or more canonical blocks.
   *
   * `recipient` is the tool-call discriminator, NOT content_type. `all` means
   * the block is addressed to the user; anything else means the model is
   * calling a tool. Without this rule every Python call renders as an ordinary
   * code block and the execution output that follows has nothing to attach to.
   */
  block(msg) {
    const c = msg.content;
    if (!c) return [];
    const recipient = msg.recipient || 'all';
    const isToolCall = recipient !== 'all';

    switch (c.content_type) {
      case 'text':
        return (c.parts || [])
          .filter((p) => typeof p === 'string' && p.length)
          .map((p) => ({ type: 'text', text: p }));

      case 'multimodal_text':
        return (c.parts || []).flatMap((p) => {
          if (typeof p === 'string') return p.length ? [{ type: 'text', text: p }] : [];
          if (p && p.content_type === 'image_asset_pointer') {
            return [{
              type: 'image',
              srcRef: p.asset_pointer,
              width: p.width,
              height: p.height,
              meta: { sizeBytes: p.size_bytes },
            }];
          }
          return [{ type: p?.content_type || 'unknown', meta: p }];
        });

      case 'code':
        return [isToolCall
          ? { type: 'tool_use', name: recipient, text: c.text || '', lang: c.language }
          : { type: 'code', text: c.text || '', lang: c.language }];

      case 'execution_output':
        return [{ type: 'tool_result', text: c.text || '' }];

      case 'thoughts': {
        const summaries = (c.thoughts || []).map((t) => t.summary).filter(Boolean);
        const text = (c.thoughts || []).map((t) => t.content).filter(Boolean).join('\n\n');
        const b = { type: 'thinking' };
        if (text) b.text = text;
        if (summaries.length) b.summaries = summaries;
        return b.text || b.summaries ? [b] : [];
      }

      case 'reasoning_recap':
        return c.content ? [{ type: 'thinking', summaries: [c.content] }] : [];

      default:
        return [{ type: c.content_type || 'unknown', meta: c }];
    }
  },

  async convert(d) {
    const mapping = d.mapping || {};

    // Parent links for EVERY raw node — including the null root and any node
    // whose content maps to nothing — so survivors reattach to their nearest
    // surviving ancestor instead of being severed into false roots.
    const parentOf = new Map();
    for (const node of Object.values(mapping)) parentOf.set(node.id, node.parent || null);

    const messages = [];
    for (const node of Object.values(mapping)) {
      const m = node.message;
      if (!m) continue; // the root node carries no message
      const content = this.block(m);
      if (!content.length) continue;

      messages.push({
        id: node.id,
        parentId: null, // set by spliceParents below
        role: m.author?.role || 'assistant',
        createdAt: iso(m.create_time),
        model: m.metadata?.model_slug || null,
        stableKey: await stableKey('chatgpt', d.conversation_id, node.id),
        ...(m.metadata?.finish_details?.type
          ? { stopReason: m.metadata.finish_details.type } : {}),
        status: m.status === 'in_progress' ? 'in_progress' : 'complete',
        hidden: m.weight === 0,
        content,
      });
    }
    spliceParents(messages, parentOf);

    return {
      schemaVersion: SCHEMA_VERSION,
      kind: 'conversation',
      id: await convId('chatgpt', d.conversation_id),
      provider: 'chatgpt',
      providerConvId: d.conversation_id,
      title: d.title || '(untitled)',
      createdAt: iso(d.create_time),
      updatedAt: iso(d.update_time),
      model: d.default_model_slug || null,
      sourceUrl: `https://chatgpt.com/c/${d.conversation_id}`,
      currentLeafId: d.current_node || null,
      starred: !!d.is_starred,
      messages,
    };
  },

  // -------------------------------------------------------------- diagnostics

  async probe(result) {
    const listUrl = '/backend-api/conversations?offset=0&limit=20&order=updated';
    const page = await this.http.getJson(listUrl);
    const items = page.items || [];
    result.listEnvelopeKeys = Object.keys(page).sort();
    result.listTotal = page.total ?? null;
    result.listItemKeys = items.length ? Object.keys(items[0]).sort() : [];
    result.listShape = summarize({ ...page, items: items.slice(0, 2) }, 'list');
    const updKey = result.listItemKeys.find((k) => /update/i.test(k));
    result.deltaSyncViable = Boolean(updKey);
    result.deltaSyncKey = updKey || null;

    if (items.length) {
      const d = await this.http.getJson(`/backend-api/conversation/${items[0].id}`);
      const mapping = d.mapping || {};
      const nodes = Object.values(mapping);
      const branchPoints = nodes.filter(
        (n) => Array.isArray(n.children) && n.children.length > 1
      ).length;

      const ctypes = new Set(), roles = new Set(), recips = new Set();
      for (const n of nodes) {
        const m = n.message;
        if (!m) continue;
        if (m.content?.content_type) ctypes.add(m.content.content_type);
        if (m.author?.role) roles.add(m.author.role);
        if (m.recipient) recips.add(m.recipient);
      }

      let mainPathLength = 0;
      if (d.current_node) {
        let cur = d.current_node;
        while (cur && mapping[cur] && mainPathLength < 10000) {
          cur = mapping[cur].parent;
          mainPathLength++;
        }
      }

      result.detail = {
        topLevelKeys: Object.keys(d).sort(),
        nodeCount: nodes.length,
        hasCurrentNode: 'current_node' in d,
        branchPoints,
        mainPathLength,
        contentTypes: [...ctypes],
        roles: [...roles],
        recipients: [...recips],
        shape: summarize(d, 'conversation'),
      };
    }
    return result;
  },
};
