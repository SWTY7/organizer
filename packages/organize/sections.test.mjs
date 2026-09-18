import test from 'node:test';
import assert from 'node:assert/strict';
import { turnKey, group, orphaned, setBreak, clearBreak, breakAt, applyMoves, BEGIN } from './sections.js';

const turn = (key, role = 'user') => ({
  user: role === 'user' ? { stableKey: key } : null,
  replies: role === 'user' ? [] : [{ stableKey: key }],
});
const T = ['a', 'b', 'c', 'd'].map((k) => turn(k));
// a, b, c, d, e, f — with breaks at c and e, so three sections of two each.
const SIX = ['a', 'b', 'c', 'd', 'e', 'f'].map((k) => turn(k));
const SECS3 = [{ startStableKey: 'c', title: 'B' }, { startStableKey: 'e', title: 'C' }];

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

/* ---------------------------------------------------------------- moves */

const namesOf = (groups) => groups.map((g) => g.turns.map((t) => turnKey(t)));

test('no moves is exactly group()', () => {
  assert.deepEqual(namesOf(applyMoves(SIX, SECS3, {})), namesOf(group(SIX, SECS3)));
  assert.deepEqual(namesOf(applyMoves(SIX, SECS3)), namesOf(group(SIX, SECS3)), 'undefined moves too');
});

test('a card moved later relocates, keeping chronological order in its new home', () => {
  // 'a' (naturally in section A, with 'b') moves into section C (with 'e','f').
  const g = applyMoves(SIX, SECS3, { a: 'e' });
  assert.deepEqual(namesOf(g), [['b'], ['c', 'd'], ['a', 'e', 'f']],
    'a sorts by true chronological position among its new section-mates, not by when it was dropped');
});

test('a card moved earlier relocates the same way', () => {
  const g = applyMoves(SIX, SECS3, { f: 'c' });
  assert.deepEqual(namesOf(g), [['a', 'b'], ['c', 'd', 'f'], ['e']]);
});

test('moving to BEGIN targets the opening section', () => {
  const g = applyMoves(SIX, SECS3, { e: BEGIN });
  assert.deepEqual(namesOf(g), [['a', 'b', 'e'], ['c', 'd'], ['f']]);
});

test('a move to a section that no longer exists is silently ignored', () => {
  const g = applyMoves(SIX, SECS3, { a: 'nonexistent-section-key' });
  assert.deepEqual(namesOf(g), namesOf(group(SIX, SECS3)), 'the card stays exactly where group() would put it');
});

test('a move to a card’s own natural section is a no-op, not a duplicate', () => {
  const g = applyMoves(SIX, SECS3, { a: BEGIN });
  assert.deepEqual(namesOf(g), namesOf(group(SIX, SECS3)));
});

test('several cards can move into the same section at once', () => {
  const g = applyMoves(SIX, SECS3, { a: 'e', d: 'e' });
  assert.deepEqual(namesOf(g), [['b'], ['c'], ['a', 'd', 'e', 'f']]);
});

test('moves never change which turns exist or their content, only their grouping', () => {
  const g = applyMoves(SIX, SECS3, { a: 'e', f: BEGIN });
  const all = g.flatMap((x) => x.turns);
  assert.equal(all.length, SIX.length);
  assert.deepEqual(new Set(all.map(turnKey)), new Set(SIX.map(turnKey)));
});

/* ------------------------------------------------------- board columns */

test('board columns come after the sections, empty until something moves in', () => {
  const g = applyMoves(SIX, SECS3, {}, [{ id: 'x1', title: 'Later' }]);
  assert.equal(g.length, 4);
  assert.equal(g[3].title, 'Later');
  assert.equal(g[3].extra, true);
  assert.deepEqual(g[3].turns, []);
  assert.deepEqual(g.map((x) => x.key), [BEGIN, 'c', 'e', 'x1'], 'every column says what a move should target');
});

test('a chat with no sections can still be arranged, into a board column', () => {
  const g = applyMoves(SIX, [], { b: 'x1', e: 'x1' }, [{ id: 'x1', title: 'Side' }]);
  assert.deepEqual(namesOf(g), [['a', 'c', 'd', 'f'], ['b', 'e']]);
});

test('removing a board column puts its cards back where they came from', () => {
  const g = applyMoves(SIX, [], { b: 'x1' }, []);
  assert.deepEqual(namesOf(g), [['a', 'b', 'c', 'd', 'e', 'f']]);
});
