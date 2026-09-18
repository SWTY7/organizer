import test from 'node:test';
import assert from 'node:assert/strict';
import { forks, lineFrom } from './branches.js';
import { diffWords, tokens } from './diff.js';

/* --------------------------------------------------------------- forks */

// q1 → a1 → q2 → a2          the path
//          ↘ q2' → a2' → q3'  an edited question that went on
//    ↘ a1b                    a regenerate of the first reply
const M = (id, parentId, role) => ({ id, parentId, role });
const all = [
  M('q1', null, 'user'), M('a1', 'q1', 'assistant'), M('a1b', 'q1', 'assistant'),
  M('q2', 'a1', 'user'), M('a2', 'q2', 'assistant'),
  M('q2e', 'a1', 'user'), M('a2e', 'q2e', 'assistant'), M('q3e', 'a2e', 'user'),
];
const kids = new Map();
for (const m of all) kids.set(m.parentId, [...(kids.get(m.parentId) || []), m]);
const byId = new Map(all.map((m) => [m.id, m]));
const path = ['q1', 'a1', 'q2', 'a2'].map((id) => byId.get(id));

test('finds a fork wherever a message on the path has siblings', () => {
  const f = forks(path, kids);
  assert.deepEqual(f.map((x) => [x.at, x.role]), [[1, 'assistant'], [2, 'user']]);
});

test('says which version is the one being shown, numbered from 1', () => {
  const [regen] = forks(path, kids);
  assert.deepEqual(regen.versions.map((v) => [v.n, v.msg.id, v.onPath]), [[1, 'a1', true], [2, 'a1b', false]]);
  assert.equal(regen.chosen, 'a1');
});

test('counts how far each version goes on', () => {
  const edit = forks(path, kids)[1];
  assert.deepEqual(edit.versions.map((v) => v.after), [1, 2], 'q2 has its reply; the edit has a reply and a follow-up');
  assert.equal(forks(path, kids)[0].versions[0].after, 3, 'following a1 reaches the newest line: q2e, a2e, q3e');
});

test('a linear conversation has no forks', () => {
  const k = new Map([[null, [path[0]]], ['q1', [path[1]]], ['a1', [path[2]]], ['q2', [path[3]]]]);
  assert.deepEqual(forks(path, k), []);
});

test('lineFrom follows the newest child and stops at a leaf', () => {
  assert.deepEqual(lineFrom(byId.get('q2e'), kids).map((m) => m.id), ['a2e', 'q3e']);
  assert.deepEqual(lineFrom(byId.get('q3e'), kids), []);
});

/* ---------------------------------------------------------------- diff */

const join = (ops, keep) => ops.filter((o) => o.op === '=' || o.op === keep).map((o) => o.text).join('');

test('tokens split losslessly into words, spaces and punctuation', () => {
  const s = 'Hello,  world — ça va? x_1=2';
  assert.equal(tokens(s).join(''), s);
  assert.deepEqual(tokens('a, b'), ['a', ',', ' ', 'b']);
});

test('identical texts are one unchanged run', () => {
  const d = diffWords('the same text', 'the same text');
  assert.deepEqual(d.ops, [{ op: '=', text: 'the same text' }]);
  assert.equal(d.same, 1);
});

test('a changed word is marked as removed then added', () => {
  const d = diffWords('Because of order counting.', 'Because of power counting.');
  assert.deepEqual(d.ops, [
    { op: '=', text: 'Because of ' }, { op: '-', text: 'order' }, { op: '+', text: 'power' }, { op: '=', text: ' counting.' },
  ]);
});

test('insertions and deletions', () => {
  assert.deepEqual(diffWords('a c', 'a b c').ops.filter((o) => o.op !== '='), [{ op: '+', text: 'b ' }]);
  assert.deepEqual(diffWords('a b c', 'a c').ops.filter((o) => o.op !== '='), [{ op: '-', text: 'b ' }]);
});

test('either side can always be rebuilt from the diff', () => {
  const a = 'Expanding a_ik further only adds third-order terms. In U, the x terms *are* the leading order.';
  const b = 'Keeping more terms of a_ik only adds third-order corrections. In U, the x terms are the leading order that does anything.';
  const { ops } = diffWords(a, b);
  assert.equal(join(ops, '-'), a);
  assert.equal(join(ops, '+'), b);
});

test('a single shared space does not split a rewrite into fragments', () => {
  const { ops } = diffWords('one two three', 'four five six');
  assert.deepEqual(ops, [{ op: '-', text: 'one two three' }, { op: '+', text: 'four five six' }]);
});

test('reports how much two texts share, so unrelated versions can be said to be', () => {
  assert.ok(diffWords('completely different words here', 'nothing alike at all, really').same < 0.2);
  assert.ok(diffWords('a long shared sentence with one change', 'a long shared sentence with one edit').same > 0.7);
});

test('texts too long to align are shown as replaced, not hung on', () => {
  const d = diffWords('a b c d', 'a x y d', { maxCells: 1 });
  assert.equal(join(d.ops, '-'), 'a b c d');
  assert.equal(join(d.ops, '+'), 'a x y d');
});
