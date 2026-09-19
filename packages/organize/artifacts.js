/* ==========================================================================
   Artifacts, rebuilt from the edits that made them.

   A Claude artifact never appears in a conversation as a document. It arrives
   as a run of tool calls — create it, then update this string, then rewrite
   it — scattered across replies. The reader could show each call, but not
   the thing they add up to. Replaying them in order gives it back.

   Two tool shapes are understood:
     artifacts          { command: create | update | rewrite, id, title,
                          type, language, content, old_str, new_str }
     file editing       create_file { path, file_text }, str_replace
                          { path, old_str, new_str }, and the combined
                          str_replace_editor / str_replace_based_edit_tool
                          with a `command` field.

   An edit whose old text cannot be found is counted, not guessed at: the
   document is shown as far as it could be rebuilt, and says how many edits
   did not apply.

   Pure: turns in, documents out. Only the path you are reading is replayed,
   so another branch's edits do not leak into this one's result.
   ========================================================================== */

const EXT_LANG = {
  js: 'javascript', jsx: 'jsx', ts: 'typescript', tsx: 'tsx', py: 'python', rs: 'rust', go: 'go',
  rb: 'ruby', java: 'java', c: 'c', h: 'c', cpp: 'cpp', cs: 'csharp', sh: 'bash', md: 'markdown',
  html: 'html', htm: 'html', svg: 'svg', css: 'css', json: 'json', yml: 'yaml', yaml: 'yaml',
  sql: 'sql', txt: '', tex: 'latex', mermaid: 'mermaid',
};

/** What kind of thing an artifact is, from its declared type or its file name. */
export function kindOf(type, lang, name = '') {
  const t = String(type || '').toLowerCase();
  const ext = (String(name).match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
  if (t.includes('svg') || ext === 'svg' || lang === 'svg') return 'svg';
  if (t === 'text/html' || ext === 'html' || ext === 'htm' || lang === 'html') return 'html';
  if (t.includes('react') || ext === 'jsx' || ext === 'tsx') return 'react';
  if (t.includes('mermaid') || ext === 'mermaid') return 'mermaid';
  if (t === 'text/markdown' || ext === 'md') return 'markdown';
  return 'code';
}

const FILE_TOOLS = new Set(['create_file', 'str_replace', 'str_replace_editor', 'str_replace_based_edit_tool', 'text_editor']);

/** One tool call as a normalised edit, or null if it is not one. */
export function editOf(b) {
  if (b?.type !== 'tool_use' || !b.input || typeof b.input !== 'object') return null;
  const i = b.input;
  if (b.name === 'artifacts') {
    if (!i.id) return null;
    const cmd = i.command || (i.content != null ? 'create' : i.new_str != null ? 'update' : null);
    return {
      key: i.id, cmd: cmd === 'rewrite' ? 'create' : cmd,
      title: i.title, type: i.type, lang: i.language,
      content: i.content, oldStr: i.old_str, newStr: i.new_str,
    };
  }
  if (FILE_TOOLS.has(b.name) && i.path) {
    const cmd = b.name === 'create_file' ? 'create'
      : b.name === 'str_replace' ? 'update'
        : i.command === 'create' ? 'create' : i.command === 'str_replace' ? 'update'
          : i.command === 'insert' ? 'insert' : null;
    if (!cmd) return null;
    const name = String(i.path).split('/').pop();
    const ext = (name.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
    return {
      key: i.path, cmd, title: name, lang: EXT_LANG[ext] ?? ext ?? '',
      content: i.file_text ?? i.content, oldStr: i.old_str, newStr: i.new_str ?? i.insert_text,
      line: i.insert_line,
    };
  }
  return null;
}

/**
 * @returns {{key, title, type, lang, kind, content, turn, firstTurn, edits,
 *   failed, versions: {turn, content}[]}[]} in order of creation.
 */
export function artifacts(turns) {
  const docs = new Map();
  turns.forEach((t, turn) => {
    for (const m of t.replies) {
      for (const b of m.content || []) {
        const e = editOf(b);
        if (!e || !e.cmd) continue;
        let d = docs.get(e.key);
        if (!d) {
          d = { key: e.key, title: e.title || e.key, type: e.type || '', lang: e.lang || '', content: '',
            turn, firstTurn: turn, edits: 0, failed: 0, versions: [] };
          docs.set(e.key, d);
        }
        if (e.title) d.title = e.title;
        if (e.type) d.type = e.type;
        if (e.lang) d.lang = e.lang;

        if (e.cmd === 'create') {
          d.content = String(e.content ?? '');
        } else if (e.cmd === 'update') {
          const from = String(e.oldStr ?? '');
          const at = from ? d.content.indexOf(from) : -1;
          if (at < 0) { d.failed++; continue; }
          d.content = d.content.slice(0, at) + String(e.newStr ?? '') + d.content.slice(at + from.length);
        } else if (e.cmd === 'insert') {
          const lines = d.content.split('\n');
          const n = Math.max(0, Math.min(Number(e.line) || 0, lines.length));
          lines.splice(n, 0, String(e.newStr ?? ''));
          d.content = lines.join('\n');
        }
        d.edits++;
        d.turn = turn;
        d.versions.push({ turn, content: d.content });
      }
    }
  });
  return [...docs.values()].map((d) => ({ ...d, kind: kindOf(d.type, d.lang, d.key) }));
}
