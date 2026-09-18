import test from 'node:test';
import assert from 'node:assert/strict';
import { suggest, score, terms, titleFor } from './suggest.js';
import { group } from './sections.js';

let clock = Date.UTC(2026, 0, 1, 9);
const at = (min) => new Date((clock += min * 60_000)).toISOString();
const msg = (id, role, text, gap = 2) => ({ id, stableKey: id, role, createdAt: at(gap), content: [{ type: 'text', text }] });
const T = (id, q, a, gap) => ({ user: msg(id, 'user', q, gap), replies: [msg(`${id}r`, 'assistant', a)] });

const convo = () => [
  T('q1', 'Explain how a Kalman filter fuses a noisy measurement with a motion model prediction.',
    'The filter weighs the prediction and the measurement by their covariances; the Kalman gain sets the blend.'),
  T('q2', 'Why is the gain optimal?', 'It minimises the trace of the posterior covariance, the expected squared error.'),
  T('q3', 'And what happens when the measurement noise covariance is huge?',
    'The gain shrinks and the filter trusts its prediction instead of the measurement.'),
  T('q4', 'Separately — my sourdough starter rises then collapses within four hours, flour hydration looks fine.',
    'Collapse after a fast rise usually means the starter peaked early; feed at a higher ratio or use cooler water.'),
  T('q5', 'It smells like acetone too, is that bad?', 'Acetone smell means it is hungry, not spoiled. Feed it more often.'),
];

test('terms drop filler words and keep the ones that carry meaning', () => {
  assert.deepEqual(terms('Can you explain the Kalman gain, please?'), ['kalman', 'gain']);
});

test('a change of subject is suggested; follow-ups are not', () => {
  const s = suggest(convo());
  assert.deepEqual(s.map((x) => x.startStableKey), ['q4']);
  assert.equal(s[0].suggested, true, 'always marked as a guess');
  assert.ok(s[0].reasons.length, 'and says why');
});

test('follow-up openers and pronouns count against a break', () => {
  const byKey = Object.fromEntries(score(convo()).map((c) => [c.key, c]));
  assert.ok(byKey.q3.reasons.includes('opens like a follow-up'));
  assert.ok(byKey.q5.reasons.includes('opens with “it” or “that”'));
  assert.ok(byKey.q5.score < 0);
});

test('a long pause alone is a strong signal', () => {
  const c = convo();
  c[2] = T('q3', 'And one more thing about the gain?', 'Sure.', 8 * 60);
  const byKey = Object.fromEntries(score(c).map((x) => [x.key, x]));
  assert.ok(byKey.q3.reasons.includes('a long break before it'));
});

test('breaks too close together keep only the stronger', () => {
  const c = [
    T('a', 'Tell me about volcanic eruptions and magma chambers under calderas.', 'Magma chambers feed eruptions.'),
    T('b', 'Completely unrelated: best practices for PostgreSQL index maintenance schedules?', 'Reindex and vacuum.', 60),
    T('c', 'Different again: medieval Japanese castle architecture and stone foundations?', 'Stone bases resisted earthquakes.', 400),
    T('d', 'What about the wooden keeps above those foundations?', 'Built of timber.'),
  ];
  const s = suggest(c);
  assert.equal(s.length, 1);
  assert.equal(s[0].startStableKey, 'c', 'the stronger of two adjacent candidates wins');
});

test('turns that already start a section are left alone', () => {
  assert.deepEqual(suggest(convo(), [{ startStableKey: 'q4', title: 'Bread' }]), []);
});

test('the first exchange is never a suggested break — a conversation does not begin with one', () => {
  assert.ok(!suggest(convo()).some((s) => s.startStableKey === 'q1'));
});

test('titles are the opening clause, without the preamble', () => {
  assert.equal(titleFor(T('x', 'Can you explain entropy from first principles, and flag the shortcuts?', '')),
    'Entropy from first principles, and flag the…');
  assert.equal(titleFor(T('x', 'Okay, the partition function. How does it connect?', '')), 'The partition function');
  assert.equal(titleFor({ user: null, replies: [] }), 'Untitled section');
});

test('suggestions group like real sections, and carry their flag through', () => {
  const c = convo();
  const g = group(c, suggest(c));
  assert.deepEqual(g.map((x) => x.turns.length), [3, 2]);
  assert.equal(g[1].suggested, true);
  assert.equal(g[0].suggested, false);
});

test('deterministic: the same conversation always gets the same suggestions', () => {
  assert.deepEqual(suggest(convo()), suggest(convo()));
});

test('nothing is suggested in a chat too short to have topics', () => {
  assert.deepEqual(suggest(convo().slice(0, 3)), []);
});

test('nothing is suggested right next to a section you made', () => {
  assert.deepEqual(suggest(convo(), [{ startStableKey: 'q5', title: 'Acetone' }]), [],
    'q4 would leave a one-exchange section before q5');
});

test('the last exchange on its own is not suggested as a section', () => {
  const c = convo().slice(0, 4);
  assert.deepEqual(suggest(c), [], 'q4 is the last exchange here');
});
