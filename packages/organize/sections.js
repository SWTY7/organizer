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
