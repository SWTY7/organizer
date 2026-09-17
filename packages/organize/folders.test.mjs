import test from 'node:test';
import assert from 'node:assert/strict';
import {
  byId, childrenOf, subtree, pathOf, flatten, canMove, rollUp, orphans, reparentOnDelete,
} from './folders.js';

/*  root
      Physics
        Optics
        Thermo
          Entropy
      Zoology                */
const F = [
  { id: 'phy', name: 'Physics', parentId: null },
  { id: 'opt', name: 'Optics', parentId: 'phy' },
  { id: 'thm', name: 'Thermo', parentId: 'phy' },
  { id: 'ent', name: 'Entropy', parentId: 'thm' },
  { id: 'zoo', name: 'Zoology', parentId: null },
];

test('children come back alphabetical, not in insertion order', () => {
  assert.deepEqual(childrenOf(F, 'phy').map((f) => f.name), ['Optics', 'Thermo']);
  assert.deepEqual(childrenOf(F, null).map((f) => f.name), ['Physics', 'Zoology']);
});

test('a subtree includes the folder itself and every descendant', () => {
  assert.deepEqual([...subtree(F, 'phy')].sort(), ['ent', 'opt', 'phy', 'thm']);
  assert.deepEqual([...subtree(F, 'ent')], ['ent']);
  assert.deepEqual([...subtree(F, null)], []);
});

test('a cycle terminates instead of hanging the render', () => {
  const cyclic = [
    { id: 'a', name: 'A', parentId: 'b' },
    { id: 'b', name: 'B', parentId: 'a' },
  ];
  assert.deepEqual([...subtree(cyclic, 'a')].sort(), ['a', 'b']);
  assert.equal(pathOf(cyclic, 'a'), 'B / A');
});

test('a path reads from the root down', () => {
  assert.equal(pathOf(F, 'ent'), 'Physics / Thermo / Entropy');
  assert.equal(pathOf(F, 'phy'), 'Physics');
  assert.equal(pathOf(F, 'nope'), '');
});

test('flatten gives drawing order with depth', () => {
  assert.deepEqual(flatten(F).map((f) => `${f.depth}:${f.name}`),
    ['0:Physics', '1:Optics', '1:Thermo', '2:Entropy', '0:Zoology']);
});

test('a folder cannot move into itself or its own descendant', () => {
  assert.equal(canMove(F, 'phy', 'phy'), false);
  assert.equal(canMove(F, 'phy', 'ent'), false, 'grandchild would detach the branch');
  assert.equal(canMove(F, 'phy', null), true);
  assert.equal(canMove(F, 'zoo', 'ent'), true);
});

test('counts roll up, so a parent is never wrongly empty', () => {
  const direct = new Map([['ent', 3], ['zoo', 1]]);
  const all = rollUp(F, direct);
  assert.equal(all.get('phy'), 3, 'Physics holds nothing directly but 3 beneath it');
  assert.equal(all.get('thm'), 3);
  assert.equal(all.get('ent'), 3);
  assert.equal(all.get('opt'), 0);
  assert.equal(all.get('zoo'), 1);
});

test('a folder whose parent is gone is found, so it can be re-rooted', () => {
  const broken = [...F.filter((f) => f.id !== 'thm')];
  assert.deepEqual(orphans(broken).map((f) => f.id), ['ent']);
  assert.deepEqual(orphans(F), [], 'a sound tree has none');
});

test('deleting a folder lifts its children, it does not drop the branch', () => {
  assert.deepEqual(reparentOnDelete(F, 'thm'), [{ id: 'ent', name: 'Entropy', parentId: 'phy' }]);
  assert.deepEqual(reparentOnDelete(F, 'phy').map((f) => `${f.name}:${f.parentId}`),
    ['Optics:null', 'Thermo:null'], 'children of a top-level folder go to the top level');
});

test('byId is null-safe for ids that are gone', () => {
  assert.equal(byId(F, 'ent').name, 'Entropy');
  assert.equal(byId(F, 'ghost'), null);
  assert.equal(byId(F, null), null);
});
