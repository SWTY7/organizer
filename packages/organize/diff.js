/* ==========================================================================
   What changed between two versions of a message — a regenerate and the
   reply it replaced, or a question and its edit.

   Word level, because that is the level people rewrite at: a diff by line
   marks a whole paragraph changed when one word was, and a diff by character
   shreds words into fragments nobody can read.

   Pure. Returns runs of text marked equal, removed or added; joining the
   equal and removed runs gives back the first text exactly, and joining the
   equal and added runs gives back the second.
   ========================================================================== */

/** Words, and the spaces and punctuation between them, losslessly. */
export const tokens = (s) => String(s ?? '').match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) || [];

/**
 * @returns {{ops: {op: '='|'-'|'+', text: string}[], same: number}}
 *   `same` is the share of the longer text that is unchanged, 0 to 1 — so a
 *   caller can say "these have almost nothing in common" rather than drawing
 *   a diff that is one long deletion followed by one long insertion.
 */
export function diffWords(first, second, { maxCells = 4_000_000 } = {}) {
  const A = tokens(first), B = tokens(second);

  // Most regenerates share an opening or an ending; aligning only the middle
  // keeps the table small.
  let p = 0;
  while (p < A.length && p < B.length && A[p] === B[p]) p++;
  let q = 0;
  while (q < A.length - p && q < B.length - p && A[A.length - 1 - q] === B[B.length - 1 - q]) q++;
  const a = A.slice(p, A.length - q), b = B.slice(p, B.length - q);

  const raw = [];
  const push = (op, text) => { if (text) raw.push({ op, text }); };
  push('=', A.slice(0, p).join(''));

  const n = a.length, m = b.length;
  if (n * m > maxCells) {
    // Too long to align word by word in reasonable time and memory. Saying
    // "all of this changed" is honest; a slow tab is not.
    push('-', a.join(''));
    push('+', b.join(''));
  } else {
    // Longest common subsequence, suffix table, then one walk forward.
    const w = m + 1;
    const L = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        L[i * w + j] = a[i] === b[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { push('=', a[i]); i++; j++; }
      else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) push('-', a[i++]);
      else push('+', b[j++]);
    }
    while (i < n) push('-', a[i++]);
    while (j < m) push('+', b[j++]);
  }
  push('=', A.slice(A.length - q).join(''));

  const ops = tidy(raw);
  const same = ops.filter((o) => o.op === '=').reduce((k, o) => k + o.text.length, 0);
  const longer = Math.max(1, A.join('').length, B.join('').length);
  return { ops, same: same / longer };
}

/**
 * Merge runs, and stop a lone space or comma from counting as "unchanged"
 * between two edits — otherwise a rewritten sentence reads as a dozen
 * one-word changes stitched together by the spaces they happened to share.
 * Within each changed stretch, everything removed comes before everything
 * added, which is how people read a correction.
 */
function tidy(raw) {
  const minor = (o) => o.op === '=' && /^[\s\p{P}]{0,2}$/u.test(o.text) && !/\n/.test(o.text);
  const out = [];
  let del = '', ins = '';
  const flush = () => {
    if (del) out.push({ op: '-', text: del });
    if (ins) out.push({ op: '+', text: ins });
    del = ''; ins = '';
  };
  for (let k = 0; k < raw.length; k++) {
    const o = raw[k];
    if (o.op === '-') del += o.text;
    else if (o.op === '+') ins += o.text;
    else if ((del || ins) && minor(o) && raw[k + 1] && raw[k + 1].op !== '=') { del += o.text; ins += o.text; }
    else {
      flush();
      const last = out[out.length - 1];
      if (last?.op === '=') last.text += o.text; else out.push({ op: '=', text: o.text });
    }
  }
  flush();
  return out;
}
