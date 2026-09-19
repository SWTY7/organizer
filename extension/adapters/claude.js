/**
 * Adapter: claude.ai
 *
 * Everything provider-specific about Claude lives here. Adding another LLM
 * means writing a sibling of this file, not touching anything else.
 */

import {
  SCHEMA_VERSION, iso, stableKey, convId, spliceParents,
  makeHttp, summarize, sleep, RATE_MS, inspectUrl, urlShape,
} from './shared.js';

/** Claude uses a sentinel uuid for "no parent" rather than null. */
const ROOT_SENTINEL = '00000000-0000-4000-8000-000000000000';

export const claude = {
  id: 'claude',
  label: 'Claude',
  origin: 'https://claude.ai',
  hosts: ['claude.ai'],
  accent: '#c96442',

  http: makeHttp('https://claude.ai'),

  /** @type {string|null} */
  orgId: null,

  async init() {
    const orgs = await this.http.getJson('/api/organizations');
    if (!Array.isArray(orgs) || !orgs.length) throw new Error('no organizations — logged in?');
    // An account can hold several orgs; the API/console one has no chat at all.
    // Selecting by index is a latent bug, so select by capability.
    const chatOrg = orgs.find(
      (o) => Array.isArray(o.capabilities) && o.capabilities.includes('chat')
    ) || orgs[0];
    this.orgId = chatOrg.uuid;
    return { orgId: this.orgId, orgName: chatOrg.name, orgCount: orgs.length };
  },

  async list() {
    const raw = await this.http.getJson(`/api/organizations/${this.orgId}/chat_conversations`);
    return raw.map((c) => ({
      id: c.uuid,
      title: c.name,
      updatedAt: c.updated_at,
      // Claude's list is rich enough to group by without any detail fetch.
      facets: {
        project: c.project?.name || (c.project_uuid ? '(unnamed project)' : null),
        model: c.model || null,
        starred: !!c.is_starred,
        archived: false,
      },
      _raw: c,
    }));
  },

  async detail(id) {
    // These query params are MANDATORY. Without them the response carries no
    // content[] at all — only a flattened text string — and every thinking
    // block is silently lost.
    return this.http.getJson(
      `/api/organizations/${this.orgId}/chat_conversations/${id}` +
      `?tree=True&rendering_mode=messages`
    );
  },

  async projects() {
    return this.http.getJson(`/api/organizations/${this.orgId}/projects`);
  },

  currentId() {
    const m = location.pathname.match(/\/chat\/([0-9a-f-]{36})/i);
    return m ? m[1] : null;
  },

  // ------------------------------------------------------------- conversion

  /**
   * One Claude content[] entry -> zero or more canonical blocks.
   * @returns {object[]}
   */
  block(c) {
    switch (c.type) {
      case 'text':
        return [{
          type: 'text',
          text: c.text || '',
          ...(c.citations?.length ? { citations: c.citations } : {}),
        }];

      case 'thinking': {
        // The real payload is usually summaries[]; .thinking is routinely "".
        // Reading only .thinking captures nothing while appearing to work.
        const summaries = (c.summaries || []).map((s) => s.summary).filter(Boolean);
        const b = { type: 'thinking' };
        if (c.thinking) b.text = c.thinking;
        if (summaries.length) b.summaries = summaries;
        if (c.cut_off) b.cutOff = true;
        return b.text || b.summaries ? [b] : [];
      }

      case 'tool_use':
        return [{ type: 'tool_use', name: c.name || 'tool', input: c.input, id: c.id }];

      case 'tool_result':
        return [{
          type: 'tool_result',
          text: typeof c.content === 'string' ? c.content : undefined,
          toolUseId: c.tool_use_id,
          isError: !!c.is_error,
        }];

      default:
        // Forward compatibility: keep unknown types rather than dropping them.
        return [{ type: c.type || 'unknown', meta: c }];
    }
  },

  /**
   * Images and other `files[]`: URLs needing a second authenticated fetch.
   *
   * `preview_url` was confirmed in Phase 0b to serve the image at full
   * declared resolution, not a downscale — `thumbnail_url` is the small one.
   */
  files(msg) {
    return (msg.files || []).map((f) => ({
      type: (f.file_kind || '').toLowerCase() === 'image' ? 'image' : 'file',
      srcRef: f.preview_url || f.thumbnail_url || null,
      filename: f.file_name,
      width: f.preview_asset?.image_width,
      height: f.preview_asset?.image_height,
      meta: { fileUuid: f.file_uuid, thumbRef: f.thumbnail_url || null },
    }));
  },

  /**
   * Uploaded documents, whose text is already here.
   *
   * `attachments[]` is a separate list from `files[]`, and it carries
   * `extracted_content` — the plain text Claude read out of the upload. No
   * second fetch, no bytes to store, and it makes every document you have
   * attached searchable. This was being discarded: the converter read `files`
   * and nothing else.
   *
   * `declaredBytes` sits next to the text so a later check can tell a complete
   * extraction from a truncated one. The two are not directly comparable — one
   * counts characters, the other bytes — so nothing here claims the text is
   * complete.
   */
  attachments(msg) {
    return (msg.attachments || []).map((a) => ({
      type: 'file',
      filename: a.file_name,
      mime: a.file_type || null,
      ...(typeof a.extracted_content === 'string' && a.extracted_content
        ? { text: a.extracted_content }
        : {}),
      meta: { attachmentId: a.id, declaredBytes: a.file_size ?? null },
    }));
  },

  /**
   * The bytes behind an image block, for a capture that keeps attachments.
   *
   * Images only. `preview_url` is the full-resolution image (Phase 0b), on the
   * session cookies alone. A document's `files[]` entry has only a thumbnail
   * of its first page, which is not the document — and its text already
   * arrived through `attachments[]` — so documents are not fetched.
   */
  async fetchAsset(b) {
    if (b.type !== 'image' || !b.srcRef) return null;
    return this.http.bytes(b.srcRef);
  },

  async convert(d, listItem) {
    const raw = d.chat_messages || [];

    // Parent links for EVERY raw node, including ones we end up dropping, so
    // survivors can be reattached to their nearest surviving ancestor.
    const parentOf = new Map();
    for (const m of raw) {
      const p = m.parent_message_uuid;
      parentOf.set(m.uuid, p && p !== ROOT_SENTINEL ? p : null);
    }

    const messages = [];
    for (const m of raw) {
      let content = [];
      for (const c of m.content || []) content.push(...this.block(c));
      content.push(...this.files(m));
      content.push(...this.attachments(m));
      // ?tree=True should always give content[]; fall back to the flat string.
      if (!content.length && m.text) content = [{ type: 'text', text: m.text }];
      if (!content.length) continue;

      messages.push({
        id: m.uuid,
        parentId: null, // set by spliceParents below
        role: m.sender === 'human' ? 'user'
          : m.sender === 'assistant' ? 'assistant'
          : m.sender,
        createdAt: iso(m.created_at),
        model: null, // Claude reports model per conversation, not per message
        stableKey: await stableKey('claude', d.uuid, m.uuid),
        ...(m.stop_reason ? { stopReason: m.stop_reason } : {}),
        status: 'complete',
        hidden: false,
        content,
      });
    }
    spliceParents(messages, parentOf);

    return {
      schemaVersion: SCHEMA_VERSION,
      kind: 'conversation',
      id: await convId('claude', d.uuid),
      provider: 'claude',
      providerConvId: d.uuid,
      title: d.name || '(untitled)',
      createdAt: iso(d.created_at),
      updatedAt: iso(d.updated_at),
      model: d.model || null,
      sourceUrl: `https://claude.ai/chat/${d.uuid}`,
      currentLeafId: d.current_leaf_message_uuid || null,
      ...(d.summary ? { summary: d.summary } : {}),
      starred: !!d.is_starred,
      ...(d.project_uuid ? {
        projectRef: {
          id: d.project_uuid,
          name: listItem?._raw?.project?.name ?? null,
        },
      } : {}),
      messages,
    };
  },

  // -------------------------------------------------------------- diagnostics

  /** Extra checks the probe reports for this provider. */
  async probe(result) {
    const listRaw = await this.http.getJson(`/api/organizations/${this.orgId}/chat_conversations`);
    result.listCount = listRaw.length;
    result.listItemKeys = listRaw.length ? Object.keys(listRaw[0]).sort() : [];
    result.listShape = summarize(listRaw.slice(0, 2), 'list');
    const updKey = result.listItemKeys.find((k) => /updated?_?at/i.test(k));
    result.deltaSyncViable = Boolean(updKey);
    result.deltaSyncKey = updKey || null;

    const first = listRaw[0];
    if (first) {
      result.detail = {};
      // Compare both variants: without the query params there is no content[].
      for (const v of [
        { name: 'tree', qs: '?tree=True&rendering_mode=messages' },
        { name: 'plain', qs: '' },
      ]) {
        const d = await this.http.getJson(
          `/api/organizations/${this.orgId}/chat_conversations/${first.uuid}${v.qs}`
        );
        const msgs = d.chat_messages || [];
        const keys = msgs.length ? Object.keys(msgs[0]) : [];
        const types = new Set(), senders = new Set();
        for (const m of msgs) {
          if (m.sender) senders.add(m.sender);
          for (const c of m.content || []) if (c?.type) types.add(c.type);
        }
        result.detail[v.name] = {
          topLevelKeys: Object.keys(d).sort(),
          messageCount: msgs.length,
          messageKeys: keys.sort(),
          parentKey: keys.find((k) => /parent/i.test(k)) || null,
          contentTypes: [...types],
          senders: [...senders],
          shape: summarize(d, 'conversation'),
        };
      }
    }

    const projects = await this.http.getJson(`/api/organizations/${this.orgId}/projects`);
    result.projectCount = Array.isArray(projects) ? projects.length : null;
    result.projectsShape = summarize(projects, 'projects');
    return result;
  },

  /**
   * Are uploaded files retrievable, and is document text already in hand?
   *
   * Two separate questions. `files[]` holds images and needs a second fetch;
   * `attachments[]` may hold `extracted_content`, the plain text of an
   * uploaded document — which would already be arriving in every payload that
   * the converter currently ignores.
   *
   * Reports sizes, types and URL shapes. Never a filename, never a byte of
   * content, so the output stays shareable.
   */
  async probeAssets(result, log = () => {}) {
    const list = await this.http.getJson(`/api/organizations/${this.orgId}/chat_conversations`);
    result.listCount = list.length;
    result.scanned = 0;
    result.messagesWithFiles = 0;
    result.messagesWithAttachments = 0;

    let file = null, att = null;
    for (const c of list.slice(0, 40)) {
      if (file && att) break;
      await sleep(RATE_MS);
      result.scanned++;
      log(`scanning ${result.scanned}…`);
      let d;
      try {
        d = await this.http.getJson(
          `/api/organizations/${this.orgId}/chat_conversations/${c.uuid}?tree=True&rendering_mode=messages`);
      } catch { continue; }
      for (const m of d.chat_messages || []) {
        if (m.files?.length) { result.messagesWithFiles++; file ||= m.files[0]; }
        if (m.attachments?.length) { result.messagesWithAttachments++; att ||= m.attachments[0]; }
      }
    }

    // Q1: does an attachment already carry the document's text?
    result.attachments = att ? {
      keys: Object.keys(att).sort(),
      hasExtractedContent: typeof att.extracted_content === 'string',
      extractedChars: typeof att.extracted_content === 'string' ? att.extracted_content.length : null,
      fileType: att.file_type || null,
      declaredSize: att.file_size ?? null,
    } : null;

    // Q2: is preview_url the original, or a downscaled preview?
    if (file) {
      result.files = {
        keys: Object.keys(file).sort(),
        kind: file.file_kind || null,
        declared: file.preview_asset
          ? { w: file.preview_asset.image_width, h: file.preview_asset.image_height }
          : null,
        previewShape: urlShape(file.preview_url),
        thumbnailShape: urlShape(file.thumbnail_url),
      };
      for (const which of ['preview_url', 'thumbnail_url']) {
        if (!file[which]) continue;
        await sleep(RATE_MS);
        result.files[which] = await inspectUrl(new URL(file[which], location.origin).href);
      }
    } else {
      result.files = null;
    }
    return result;
  },
};
