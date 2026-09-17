import test from 'node:test';
import assert from 'node:assert/strict';
import { turns, stats, badges, plain, clip, gist, headings, ribbon, activeIndex } from './outline.js';

const msg = (role, ...content) => ({ id: `${role}-${content.length}-${Math.random()}`, role, content });
const text = (t) => ({ type: 'text', text: t });

test('a turn is a question plus everything that answered it', () => {
  const path = [
    msg('user', text('How does it work?')),
    msg('assistant', { type: 'tool_use', name: 'search' }),
    msg('tool', { type: 'tool_result', text: 'hits' }),
    msg('assistant', text('Like this.')),
    msg('user', text('And then?')),
    msg('assistant', text('Like that.')),
  ];
  const t = turns(path);
  assert.equal(t.length, 2);
  assert.equal(t[0].replies.length, 3, 'tool calls belong to the turn they served');
  assert.equal(t[1].user.content[0].text, 'And then?');
});

test('a path that opens mid-conversation still produces a turn', () => {
  const t = turns([msg('assistant', text('Continuing.')), msg('user', text('ok'))]);
  assert.equal(t.length, 2);
  assert.equal(t[0].user, null, 'no question to show, but the reply is not lost');
  assert.equal(t[0].replies.length, 1);
});

test('two questions in a row make two turns, the first unanswered', () => {
  const t = turns([msg('user', text('a')), msg('user', text('b'))]);
  assert.equal(t.length, 2);
  assert.deepEqual(t.map((x) => x.replies.length), [0, 0]);
});

test('stats count blocks, and thinking counts its steps', () => {
  const s = stats([msg('assistant',
    text('two words'),
    { type: 'code', text: 'x=1' },
    { type: 'thinking', summaries: ['a', 'b', 'c'] },
    { type: 'image' },
  )]);
  assert.deepEqual(s, { words: 2, code: 1, image: 1, file: 0, tool: 0, thoughts: 3 });
});

test('a thinking block with no summaries still counts as one step', () => {
  assert.equal(stats([msg('assistant', { type: 'thinking', text: 'hmm' })]).thoughts, 1);
});

test('badges skip whatever is zero and keep a fixed order', () => {
  assert.deepEqual(badges({ words: 900, code: 3, image: 1, file: 0, tool: 0, thoughts: 18 }),
    ['3 code', '1 image', 'thought 18 steps', '900 words']);
  assert.deepEqual(badges({ words: 0, code: 0, image: 0, file: 0, tool: 0, thoughts: 0 }), []);
});

test('badges get the singular right', () => {
  assert.deepEqual(badges({ words: 1, code: 0, image: 2, file: 0, tool: 0, thoughts: 1 }),
    ['2 images', 'thought 1 step', '1 word']);
});

test('markdown decoration comes off a preview line', () => {
  assert.equal(plain('## **Bold** heading'), 'Bold heading');
  assert.equal(plain('- a `code` item'), 'a code item');
  assert.equal(plain('> 1. quoted'), 'quoted', 'nested markers both come off');
  assert.equal(plain('see [the docs](https://x.example/y)'), 'see the docs');
});

test('clipping stops at a word boundary and says it clipped', () => {
  assert.equal(clip('short', 20), 'short');
  assert.equal(clip('the quick brown fox jumps', 15), 'the quick brown…');
  assert.equal(clip('supercalifragilistic', 10), 'supercalif…', 'no boundary to find');
});

test('the gist is the first sentence of the first prose', () => {
  const g = gist([msg('assistant', text('First sentence here. Second one.'))]);
  assert.equal(g, 'First sentence here.');
});

test('a leading heading is skipped — it usually restates the question', () => {
  const g = gist([msg('assistant', text('# Entropy\n\nIt counts microstates. More.'))]);
  assert.equal(g, 'It counts microstates.');
});

test('but a heading is better than nothing when it is all there is', () => {
  assert.equal(gist([msg('assistant', text('## Summary'), { type: 'code', text: 'x' })]), 'Summary');
});

test('the gist skips a code block to find the prose', () => {
  const g = gist([msg('assistant', { type: 'code', text: 'ignored()' }, text('The real answer. More.'))]);
  assert.equal(g, 'The real answer.');
});

test('the gist ignores horizontal rules and blank lines', () => {
  assert.equal(gist([msg('assistant', text('\n\n---\n\nActual text.'))]), 'Actual text.');
});

test('a reply with no prose has no gist rather than a bad one', () => {
  assert.equal(gist([msg('assistant', { type: 'code', text: 'x' })]), '');
  assert.equal(gist([]), '');
});

test('headings come back with their depth, capped', () => {
  const h = headings([msg('assistant', text('# One\ntext\n### Three\n## Two'))]);
  assert.deepEqual(h, [{ depth: 1, text: 'One' }, { depth: 3, text: 'Three' }, { depth: 2, text: 'Two' }]);
  assert.equal(headings([msg('assistant', text('# a\n# b\n# c'))], 2).length, 2);
});

test('a fenced line that looks like a heading is not one', () => {
  // The marker must start the line; indented-by-four is code, not a heading.
  assert.deepEqual(headings([msg('assistant', text('    # not a heading'))]), []);
});

test('ribbon weight grows sublinearly, so one long answer cannot swallow it', () => {
  const short = ribbon([msg('assistant', text('a '.repeat(100)))])[0];
  const long = ribbon([msg('assistant', text('a '.repeat(10000)))])[0];
  assert.ok(long.weight > short.weight);
  assert.ok(long.weight < short.weight * 15, `100x the words gave ${long.weight / short.weight}x the bar`);
});

test('ribbon marks what a bar contains', () => {
  const [bar] = ribbon([msg('assistant', { type: 'code', text: 'x' }, { type: 'image' })]);
  assert.equal(bar.code, true);
  assert.equal(bar.media, true);
  assert.equal(bar.thought, false);
  assert.equal(bar.role, 'assistant');
});

test('an empty message still gets a bar, so the map stays aligned', () => {
  const bars = ribbon([msg('user'), msg('assistant', text('hi'))]);
  assert.equal(bars.length, 2);
  assert.ok(bars[0].weight >= 1);
});

test('the active bar is the message covering the top edge', () => {
  // three messages: two scrolled past, the third still below the fold
  assert.equal(activeIndex([-900, -120, 300], 0), 1);
  assert.equal(activeIndex([-900, -120, -10], 0), 2);
});

test('before anything scrolls, the first bar is active', () => {
  assert.equal(activeIndex([0, 400, 900], 0), 0);
  assert.equal(activeIndex([120, 500, 900], 0), 0, 'all below the fold still marks the first');
});

test('a message that is not rendered cannot be active', () => {
  assert.equal(activeIndex([-500, Infinity, 700], 0), 0);
});

test('an empty ribbon does not throw', () => {
  assert.equal(activeIndex([], 0), 0);
});
