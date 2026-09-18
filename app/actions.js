/* ==========================================================================
   Things you can do to conversations, reachable from anywhere: the tree, the
   result list, the reader's header and the bulk bar all call these, so a
   conversation behaves the same wherever you meet it.

   Undoable actions do not ask first; they act and offer Undo (DESIGN.md,
   interaction rule 2). Only what cannot be undone asks.
   ========================================================================== */

import {
  S, R, metaOf, setMeta, convById, folderList, folderPath, allTags, createFolder,
  fileInto, setStarred, setArchived, addTag, removeConvs, openConv, STORE, load,
} from './core.js';
import { menu, picker, toast } from './lib/dom.js';

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const named = (ids) => (ids.length === 1 ? `“${convById(ids[0])?.title || 'chat'}”` : plural(ids.length, 'chat'));

/** Put things back exactly as they were — per conversation, not as a group. */
function undoer(ids, field) {
  const before = ids.map((id) => [id, metaOf(id)[field]]);
  return async () => {
    for (const [id, v] of before) await setMeta([id], { [field]: v });
    R.all();
  };
}

export async function star(ids, on = true) {
  const undo = undoer(ids, 'starred');
  await setStarred(ids, on);
  R.all();
  if (ids.length > 1) toast(`${on ? 'Starred' : 'Unstarred'} ${plural(ids.length, 'chat')}`, { label: 'Undo', run: undo });
}

export async function archive(ids, on = true) {
  const undo = undoer(ids, 'archived');
  await setArchived(ids, on);
  if (on) for (const id of ids) S.sel.delete(id);
  R.all();
  toast(`${on ? 'Archived' : 'Restored'} ${named(ids)}`, { label: 'Undo', run: undo });
}

export async function move(ids, folderId) {
  const undo = undoer(ids, 'folderId');
  await fileInto(ids, folderId);
  R.all();
  toast(`Moved ${named(ids)} to ${folderId ? folderPath(folderId) : 'Unsorted'}`, { label: 'Undo', run: undo });
}

/**
 * Removal keeps the conversations in memory for a few seconds, so Undo can put
 * them back without asking you to find the export file again.
 */
export async function remove(ids) {
  const convs = ids.map(convById).filter(Boolean);
  const metas = ids.map((id) => S.meta.get(id)).filter(Boolean);
  const label = named(ids);
  await removeConvs(ids);
  R.all();
  toast(`Removed ${label} from the library`, {
    label: 'Undo',
    run: async () => {
      await STORE.put('conversations', convs);
      await STORE.put('meta', metas);
      await load();
      R.all();
    },
  });
}

/** Pick a folder — or type a new name to create one on the spot. */
export function movePicker(ids, anchor) {
  const here = ids.length === 1 ? metaOf(ids[0]).folderId || null : undefined;
  const items = [
    { label: 'Unsorted', value: null, icon: 'tray' },
    ...folderList().map((f) => ({ label: folderPath(f.id), value: f.id, icon: 'folder' })),
  ].filter((i) => i.value !== here);
  picker({
    items, anchor,
    placeholder: 'Move to folder…',
    onPick: (v) => move(ids, v),
    create: async (name) => { const f = await createFolder(name, null); await move(ids, f.id); },
  });
}

/** Pick a tag — or type a new one. */
export function tagPicker(ids, anchor) {
  const have = new Set(ids.length === 1 ? metaOf(ids[0]).tags : []);
  picker({
    items: allTags().filter((t) => !have.has(t)).map((t) => ({ label: t, value: t, icon: 'hash' })),
    anchor,
    placeholder: 'Add a tag…',
    onPick: async (t) => { await addTag(ids, t); R.all(); },
    create: async (t) => { await addTag(ids, t); R.all(); },
  });
}

/** The ⋯ menu on a conversation, wherever it appears. */
export function chatMenu(conv, anchor) {
  const ids = S.sel.has(conv.id) && S.sel.size > 1 ? [...S.sel] : [conv.id];
  const m = metaOf(conv.id);
  const many = ids.length > 1;
  menu([
    many ? { heading: plural(ids.length, 'chat') + ' selected' } : null,
    !many && conv.id !== S.openId ? { label: 'Open', icon: 'msg', run: () => openConv(conv.id) } : null,
    { label: m.starred ? 'Unstar' : 'Star', icon: 'star', run: () => star(ids, !m.starred) },
    { label: 'Move to…', icon: 'folder', run: () => movePicker(ids, anchor) },
    { label: 'Add tag…', icon: 'hash', run: () => tagPicker(ids, anchor) },
    { label: m.archived ? 'Restore from archive' : 'Archive', icon: 'archive', run: () => archive(ids, !m.archived) },
    '-',
    { label: 'Remove from library', icon: 'trash', danger: true, run: () => remove(ids) },
  ], anchor);
}
