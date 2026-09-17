import test from 'node:test';
import assert from 'node:assert/strict';
import { turnKey, group, orphaned, setBreak, clearBreak, breakAt } from './sections.js';

const turn = (key, role = 'user') => ({
  user: role === 'user' ? { stableKey: key } : null,
  replies: role === 'user' ? [] : [{ stableKey: key }],
});
const T = ['a', 'b', 'c', 'd'].map((k) => turn(k));

test('a turn is identified by the message that opens it', () => {
  assert.equal(turnKey(turn('q1')), 'q1');
  assert.equal(turnKey(turn('r1', 'assistant')), 'r1', 'a turn with no question still has a key');
  assert.equal(turnKey({ user: null, replies: [] }), null);
});

test('falls back to id when a message has no stableKey', () => {
  assert.equal(turnKey({ user: { id: 'm9' }, replies: [] }), 'm9');
});

test('turns before the first break become an untitled opening section', () => {
  const g = group(T, [{ startStableKey: 'c', title: 'Later' }]);
  assert.equal(g.length, 2);
  assert.equal(g[0].title, null, 'a conversation does not begin with a heading');
  assert.deepEqual(g[0].turns.map(turnKey), ['a', 'b']);
  assert.equal(g[1].title, 'Later');
  assert.deepEqual(g[1].turns.map(turnKey), ['c', 'd']);
});

test('no breaks means one section holding everything', () => {
  const g = group(T, []);
  assert.equal(g.length, 1);
  assert.equal(g[0].turns.length, 4);
});

test('a break on the very first turn does not leave an empty section', () => {
  const g = group(T, [{ startStableKey: 'a', title: 'Opening' }]);
  assert.equal(g.length, 1);
  assert.equal(g[0].title, 'Opening');
  assert.equal(g[0].turns.length, 4);
});

test('every turn lands in exactly one section', () => {
  const g = group(T, [{ startStableKey: 'b', title: 'B' }, { startStableKey: 'd', title: 'D' }]);
  assert.deepEqual(g.flatMap((s) => s.turns.map(turnKey)), ['a', 'b', 'c', 'd']);
  assert.deepEqual(g.map((s) => s.title), [null, 'B', 'D']);
});

test('breaks that no longer land anywhere are reported, not tidied away', () => {
  const secs = [{ startStableKey: 'b', title: 'B' }, { startStableKey: 'gone', title: 'Stale' }];
  assert.deepEqual(orphaned(T, secs).map((s) => s.title), ['Stale']);
  assert.equal(group(T, secs).length, 2, 'and the stale one does not create a phantom section');
});

test('setting a break twice renames rather than duplicating', () => {
  let s = setBreak([], 'b', 'First');
  s = setBreak(s, 'b', 'Second');
  assert.equal(s.length, 1);
  assert.equal(s[0].title, 'Second');
});

test('a break always gets a title, even an unhelpful one', () => {
  assert.equal(setBreak([], 'b', '')[0].title, 'Untitled section');
});

test('setting a break on nothing changes nothing', () => {
  const s = [{ startStableKey: 'b', title: 'B' }];
  assert.equal(setBreak(s, null, 'x'), s);
});

test('clearing removes just that break', () => {
  const s = [{ startStableKey: 'b', title: 'B' }, { startStableKey: 'c', title: 'C' }];
  assert.deepEqual(clearBreak(s, 'b').map((x) => x.startStableKey), ['c']);
  assert.deepEqual(clearBreak(s, 'zzz').length, 2);
});

test('breakAt finds the break on a turn, and null elsewhere', () => {
  const s = [{ startStableKey: 'b', title: 'B' }];
  assert.equal(breakAt(s, 'b').title, 'B');
  assert.equal(breakAt(s, 'a'), null);
  assert.equal(breakAt(s, null), null);
});
