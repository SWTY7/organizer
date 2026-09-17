/**
 * Adapter: chatgpt.com
 *
 * Everything provider-specific about ChatGPT lives here. Adding another LLM
 * means writing a sibling of this file, not touching anything else.
 */

import {
  SCHEMA_VERSION, iso, stableKey, convId, spliceParents,
  makeHttp, summarize, sleep, RATE_MS, inspectUrl, urlShape,
} from './shared.js';

/**
 * ChatGPT content types that are internal plumbing rather than conversation.
 * Its own UI never shows these as prose; rendering them as prose dumps raw
 * tool scaffolding into the transcript.
 */
const INTERNAL_TYPES = new Set([
  'tether_browsing_display',
  'tether_browsing_code',
  'tether_quote',
  'sonic_webpage',
  'system_error',
  'user_editable_context',
  'model_editable_context',
]);

/**
 * Strip ChatGPT's inline markers.
 *
 * Citations and media directives are delimited by private-use characters
 * (U+E200 start, U+E202 separator, U+E201 end) that are invisible but carry
 * payloads like `cite turn0search2` or `filecite turn0file0L5-L8`. The web UI
 * consumes them and renders footnotes; anything else shows the raw payload
 * glued into the sentence.
 *
 * This is transport markup, not content, so it is removed at capture time.
 * `url` markers are the exception — they carry a real title and href, so they
 * become ordinary Markdown links instead of being dropped.
 */
