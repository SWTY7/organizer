/* ==========================================================================
   Turning a message path into something you can skim.

   Pure: takes the messages of one conversation path, returns plain data. No
   DOM, no storage. The renderer decides what to draw with it.
   ========================================================================== */

/**
 * Group a linear path into turns — a user message and the replies to it.
 *
 * A "turn" is not a message. One question can draw an assistant message, three
 * tool calls and a second assistant message, and all of that is one thing you
 * either want to read or want to skip.
 */
export function turns(messages) {
  const out = [];
  for (const m of messages) {
    // A path that opens with an assistant message still needs a turn to live
    // in — a captured branch can start anywhere.
    if (m.role === 'user' || !out.length) out.push({ user: m.role === 'user' ? m : null, replies: [] });
    if (m.role !== 'user') out[out.length - 1].replies.push(m);
  }
  return out;
}

const words = (s) => (String(s ?? '').trim().match(/\S+/g) || []).length;

/** What is in these messages, for the one line that stands in for them. */
export function stats(messages) {
  const s = { words: 0, code: 0, image: 0, file: 0, tool: 0, thoughts: 0 };
  for (const m of messages) {
    for (const b of m.content || []) {
      switch (b.type) {
        case 'text': s.words += words(b.text); break;
        case 'code': s.code++; break;
        case 'image': s.image++; break;
        case 'file': s.file++; break;
        case 'tool_use': case 'tool_result': s.tool++; break;
        case 'thinking': s.thoughts += (b.summaries || []).length || 1; break;
        default: break;
      }
    }
  }
  return s;
}

/** The stats worth showing, in a fixed order, skipping whatever is zero. */
export function badges(s) {
  const out = [];
  if (s.code) out.push(`${s.code} code`);
  if (s.image) out.push(`${s.image} image${s.image > 1 ? 's' : ''}`);
  if (s.file) out.push(`${s.file} file${s.file > 1 ? 's' : ''}`);
  if (s.tool) out.push(`${s.tool} tool`);
  if (s.thoughts) out.push(`thought ${s.thoughts} step${s.thoughts > 1 ? 's' : ''}`);
  if (s.words) out.push(`${s.words} word${s.words > 1 ? 's' : ''}`);
  return out;
}

/** Markdown decoration, removed. A preview line should read as plain prose. */
export function plain(line) {
  return String(line ?? '')
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s{0,3}>\s?/, '')
    .replace(/^\s{0,3}[-*+]\s+/, '')
    .replace(/^\s{0,3}\d+[.)]\s+/, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\W)\*([^*\n]+)\*/g, '$1$2')
    .replace(/\[([^\]]+)\]\([^)\s]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Cut at a word boundary rather than mid-word, and say that it was cut. */
export function clip(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.]+$/, '')}…`;
}

/**
 * The first sentence of the first prose in a set of messages — the line that
 * stands in for a reply you have collapsed.
 *
 * Fenced code is skipped: a reply that opens with a code block is summarised by
 * the prose after it, not by its first line of source.
 *
 * A leading heading is held as a fallback rather than returned. Models open
 * with a heading that restates the question — "## Entropy" under "explain
 * entropy" tells you nothing you did not just read.
 */
export function gist(messages, max = 200) {
  let heading = '';
  for (const m of messages) {
    for (const b of m.content || []) {
      if (b.type !== 'text' || !b.text) continue;
      for (const raw of String(b.text).split('\n')) {
        const line = plain(raw);
        if (!line || /^[-*_]{3,}$/.test(line)) continue;
        if (/^\s{0,3}#{1,6}\s+/.test(raw)) { heading ||= line; continue; }
        const end = line.match(/^[\s\S]*?[.!?](?=\s|$)/);
        return clip(end ? end[0] : line, max);
      }
    }
  }
  return heading ? clip(heading, max) : '';
}

/** Markdown headings inside a reply — the structure the model already wrote. */
export function headings(messages, max = 6) {
  const out = [];
  for (const m of messages) {
    for (const b of m.content || []) {
      if (b.type !== 'text' || !b.text) continue;
      for (const raw of String(b.text).split('\n')) {
        const h = raw.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
        if (h) out.push({ depth: h[1].length, text: plain(h[2]) });
        if (out.length >= max) return out;
      }
    }
  }
  return out;
}

/**
 * One bar per message for the navigation ribbon.
 *
 * Weight is the square root of the length: a 4000-word answer is bigger than a
 * 100-word one, but not forty times bigger, or it swallows the whole strip and
 * the ribbon stops being a map.
 */
export function ribbon(messages) {
  return messages.map((m) => {
    const s = stats([m]);
    const size = s.words + s.code * 40 + s.tool * 20;
    return {
      id: m.id,
      role: m.role,
      weight: Math.max(1, Math.sqrt(size)),
      code: !!s.code,
      media: !!(s.image || s.file),
      thought: !!s.thoughts,
      tool: !!s.tool,
    };
  });
}

/**
 * Which bar the ribbon should mark, given each message's offset from the top
 * of the viewport.
 *
 * Not "nearest to the top": that flips to the next message as soon as its
 * heading appears, while you are still reading the previous one. The right
 * answer is the last message that has already started — the one covering the
 * top edge — with the first as the fallback before anything has scrolled.
 */
export function activeIndex(tops, at = 0, slack = 4) {
  let best = 0;
  for (let i = 0; i < tops.length; i++) {
    if (Number.isFinite(tops[i]) && tops[i] <= at + slack) best = i;
  }
  return best;
}
