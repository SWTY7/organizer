/* ==========================================================================
   Suggested sections: a guess at where one topic ends and the next begins.

   Offline and deterministic — no model, no network, the same answer every
   time for the same conversation. Each question is scored for "does this
   open something new, or carry on from the last exchange", from signals that
   are cheap and legible:

     a long pause before it                     new topic
     opens like a follow-up (and, but, what about…)   carries on
     opens with a bare pronoun (it, that, this…)       carries on, strongly
     very short                                  carries on
     shares little vocabulary with the exchange before it   new topic
     mostly words the conversation has not used yet         new topic

   It will be wrong sometimes. That is acceptable only because what it
   produces is shown as a guess, never applied on its own, and keeping or
   dismissing each one is a click (see READING.md, "Suggested").
   ========================================================================== */

import { turnKey } from './sections.js';

const STOP = new Set(`a an the and or but if then so of to in on at by for with from as is are was were be been
being it its this that these those there here what which who whom whose when where why how can could would should
will shall may might must do does did done have has had having i me my we our you your he she they them their not no
yes all any some more most such than too very just also about into over under again further once only own same both
each few other out up down off now get got make made like want need know think tell give show let use using used
please thanks thank explain describe okay ok really one two way thing things something`.split(/\s+/));

/** The words that carry meaning, lowercased. */
export function terms(text) {
  return (String(text ?? '').toLowerCase().match(/[\p{L}][\p{L}\p{N}'_-]{2,}/gu) || [])
    .map((w) => w.replace(/'s$/, ''))
    .filter((w) => !STOP.has(w));
}

const FOLLOW = /^(and|but|also|so|then|instead|again|or|no,|nope|wait|hmm|ok(ay)?\b|thanks|what about|how about|what if|can you|could you|why)\b/i;
const PRONOUN = /^(it|that|this|they|those|these|he|she|its|it's|that's)\b/i;

const textOf = (m) => (m?.content || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('\n');
const time = (m) => (m?.createdAt ? Date.parse(m.createdAt) : NaN);

/**
 * Score every question after the first.
 * @returns {{index: number, key: string, score: number, reasons: string[]}[]}
 */
export function score(turns) {
  const seen = new Set();
  const out = [];
  turns.forEach((t, i) => {
    const q = textOf(t.user);
    const qt = terms(q);
    const mine = [t.user, ...t.replies].filter(Boolean);
    if (i > 0 && t.user) {
      const prev = turns[i - 1];
      const reasons = [];
      let s = 0;

      const last = [prev.user, ...prev.replies].filter(Boolean).at(-1);
      const gap = (time(t.user) - time(last)) / 60_000;
      if (gap > 6 * 60) { s += 4; reasons.push('a long break before it'); }
      else if (gap > 30) { s += 3; reasons.push('a pause before it'); }

      const opening = q.trim();
      if (PRONOUN.test(opening)) { s -= 3; reasons.push('opens with “it” or “that”'); }
      else if (FOLLOW.test(opening)) { s -= 2; reasons.push('opens like a follow-up'); }
      const words = (opening.match(/\S+/g) || []).length;
      if (words < 12) { s -= 1.5; reasons.push('short'); }

      if (qt.length >= 3) {
        const before = new Set(terms([prev.user, ...prev.replies].filter(Boolean).map(textOf).join('\n')));
        const shared = qt.filter((w) => before.has(w)).length / qt.length;
        if (shared >= 0.5) { s -= 2; reasons.push('same vocabulary as the exchange before'); }
        else if (shared <= 0.2) { s += 2; reasons.push('little in common with the exchange before'); }
        const fresh = qt.filter((w) => !seen.has(w)).length / qt.length;
        if (fresh >= 0.6) { s += 1.5; reasons.push('mostly new to this conversation'); }
      }
      out.push({ index: i, key: turnKey(t), score: s, reasons });
    }
    for (const m of mine) for (const w of terms(textOf(m))) seen.add(w);
  });
  return out;
}

/** A section title from its opening question: its first clause, briefly. */
export function titleFor(t, max = 48) {
  const q = textOf(t.user).replace(/\s+/g, ' ').trim()
    .replace(/^(ok(ay)?|so|now|next|alright|right)[,.]?\s+/i, '')
    .replace(/^(can|could|would) you (please )?/i, '')
    .replace(/^(please )?(explain|describe|tell me about|walk me through)\s+/i, '');
  const first = (q.match(/^[^.?!\n]*/) || [''])[0].replace(/[\s,;:]+$/, '');
  const s = first || q || 'Untitled section';
  const c = s.length <= max ? s : `${s.slice(0, s.lastIndexOf(' ', max) > max * 0.6 ? s.lastIndexOf(' ', max) : max)}…`;
  return c.charAt(0).toUpperCase() + c.slice(1);
}

/**
 * Proposed breaks, as `{ startStableKey, title, suggested: true, reasons }`.
 *
 * Two breaks closer than `minRun` exchanges keep only the stronger: a
 * one-exchange section is almost always a guess gone wrong, not a topic. For
 * the same reason nothing is suggested in a chat too short to have topics,
 * or so early, or so late, that the first or last section would be a single
 * exchange — or so close to
 * one of your own sections that either would be. Turns that already start a
 * section are left alone.
 */
export function suggest(turns, existing = [], { threshold = 2, minRun = 2, minTurns = 4 } = {}) {
  if (turns.length < minTurns) return [];
  const taken = new Set(existing.map((s) => s.startStableKey));
  const mine = turns.map((t, i) => (taken.has(turnKey(t)) ? i : -1)).filter((i) => i >= 0);
  const picked = [];
  for (const c of score(turns)) {
    if (c.score < threshold || !c.key || taken.has(c.key)) continue;
    if (c.index < minRun || turns.length - c.index < minRun) continue;
    if (mine.some((i) => Math.abs(i - c.index) < minRun)) continue;
    const prev = picked[picked.length - 1];
    if (prev && c.index - prev.index < minRun) {
      if (c.score > prev.score) picked[picked.length - 1] = c;
      continue;
    }
    picked.push(c);
  }
  return picked.map((c) => ({
    startStableKey: c.key, title: titleFor(turns[c.index]), suggested: true, reasons: c.reasons,
  }));
}