export function stripChatgptMarkup(s) {
  if (typeof s !== 'string' || !s) return s;
  return s
    .replace(/([\s\S]*?)/g, (_, inner) => {
      const parts = inner.split(/[]/).filter(Boolean);
      const kind = (parts[0] || '').trim();
      if (kind === 'url' && parts.length >= 2) {
        const href = parts.find((p) => /^https?:\/\//.test(p.trim()));
        const title = parts.slice(1).find((p) => !/^https?:\/\//.test(p.trim()));
        if (href) return `[${(title || href).trim()}](${href.trim()})`;
      }
      return ''; // cite, filecite, video, navlist, image_group, …
    })
    // Any stray delimiters, plus marker payloads that arrived unwrapped.
    .replace(/[-]/g, '')
    .replace(/\b(?:file)?cite(?:turn\d+\w+?\d+(?:L\d+(?:-L\d+)?)?)+/g, '')
    .replace(/\bturn\d+(?:search|file|view|news|image|youtube|video)\d+(?:L\d+(?:-L\d+)?)?/g, '')
    // Line-level directives the UI renders as widgets. Remove the whole line,
    // newline included, so they leave no gap behind.
    .replace(/^[ \t]*image_group\{[\s\S]*?\}[ \t]*\n?/gm, '')
    .replace(/^[ \t]*navlist\b.*\n?/gm, '')
    // ::: fences wrap a real document; keep the contents, drop the fence.
    .replace(/^[ \t]*:::\w+\{[^\n}]*\}[ \t]*\n?/gm, '')
    .replace(/^[ \t]*:::[ \t]*\n?/gm, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const chatgpt = {
  id: 'chatgpt',
  label: 'ChatGPT',
  origin: 'https://chatgpt.com',
  hosts: ['chatgpt.com', 'chat.openai.com'],
  accent: '#10a37f',

  http: makeHttp('https://chatgpt.com'),

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
      facets: {
        // ChatGPT's list has no model — default_model_slug only appears in the
        // conversation detail, so grouping by model needs a fetch it does not
        // justify. A custom GPT is the nearest thing the list does expose.
        project: c.gizmo_id ? `GPT ${c.gizmo_id.slice(0, 12)}` : null,
        model: null,
        starred: !!c.is_starred,
        archived: !!c.is_archived,
      },
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
    const clean = stripChatgptMarkup;

    // Internal plumbing: keep whatever payload it carries as a tool result so
    // nothing is lost, but never as prose. Empty ones are pure UI scaffolding.
    if (INTERNAL_TYPES.has(c.content_type)) {
      const text = clean(c.result || c.summary || c.text || c.content || '');
      return text ? [{ type: 'tool_result', text, meta: { kind: c.content_type } }] : [];
    }

    // A tool-role message's text IS a tool result, whatever content_type it
    // claims. ChatGPT emits file-search dumps and citation instructions this
    // way, which read as gibberish if rendered as conversation.
    if (msg.author?.role === 'tool' && c.content_type === 'text') {
      const text = clean((c.parts || []).filter((p) => typeof p === 'string').join('\n'));
      return text
        ? [{ type: 'tool_result', text, meta: { kind: msg.author.name || 'tool' } }]
        : [];
    }

    switch (c.content_type) {
      case 'text':
        return (c.parts || [])
          .filter((p) => typeof p === 'string' && p.length)
          .map((p) => ({ type: 'text', text: clean(p) }))
          .filter((b) => b.text);

      case 'multimodal_text':
        return (c.parts || []).flatMap((p) => {
          if (typeof p === 'string') {
            const t = clean(p);
            return t ? [{ type: 'text', text: t }] : [];
          }
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
        const summaries = (c.thoughts || []).map((t) => clean(t.summary)).filter(Boolean);
        const text = (c.thoughts || []).map((t) => clean(t.content)).filter(Boolean).join('\n\n');
        const b = { type: 'thinking' };
        if (text) b.text = text;
        if (summaries.length) b.summaries = summaries;
        return b.text || b.summaries ? [b] : [];
      }

      case 'reasoning_recap': {
        const t = clean(c.content);
        return t ? [{ type: 'thinking', summaries: [t] }] : [];
      }

      default:
        return [{ type: c.content_type || 'unknown', meta: c }];
    }
  },

  /**
   * Uploaded files, which live on the message's metadata rather than in its
   * content — so a conversation where you attached a PDF showed no sign of it
   * at all until now.
   *
   * ChatGPT extracts no text (that is a Claude-only gift), so this is a
   * reference: the name, the type, and the id a backfill needs. Phase 0b
   * confirmed `/backend-api/files/{id}/download` returns those bytes exactly,
   * with the session.
   */
  attachments(msg) {
    return (msg.metadata?.attachments || []).map((a) => ({
      type: 'file',
      filename: a.name,
      mime: a.mime_type || null,
      srcRef: a.id ? `chatgpt-file://${a.id}` : null,
      meta: { declaredBytes: a.size ?? null, libraryFileId: a.library_file_id ?? null },
    }));
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
      const content = [...this.block(m), ...this.attachments(m)];
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

  /**
   * Are uploaded files and generated images retrievable?
   *
   * ChatGPT references assets two ways: `metadata.attachments[]` on a message,
   * and `asset_pointer: "file-service://file-…"` inside multimodal content.
   * Both are ids, not bytes. The open question is whether the download
   * endpoint hands back a URL this page is actually allowed to fetch — a
   * signed URL on another origin may well refuse, and that refusal is the
   * answer, not a failure.
   *
   * Reports statuses, sizes and hosts. Never a filename, never the signature
   * on a signed URL, never the bearer token.
   */
  async probeAssets(result, log = () => {}) {
    const list = await this.http.getJson('/backend-api/conversations?offset=0&limit=40&order=updated');
    const items = list.items || [];
    result.listCount = items.length;
    result.scanned = 0;
    result.messagesWithAttachments = 0;
    result.assetPointers = 0;

    let att = null, pointer = null;
    for (const c of items) {
      if (att && pointer) break;
      await sleep(RATE_MS);
      result.scanned++;
      log(`scanning ${result.scanned}…`);
      let d;
      try { d = await this.http.getJson(`/backend-api/conversation/${c.id}`); } catch { continue; }
      for (const node of Object.values(d.mapping || {})) {
        const m = node?.message;
        if (!m) continue;
        const a = m.metadata?.attachments;
        if (a?.length) { result.messagesWithAttachments++; att ||= a[0]; }
        for (const p of m.content?.parts || []) {
          if (p && typeof p === 'object' && p.content_type === 'image_asset_pointer') {
            result.assetPointers++;
            if (!pointer) { pointer = p; result.pointerConv = c.id; }
          }
        }
      }
    }

    result.attachments = att ? {
      keys: Object.keys(att).sort(),
      mime: att.mime_type || att.mimeType || null,
      declaredSize: att.size ?? att.fileTokenSize ?? null,
      hasLibraryId: 'library_file_id' in att,
    } : null;

    // The scheme is not a constant: "sediment://" turned up where the older
    // "file-service://" was assumed. Report it rather than assume it.
    const pointerId = String(pointer?.asset_pointer || '').split('://').pop() || null;
    result.pointer = pointer ? {
      keys: Object.keys(pointer).sort(),
      scheme: String(pointer.asset_pointer || '').split('://')[0] || null,
      idShape: pointerId ? pointerId.replace(/[A-Za-z0-9]{8,}/g, '{id}') : null,
      declared: { w: pointer.width, h: pointer.height, bytes: pointer.size_bytes ?? null },
    } : null;

    // The actual question: does an id turn into bytes?
    const id = att?.id || String(pointer?.asset_pointer || '').split('://').pop();
    result.download = { triedId: Boolean(id) };
    if (id) {
      await sleep(RATE_MS);
      try {
        const d = await this.http.getJson(`/backend-api/files/${id}/download`);
        result.download.endpointOk = true;
        result.download.keys = Object.keys(d).sort();
        const url = d.download_url || d.url || null;
        result.download.hasUrl = Boolean(url);
        if (url) {
          // Origin only. The query string may be a signature.
          result.download.host = (() => { try { return new URL(url).origin; } catch { return '(unparseable)'; } })();
          result.download.crossOrigin = result.download.host !== location.origin;

          // Try the session first. The first run of this probe assumed a
          // signed URL on someone else's origin and sent no cookies, which
          // earned a 403 that looked like the provider refusing — when it was
          // the probe refusing to identify itself. The URL is same-origin.
          await sleep(RATE_MS);
          result.download.fetched = await this.http.inspect(url, { credentials: 'include' });
          if (!result.download.fetched.ok) {
            await sleep(RATE_MS);
            result.download.withToken = await this.http.inspect(url, {
              credentials: 'include', withAuth: true,
            });
            await sleep(RATE_MS);
            result.download.anonymous = await this.http.inspect(url, { credentials: 'omit' });
          }
        }
      } catch (e) {
        result.download.endpointOk = false;
        result.download.error = e.message;
      }
    }

    // A generated image is a different kind of asset from an upload, and the
    // uploads endpoint refuses its id. These are CANDIDATE routes, tried once
    // each against one of your own images, to find which one answers — nothing
    // here is a known endpoint, and a 403 or 404 is a result, not an error.
    if (pointerId && pointerId !== id) {
      const conv = result.pointerConv;
      const candidates = [
        ['download', `/backend-api/files/${pointerId}/download`],
        ['bare', `/backend-api/files/${pointerId}`],
        ...(conv ? [
          ['scoped', `/backend-api/files/${pointerId}/download?conversation_id=${conv}`],
          ['convAttachment', `/backend-api/conversation/${conv}/attachment/${pointerId}/download`],
        ] : []),
      ];
      result.pointerRoutes = {};
      for (const [name, path] of candidates) {
        await sleep(RATE_MS);
        try {
          const d = await this.http.getJson(path);
          const url = d.download_url || d.url || null;
          result.pointerRoutes[name] = { ok: true, keys: Object.keys(d).sort(), hasUrl: Boolean(url) };
          if (url) {
            await sleep(RATE_MS);
            result.pointerRoutes[name].fetched = await this.http.inspect(url, { credentials: 'include' });
          }
        } catch (e) {
          result.pointerRoutes[name] = { ok: false, error: e.message };
        }
      }
      // Whatever the routes say, the pointer's own metadata may already carry
      // the answer. Shape only — summarize redacts the values.
      result.pointerMeta = summarize(pointer.metadata ?? null, 'metadata');
    }
    return result;
  },
};
