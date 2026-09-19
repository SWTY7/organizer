import test from 'node:test';
import assert from 'node:assert/strict';
import { artifacts, editOf, kindOf } from './artifacts.js';

const call = (name, input) => ({ type: 'tool_use', name, input });
const turn = (...blocks) => ({ user: { role: 'user', content: [] }, replies: [{ role: 'assistant', content: blocks }] });

test('create, update, rewrite replay into the final document', () => {
  const t = [
    turn(call('artifacts', { command: 'create', id: 'page', type: 'text/html', title: 'Landing', content: '<h1>Hi</h1>\n<p>old</p>' })),
    turn(call('artifacts', { command: 'update', id: 'page', old_str: 'old', new_str: 'new' })),
    turn({ type: 'text', text: 'done' }, call('artifacts', { command: 'update', id: 'page', old_str: 'Hi', new_str: 'Hello' })),
  ];
  const [a] = artifacts(t);
  assert.equal(a.content, '<h1>Hello</h1>\n<p>new</p>');
  assert.equal(a.title, 'Landing');
  assert.equal(a.kind, 'html');
  assert.equal(a.edits, 3);
  assert.deepEqual([a.firstTurn, a.turn], [0, 2]);
  assert.deepEqual(a.versions.map((v) => v.turn), [0, 1, 2]);

  const r = artifacts([...t, turn(call('artifacts', { command: 'rewrite', id: 'page', content: 'fresh' }))]);
  assert.equal(r[0].content, 'fresh', 'a rewrite replaces everything');
});

test('an edit that cannot apply is counted, not guessed', () => {
  const [a] = artifacts([
    turn(call('artifacts', { command: 'create', id: 'x', content: 'abc' })),
    turn(call('artifacts', { command: 'update', id: 'x', old_str: 'zzz', new_str: 'q' })),
  ]);
  assert.equal(a.content, 'abc');
  assert.equal(a.failed, 1);
  assert.equal(a.edits, 1);
});

test('separate artifacts stay separate, in order of creation', () => {
  const r = artifacts([turn(
    call('artifacts', { command: 'create', id: 'a', title: 'A', type: 'application/vnd.ant.code', language: 'python', content: 'print(1)' }),
    call('artifacts', { command: 'create', id: 'b', title: 'B', type: 'image/svg+xml', content: '<svg/>' }),
  )]);
  assert.deepEqual(r.map((x) => [x.title, x.kind, x.lang]), [['A', 'code', 'python'], ['B', 'svg', '']]);
});

test('file-editing tools are understood too, keyed by path', () => {
  const [a] = artifacts([
    turn(call('create_file', { path: '/out/app.tsx', file_text: 'const a = 1;\nconst b = 2;' })),
    turn(call('str_replace', { path: '/out/app.tsx', old_str: 'a = 1', new_str: 'a = 10' })),
    turn(call('str_replace_based_edit_tool', { command: 'insert', path: '/out/app.tsx', insert_line: 1, new_str: '// middle' })),
  ]);
  assert.equal(a.title, 'app.tsx');
  assert.equal(a.lang, 'tsx');
  assert.equal(a.kind, 'react');
  assert.equal(a.content, 'const a = 10;\n// middle\nconst b = 2;');
});

test('ordinary tool calls are not artifacts', () => {
  assert.equal(editOf(call('web_search', { query: 'x' })), null);
  assert.equal(editOf({ type: 'text', text: 'hi' }), null);
  assert.deepEqual(artifacts([turn(call('web_search', { query: 'x' }))]), []);
});

test('kinds, from the declared type or the file name', () => {
  assert.equal(kindOf('image/svg+xml'), 'svg');
  assert.equal(kindOf('', '', 'chart.svg'), 'svg');
  assert.equal(kindOf('application/vnd.ant.react'), 'react');
  assert.equal(kindOf('text/markdown'), 'markdown');
  assert.equal(kindOf('application/vnd.ant.code', 'rust'), 'code');
});
