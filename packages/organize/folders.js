/* ==========================================================================
   Folder-tree logic, kept pure so it can be tested without a browser.

   Every function takes the folder array as its first argument and returns a
   new value. Nothing here touches storage, the DOM, or module state.
   A folder is `{ id, name, parentId }`, where a null parentId means top level.
   ========================================================================== */

export const byId = (folders, id) => folders.find((f) => f.id === id) || null;

/** Direct children, alphabetical — the order the tree is drawn in. */
export const childrenOf = (folders, pid) =>
  folders.filter((f) => f.parentId === pid).sort((a, b) => a.name.localeCompare(b.name));

/**
 * A folder plus every folder beneath it. The visited check is load-bearing:
 * stored data can contain a cycle (a crash mid-move, a hand-edited export),
 * and a render that hangs is far worse than one that draws a short tree.
 */
export function subtree(folders, id, out = new Set()) {
  if (!id || out.has(id)) return out;
  out.add(id);
  for (const f of childrenOf(folders, id)) subtree(folders, f.id, out);
  return out;
}

/** "Physics / Thermodynamics" — what a flat picker must show once folders nest. */
export function pathOf(folders, id, sep = ' / ') {
  const parts = [];
  const seen = new Set();
  for (let f = byId(folders, id); f && !seen.has(f.id); f = byId(folders, f.parentId)) {
    seen.add(f.id);
    parts.unshift(f.name);
  }
  return parts.join(sep);
}

/** Every folder in drawing order, each carrying its depth. */
export function flatten(folders, pid = null, depth = 0, out = []) {
  for (const f of childrenOf(folders, pid)) {
    out.push({ ...f, depth });
    flatten(folders, f.id, depth + 1, out);
  }
  return out;
}

/**
 * Can `id` become a child of `toId`? Not itself, and not one of its own
 * descendants — that would cut the branch loose from the root entirely.
 */
export const canMove = (folders, id, toId) =>
  id !== toId && !subtree(folders, id).has(toId);

/**
 * Sum per-folder tallies up the tree. A folder whose conversations all sit in
 * its subfolders would otherwise report zero, which is simply untrue.
 */
export function rollUp(folders, direct) {
  const out = new Map();
  for (const f of folders) {
    let n = 0;
    for (const id of subtree(folders, f.id)) n += direct.get(id) || 0;
    out.set(f.id, n);
  }
  return out;
}

/**
 * Folders whose parent no longer exists. Their whole branch is unreachable —
 * nothing walks to it — so they disappear from the tree while still occupying
 * the store. Callers re-root what this returns.
 */
export const orphans = (folders) => {
  const known = new Set(folders.map((f) => f.id));
  return folders.filter((f) => f.parentId && !known.has(f.parentId));
};

/** Reparenting for a delete: children rise to the deleted folder's parent. */
export const reparentOnDelete = (folders, id) =>
  childrenOf(folders, id).map((f) => ({ ...f, parentId: byId(folders, id)?.parentId ?? null }));
