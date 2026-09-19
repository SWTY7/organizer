/* ==========================================================================
   Everything in a conversation that is not prose: code, tables, images,
   files, tool calls, links. The Gallery template shows these as a grid, each
   with a way back to the exchange it came from.

   Code and tables usually arrive inside markdown text rather than as blocks
   of their own, so they are found there too — otherwise a ChatGPT reply,
   which puts everything in one text block, would show an empty gallery.

   Pure: turns in, plain items out.
   ========================================================================== */

export const KINDS = {
  code: 'Code',
  table: 'Tables',
  image: 'Images',
  file: 'Files',
  tool: 'Tool calls',
  link: 'Links',
};

const FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*([^\s`]*)[^\n]*\n([\s\S]*?)\n?^\1\2[ \t]*$/gm;
const MDLINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
const BARE = /(?<![(\[<"'])\bhttps?:\/\/[^\s<>()"'\]]+[^\s<>()"'\].,;:!?]/g;

/** Markdown tables in a text: a header row, a |---| row, and the rows after. */
export function tables(text) {
  const lines = String(text ?? '').split('\n');
  const out = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!/^\s*\|.*\|\s*$/.test(lines[i]) || !/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[i + 1])) continue;
    let j = i + 2;
    while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j])) j++;
    const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    out.push({ text: lines.slice(i, j).join('\n'), columns: cells(lines[i]), rows: j - i - 2 });
    i = j - 1;
  }
  return out;
}

/** Fenced code in a text, with its language. */
export function fences(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(FENCE)) out.push({ lang: m[3] || '', text: m[4] });
  return out;
}

/** Links, markdown and bare, each URL once per text, fenced code ignored. */
export function links(text) {
  const prose = String(text ?? '').replace(FENCE, '');
  const out = new Map();
  for (const m of prose.matchAll(MDLINK)) if (!out.has(m[2])) out.set(m[2], m[1]);
  for (const m of prose.replace(MDLINK, '').matchAll(BARE)) if (!out.has(m[0])) out.set(m[0], '');
  return [...out].map(([url, title]) => ({ url, title }));
}

/**
 * @returns {{kind: string, turn: number, role: string, lang?: string,
 *   title?: string, text?: string, url?: string, rows?: number, columns?: string[],
 *   isError?: boolean}[]}
 *   In conversation order. `turn` is the index into `turns`.
 */
export function items(turns) {
  const out = [];
  turns.forEach((t, turn) => {
    for (const m of [t.user, ...t.replies].filter(Boolean)) {
      const role = m.role;
      const add = (x) => out.push({ turn, role, ...x });
      const seen = new Set(); // one link, once per message
      for (const b of m.content || []) {
        switch (b.type) {
          case 'text':
            for (const f of fences(b.text)) add({ kind: 'code', lang: f.lang, text: f.text });
            for (const tb of tables(b.text)) add({ kind: 'table', ...tb });
            for (const l of links(b.text)) if (!seen.has(l.url)) { seen.add(l.url); add({ kind: 'link', ...l }); }
            break;
          case 'code':
            add({ kind: 'code', lang: b.lang || '', text: b.text || '' });
            break;
          case 'image':
            add({ kind: 'image', title: b.filename || 'Image', width: b.width, height: b.height });
            break;
          case 'file':
            add({ kind: 'file', title: b.filename || 'File', text: b.text || '' });
            break;
          case 'tool_use':
            add({ kind: 'tool', title: b.name || 'tool', text: b.text || (b.input != null ? JSON.stringify(b.input, null, 2) : '') });
            break;
          case 'tool_result':
            add({ kind: 'tool', title: b.isError ? 'Result · error' : 'Result', text: b.text || '', isError: !!b.isError });
            break;
          case 'citation':
            if (b.url && !seen.has(b.url)) { seen.add(b.url); add({ kind: 'link', url: b.url, title: b.title || '' }); }
            break;
          default: break;
        }
      }
    }
  });
  return out;
}

/** How many of each kind, for the filter. */
export function counts(list) {
  const c = {};
  for (const x of list) c[x.kind] = (c[x.kind] || 0) + 1;
  return c;
}
