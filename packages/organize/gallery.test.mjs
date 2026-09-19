import test from 'node:test';
import assert from 'node:assert/strict';
import { items, counts, fences, tables, links } from './gallery.js';

const text = (t) => ({ type: 'text', text: t });
const turn = (q, ...replies) => ({ user: { role: 'user', content: [text(q)] }, replies: replies.map((content) => ({ role: 'assistant', content })) });

test('fenced code inside markdown is found, with its language', () => {
  const f = fences('Try this:\n\n```python\nprint(1)\nprint(2)\n```\n\nand\n~~~\nplain\n~~~');
  assert.deepEqual(f, [{ lang: 'python', text: 'print(1)\nprint(2)' }, { lang: '', text: 'plain' }]);
});

test('markdown tables are found with their shape; lookalikes are not', () => {
  const t = tables('intro\n\n| a | b |\n|---|:-:|\n| 1 | 2 |\n| 3 | 4 |\n\nafter | not | a table');
  assert.equal(t.length, 1);
  assert.deepEqual(t[0].columns, ['a', 'b']);
  assert.equal(t[0].rows, 2);
  assert.deepEqual(tables('| just | one | line |'), []);
});

test('links: markdown and bare, once each, and not from inside code', () => {
  const l = links('See [the docs](https://example.com/a) and https://example.com/b.\nAlso https://example.com/a again.\n```\nhttps://in.code/x\n```');
  assert.deepEqual(l, [{ url: 'https://example.com/a', title: 'the docs' }, { url: 'https://example.com/b', title: '' }]);
});

test('collects every kind, in order, tagged with the exchange it came from', () => {
  const t = [
    turn('What is this? https://q.example/x', [text('| k | v |\n|---|---|\n| a | 1 |')]),
    turn('Code please', [
      { type: 'code', lang: 'rust', text: 'fn main() {}' },
      { type: 'tool_use', name: 'search', input: { q: 'x' } },
      { type: 'tool_result', text: 'boom', isError: true },
      { type: 'image', filename: 'plot.png', width: 10, height: 20 },
      { type: 'file', filename: 'notes.txt', text: 'hello' },
      { type: 'citation', url: 'https://c.example', title: 'Source' },
    ]),
  ];
  const all = items(t);
  assert.deepEqual(all.map((x) => [x.turn, x.kind]), [
    [0, 'link'], [0, 'table'], [1, 'code'], [1, 'tool'], [1, 'tool'], [1, 'image'], [1, 'file'], [1, 'link'],
  ]);
  assert.equal(all[0].role, 'user', 'things you pasted count too');
  assert.equal(all[3].text, '{\n  "q": "x"\n}');
  assert.equal(all[4].isError, true);
  assert.deepEqual(counts(all), { link: 2, table: 1, code: 1, tool: 2, image: 1, file: 1 });
});

test('a conversation of plain prose has an empty gallery', () => {
  assert.deepEqual(items([turn('hi', [text('Just words, nothing else.')])]), []);
});

test('artifact edits and their results are left to the artifact, not listed as tool calls', () => {
  const t = [turn('make a page', [
    { type: 'tool_use', id: 'u1', name: 'artifacts', input: { command: 'create', id: 'p', content: '<p>x</p>' } },
    { type: 'tool_result', toolUseId: 'u1', text: 'OK' },
    { type: 'tool_use', id: 'u2', name: 'web_search', input: { q: 'x' } },
    { type: 'tool_result', toolUseId: 'u2', text: 'found' },
  ])];
  assert.deepEqual(items(t).map((x) => x.title), ['web_search', 'Result']);
});
