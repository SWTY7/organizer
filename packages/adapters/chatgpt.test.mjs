import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatgpt, stripChatgptMarkup as strip } from './chatgpt.js';

/* ChatGPT delimits its inline markers with private-use characters. */
const S = '', E = '', P = '';

test('citation markers are removed, leaving readable prose', () => {
  const src = `Paul Bloom's course is genuine.${S}cite${P}turn0search2${P}turn0search1${E} Worth watching.`;
  assert.equal(strip(src), "Paul Bloom's course is genuine. Worth watching.");
});

test('filecite instruction blocks do not leak into the transcript', () => {
  const src = `See ${S}filecite${P}turn0file0L5-L8${E} for the derivation.`;
  assert.equal(strip(src), 'See  for the derivation.');
});

test('unwrapped marker payloads are still cleaned', () => {
  // Some captures arrive with the delimiters already stripped by the clipboard.
  assert.equal(strip('citeturn0search2turn0search1').trim(), '');
  assert.equal(strip('a turn0youtube36 b'), 'a  b');
});

test('url markers become real links rather than being dropped', () => {
  const src = `${S}url${P}Yale Open Courses${P}https://oyc.yale.edu/psyc-110${E}`;
  assert.equal(strip(src), '[Yale Open Courses](https://oyc.yale.edu/psyc-110)');
});

test('::: document fences are removed but their contents survive', () => {
  const src = ':::writing{variant="document" id="58321" title="Roadmap"}\n# Roadmap\n\nBody text.\n:::';
  assert.equal(strip(src), '# Roadmap\n\nBody text.');
});

test('image_group directives are dropped', () => {
  const src = 'Intro line\nimage_group{"layout":"carousel","query":["a","b"]}\nAfter.';
  assert.equal(strip(src), 'Intro line\nAfter.');
});

test('ordinary text with maths and dollars is left alone', () => {
  const src = 'Given $E = mc^2$ and a cost of $30, the ratio is 5.';
  assert.equal(strip(src), src);
});

test('empty internal blocks produce nothing at all', () => {
  // This is the block that rendered as "Unrecognised block —
  // tether_browsing_display" in a real capture.
  const blocks = chatgpt.block({
    author: { role: 'assistant' },
    recipient: 'all',
    content: { content_type: 'tether_browsing_display', result: '', summary: '', assets: null },
  });
  assert.deepEqual(blocks, []);
});

test('internal blocks carrying a payload are kept as tool results', () => {
  const blocks = chatgpt.block({
    author: { role: 'assistant' },
    recipient: 'all',
    content: { content_type: 'tether_browsing_display', result: 'Found 6 pages', summary: '' },
  });
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'tool_result');
  assert.equal(blocks[0].text, 'Found 6 pages');
});

test('a tool-role text message becomes a tool result, never prose', () => {
  // The file-search dump that rendered as a wall of instructions.
  const blocks = chatgpt.block({
    author: { role: 'tool', name: 'file_search' },
    recipient: 'all',
    content: { content_type: 'text', parts: ['Make sure to include a citation. [L1] <PARSED TEXT>'] },
  });
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'tool_result');
  assert.equal(blocks[0].meta.kind, 'file_search');
});

test('an assistant text message is still prose', () => {
  const blocks = chatgpt.block({
    author: { role: 'assistant' },
    recipient: 'all',
    content: { content_type: 'text', parts: ['Here is the answer.'] },
  });
  assert.deepEqual(blocks, [{ type: 'text', text: 'Here is the answer.' }]);
});

test('recipient still discriminates tool calls from code blocks', () => {
  const asCode = chatgpt.block({
    author: { role: 'assistant' }, recipient: 'all',
    content: { content_type: 'code', language: 'python', text: 'x = 1' },
  });
  const asCall = chatgpt.block({
    author: { role: 'assistant' }, recipient: 'python',
    content: { content_type: 'code', language: 'python', text: 'x = 1' },
  });
  assert.equal(asCode[0].type, 'code');
  assert.equal(asCall[0].type, 'tool_use');
  assert.equal(asCall[0].name, 'python');
});
