/* ==========================================================================
   Forks: where a conversation has more than one version of a message.

   Exact, not inferred. A regenerate is a second reply to the same question;
   an edit is a second question under the same parent. Both show up in the
   captured tree as siblings, and that is all this reads.

   Pure. `kids` maps a parentId to its children, oldest first — the map
   core.js `mainPath` already builds.
   ========================================================================== */

/**
 * Where a message leads if you keep taking the newest reply: what "goes on
 * for 4 more messages" counts, and what following a branch would show.
 */
export function lineFrom(msg, kids, max = 10_000) {
  const out = [];
  let at = msg;
  while (at && out.length < max) {
    const next = kids.get(at.id);
    if (!next?.length) break;
    at = next[next.length - 1];
    out.push(at);
  }
  return out;
}

/**
 * Every point on `path` where the message there has siblings.
 *
 * @returns {{at: number, parentId: string|null, role: string, chosen: string,
 *   versions: {msg: object, n: number, onPath: boolean, after: number}[]}[]}
 *   `at` is the index into path; `n` numbers versions from 1, oldest first,
 *   the way a provider's own ‹ 2 / 3 › does; `after` is how many messages
 *   follow that version.
 */
export function forks(path, kids) {
  const out = [];
  path.forEach((m, at) => {
    const sibs = kids.get(m.parentId ?? null) || [];
    if (sibs.length < 2) return;
    out.push({
      at,
      parentId: m.parentId ?? null,
      role: m.role,
      chosen: m.id,
      versions: sibs.map((s, k) => ({ msg: s, n: k + 1, onPath: s.id === m.id, after: lineFrom(s, kids).length })),
    });
  });
  return out;
}
