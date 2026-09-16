import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spliceParents, iso } from './shared.js';

const msgs = (...ids) => ids.map((id) => ({ id, parentId: null }));
const byId = (list) => Object.fromEntries(list.map((m) => [m.id, m]));

test('a dropped node in the middle reattaches its child to the surviving ancestor', () => {
  // The real failure: ChatGPT node 694c1e33 came back with parentId null in the
  // middle of a thread because its parent produced zero content blocks and was
  // skipped. Nulling the orphan severed the conversation.
  const kept = msgs('A', 'C');
  const parentOf = new Map([['A', null], ['B', 'A'], ['C', 'B']]); // B was dropped
  spliceParents(kept, parentOf);
  assert.equal(byId(kept).C.parentId, 'A', 'C should reattach to A, not become a root');
  assert.equal(byId(kept).A.parentId, null);
});

test('a run of consecutive dropped nodes collapses to the nearest survivor', () => {
  const kept = msgs('A', 'D');
  const parentOf = new Map([['A', null], ['B', 'A'], ['C', 'B'], ['D', 'C']]);
  spliceParents(kept, parentOf);
  assert.equal(byId(kept).D.parentId, 'A');
});

test('only a message with no surviving ancestor becomes a root', () => {
  const kept = msgs('C');
  const parentOf = new Map([['A', null], ['B', 'A'], ['C', 'B']]);
  spliceParents(kept, parentOf);
  assert.equal(byId(kept).C.parentId, null);
});

test('exactly one root in a fully linear thread', () => {
  const kept = msgs('A', 'B', 'C');
  const parentOf = new Map([['A', null], ['B', 'A'], ['C', 'B']]);
  spliceParents(kept, parentOf);
  assert.equal(kept.filter((m) => !m.parentId).length, 1);
});

test('branches survive: two children keep the same parent', () => {
  const kept = msgs('A', 'B', 'C');
  const parentOf = new Map([['A', null], ['B', 'A'], ['C', 'A']]);
  spliceParents(kept, parentOf);
  assert.equal(byId(kept).B.parentId, 'A');
  assert.equal(byId(kept).C.parentId, 'A');
});

test("Claude's root sentinel uuid is treated as no parent", () => {
  // Claude sends 00000000-0000-4000-8000-000000000000 rather than null. The
  // adapter maps it to null before calling this; verify an unmapped id that
  // isn't in the map also degrades safely rather than looping.
  const kept = msgs('A');
  const parentOf = new Map([['A', '00000000-0000-4000-8000-000000000000']]);
  spliceParents(kept, parentOf);
  assert.equal(byId(kept).A.parentId, null);
});

test('a parent cycle terminates instead of hanging', () => {
  const kept = msgs('X');
  const parentOf = new Map([['X', 'Y'], ['Y', 'Z'], ['Z', 'Y']]); // Y <-> Z loop
  spliceParents(kept, parentOf);
  assert.equal(byId(kept).X.parentId, null);
});

test('timestamps normalize to ISO 8601 UTC from both provider formats', () => {
  // ChatGPT's list returns ISO strings while its detail returns Unix seconds
  // for the same field names.
  assert.equal(iso(1789571833), '2026-09-16T15:17:13.000Z');
  assert.equal(iso('2026-09-12T14:14:16.269Z'), '2026-09-12T14:14:16.269Z');
  assert.equal(iso(null), null);
  assert.equal(iso('not a date'), null);
});
