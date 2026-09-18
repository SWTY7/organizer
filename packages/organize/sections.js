/* ==========================================================================
   Sections: where one topic inside a conversation ends and the next begins.

   This is the *semantic* structure, which the provider does not give us —
   `A → A1 → A2 → B` is a straight line in the data, and nothing in it marks A1
   as subordinate to A. So a section break is either something you placed, or
   something guessed and shown as a guess. Never something applied silently.

   A break is anchored by `startStableKey`, not by an index, so it survives
   re-capturing the conversation: that is what stableKey was built for. A turn
   is identified by the stableKey of the message that opens it.
   ========================================================================== */

/** The message that identifies a turn — its question, or its first reply. */
export const turnKey = (t) => {
  const m = t.user || t.replies?.[0];
  return m ? (m.stableKey || m.id || null) : null;
};

/**
 * Split turns into sections. Turns before the first break form an untitled
 * opening section rather than being dropped — a conversation does not begin
 * with a heading.
 */
export function group(turns, sections = []) {
  const byKey = new Map(sections.filter((s) => s?.startStableKey).map((s) => [s.startStableKey, s]));
  const out = [];
  for (const t of turns) {
    const key = turnKey(t);
    const s = key ? byKey.get(key) : null;
    if (s || !out.length) out.push({ title: s?.title ?? null, startKey: s ? key : null, turns: [] });
    out[out.length - 1].turns.push(t);
  }
  return out;
}

/**
 * Breaks that no longer land on any turn.
 *
 * They happen for real reasons — the conversation was re-captured and a
 * message changed, or the break sits on a branch this path does not follow.
 * Silently dropping them would lose work the user did, so callers surface them
 * rather than tidying them away.
 */
export function orphaned(turns, sections = []) {
  const live = new Set(turns.map(turnKey).filter(Boolean));
  return sections.filter((s) => s?.startStableKey && !live.has(s.startStableKey));
}

/** Add a break at a turn, or rename the one already there. Never duplicates. */
export function setBreak(sections, key, title) {
  if (!key) return sections;
  const rest = sections.filter((s) => s.startStableKey !== key);
  return [...rest, { startStableKey: key, title: title || 'Untitled section' }];
}

export const clearBreak = (sections, key) => sections.filter((s) => s.startStableKey !== key);

/** Does a turn start a section? Returns the break, so callers can read its title. */
export const breakAt = (sections, key) =>
  (key ? sections.find((s) => s.startStableKey === key) : null) || null;

/** Sentinel for the section with no break of its own — the opening one. */
export const BEGIN = '__begin';

/**
 * Section membership, with manual card moves layered on top of `group()`.
 *
 * This is read by the Columns board only. Every other view — Transcript,
 * Outline, Focus, the inspector's list — shows turns in true chronological
 * order, and a move must never reach them: relocating a turn into a section
 * that sits earlier in the conversation would make those views render it out
 * of sequence, which is not a display quirk, it is the wrong conversation.
 * Columns is the one view that is spatial rather than sequential, so it is
 * the only one that reads this.
 *
 * `moves` maps a turn's key to the `startKey` of the section it was dragged
 * into (`BEGIN` for the opening one). A target that no longer exists — its
 * section was deleted after the move — is treated as no move at all: the
 * turn quietly stays where `group()` would naturally put it, rather than the
 * render throwing or the card vanishing.
 *
 * A moved turn keeps its place in chronological order *within* its new
 * section — moving is a change of section, never a change of reading order.
 */
export function applyMoves(turns, sections, moves) {
  const base = group(turns, sections);
  if (!moves || !Object.keys(moves).length) return base;

  const byKey = new Map(base.map((g) => [g.startKey ?? BEGIN, g]));
  const index = new Map(turns.map((t, i) => [t, i]));
  const incoming = new Map(); // target startKey -> turns arriving, unsorted

  for (const g of base) {
    g.turns = g.turns.filter((t) => {
      const key = turnKey(t);
      const target = key ? moves[key] : undefined;
      if (target == null || target === (g.startKey ?? BEGIN) || !byKey.has(target)) return true;
      (incoming.get(target) ?? incoming.set(target, []).get(target)).push(t);
      return false;
    });
  }
  for (const [target, arrived] of incoming) {
    const g = byKey.get(target);
    g.turns = [...g.turns, ...arrived].sort((a, b) => index.get(a) - index.get(b));
  }
  return base;
}
