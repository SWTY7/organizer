/**
 * Writes fixtures/library.chatpack.json — a synthetic library for UI work.
 *
 * Realistic in shape, invented in content: two providers, Claude projects that
 * seed folders, long and short conversations, every block type, a real branch,
 * attachments with and without extracted text. Nothing in it came from a real
 * account, so it is safe to commit.
 *
 *   node tools/make-fixture.mjs
 */
import { writeFile } from 'node:fs/promises';

let clock = Date.UTC(2026, 5, 2, 9, 0);
const tick = (min = 3) => new Date((clock += min * 60_000)).toISOString();
let seq = 0;
const id = (p) => `${p}-${(++seq).toString(36).padStart(4, '0')}`;

const text = (t) => ({ type: 'text', text: t });
const code = (lang, t) => ({ type: 'code', lang, text: t });
const think = (...s) => ({ type: 'thinking', summaries: s });

function msg(role, parentId, content) {
  const m = { id: id('m'), parentId, role, createdAt: tick(role === 'user' ? 3 : 2), content };
  return { ...m, stableKey: m.id, status: 'complete', hidden: false };
}

// Messages on branches off the current path. Numbered apart from the rest, so
// adding a branch here does not renumber every conversation after it — and a
// re-import of the regenerated file still matches what is already imported.
let bseq = 0;
function bmsg(role, parentId, content, after) {
  const n = ++bseq;
  const m = { id: `b-${n.toString(36).padStart(4, '0')}`, parentId, role,
    createdAt: new Date(Date.parse(after) + n * 60_000).toISOString(), content };
  return { ...m, stableKey: m.id, status: 'complete', hidden: false };
}

function conv({ provider = 'claude', title, project, model, turns, branchAt, regen, edit, gapDays = 2 }) {
  clock += gapDays * 86_400_000;
  const cid = id('conv');
  const messages = [];
  let parent = null;
  let branchParent = null;
  let editParent;
  for (const [i, [q, ...a]] of turns.entries()) {
    if (edit && i === edit.at) editParent = parent;
    const u = msg('user', parent, Array.isArray(q) ? q : [text(q)]);
    const r = msg('assistant', u.id, a);
    messages.push(u, r);
    if (i === branchAt) branchParent = u.id;
    parent = r.id;
  }
  // A regenerate: a second reply to the same question, off the current path.
  if (branchParent) {
    messages.push(msg('assistant', branchParent, regen || [text(
      'A shorter take on the same question, from a regenerate. It is a sibling of the reply ' +
      'above, so the reader has to be able to show both.')]));
  }
  // An edited question: a second version of turn `edit.at`, which then went on
  // for a few turns of its own before you came back to the original.
  if (edit && editParent !== undefined) {
    let at = messages.at(-1).createdAt;
    let par = editParent;
    for (const [q, ...a] of edit.turns) {
      const u = bmsg('user', par, [text(q)], at);
      const r = bmsg('assistant', u.id, a, u.createdAt);
      messages.push(u, r);
      par = r.id; at = r.createdAt;
    }
  }
  return {
    schemaVersion: '0.2', kind: 'conversation', id: cid, provider,
    providerConvId: cid, title,
    createdAt: messages[0].createdAt, updatedAt: messages.at(-1).createdAt,
    model: model || (provider === 'claude' ? 'claude-opus-5' : 'gpt-5'),
    currentLeafId: parent,
    ...(project ? { projectRef: { id: `p-${project}`, name: project } } : {}),
    messages,
  };
}

const OPENERS = ['The key point', 'In practice', 'Put differently', 'One subtlety', 'This matters because'];
const prose = (n, topic) => Array.from({ length: n }, (_, i) =>
  `${OPENERS[i % 5]} is that ${topic} behaves the way it does for a structural reason, not an ` +
  'accidental one, and once you see that reason the rest follows.').join(' ');

const conversations = [
  conv({
    title: 'Small oscillations — Landau & Lifshitz §21', project: 'Physics', branchAt: 1,
    regen: [text('Because of **power counting**. $\\dot x$ is small, so $a_{ik}(q)\\,\\dot x_i \\dot x_k$ is already second order. Keeping more terms of $a_{ik}$ only adds third-order corrections. In $U$, the $x_i x_k$ terms are the leading order that does anything.')],
    turns: [
      ['Walk me through why the Lagrangian for small oscillations is a quadratic form.',
        think('Expand U about the minimum', 'Linear term vanishes at equilibrium', 'Kinetic term evaluated at q0'),
        text([
          '## Expanding about equilibrium', '',
          'At a stable equilibrium $q_0$ the potential has a minimum, so $\\partial U/\\partial q = 0$ there. Expanding to second order,', '',
          '$$U(q) \\approx U(q_0) + \\tfrac12 \\sum_{ik} k_{ik}\\, x_i x_k$$', '',
          'with $x = q - q_0$. The constant drops out of the equations of motion, and the linear term is zero **by the definition of equilibrium**. What survives is quadratic.', '',
          '## The kinetic term', '',
          '$T = \\tfrac12 \\sum a_{ik}(q)\\, \\dot q_i \\dot q_k$ is already quadratic in velocities; to lowest order you evaluate $a_{ik}$ at $q_0$.',
        ].join('\n'))],
      ['Why is it legitimate to freeze a_ik at q0 but keep the x terms in U?',
        text('Because of **order counting**. $\\dot x$ is itself small, so $a_{ik}(q)\\,\\dot x_i \\dot x_k$ is already second order. Expanding $a_{ik}$ further only adds third-order terms. In $U$, the $x_i x_k$ terms *are* the leading non-trivial order.')],
      ['So the normal modes come from det(k − ω²m) = 0?',
        text('Yes. Substituting $x_k = A_k e^{-i\\omega t}$ gives\n\n$$\\sum_k (k_{ik} - \\omega^2 m_{ik}) A_k = 0,$$\n\nwhich has non-trivial solutions only when the determinant vanishes: the **characteristic equation**, whose roots are the squared eigenfrequencies.'),
        code('python', 'import numpy as np\nk = np.array([[2, -1], [-1, 2]])\nm = np.eye(2)\nw2, modes = np.linalg.eigh(np.linalg.solve(m, k))\nprint(np.sqrt(w2))  # [1.0, 1.732]')],
      ['What about degenerate frequencies?', text(prose(3, 'a degenerate eigenvalue'))],
    ],
  }),
  conv({
    title: 'Kalman filter from first principles', project: 'Physics', model: 'claude-sonnet-5',
    turns: [
      ['Derive the Kalman gain without hand-waving.',
        think('State the model', 'Minimise the trace of the posterior covariance'),
        text('The gain is whatever minimises the expected squared error of the updated estimate. Writing the posterior covariance as a function of $K$ and setting $\\partial\\, \\mathrm{tr}\\,P/\\partial K = 0$ gives\n\n$$K = P^- H^T (H P^- H^T + R)^{-1}.$$')],
      ['Intuition for when K is large vs small?',
        text('| situation | K | you trust |\n|---|---|---|\n| noisy sensor, R large | small | the model |\n| uncertain model, P large | large | the measurement |\n\nThe gain is a ratio of uncertainties, nothing more.')],
    ],
  }),
  conv({
    title: 'Rust: why does the borrow checker reject this?', project: 'Coding',
    edit: { at: 1, turns: [
      ['What if I need a reference that lives across the push?',
        text('Then the borrow checker is right to stop you: no reference into the vector can survive a reallocation. Store an index, or put the elements behind `Rc` so the vector holds pointers and a reallocation moves only those.')],
      ['Show the Rc version.',
        code('rust', 'use std::rc::Rc;\nlet mut v = vec![Rc::new(String::from("a"))];\nlet first = Rc::clone(&v[0]);\nv.push(Rc::new(String::from("b")));\nprintln!("{first}");')],
    ] },
    turns: [
      [[text('This fails to compile and I do not see why:'),
        code('rust', 'let mut v = vec![1, 2, 3];\nlet first = &v[0];\nv.push(4);\nprintln!("{first}");')],
        text('`push` may reallocate the vector, which would leave `first` pointing at freed memory. Rust refuses because the shared borrow `first` is still alive when `push` takes a mutable one.'),
        code('rust', 'let mut v = vec![1, 2, 3];\nlet first = v[0];   // copy the value instead of borrowing it\nv.push(4);\nprintln!("{first}");')],
      ['And if the element is not Copy?',
        text('Clone it, restructure so the borrow ends before the push, or hold an index rather than a reference. The index is usually the cleanest.')],
    ],
  }),
  conv({
    title: 'Refactor React context to a store', project: 'Coding', provider: 'chatgpt',
    turns: [
      [[text('Here is the context we have. It re-renders everything:'),
        { type: 'file', filename: 'AppContext.tsx', mime: 'tsx', meta: { declaredBytes: 312 },
          text: 'export const AppContext = createContext(null);\nexport function AppProvider({ children }) {\n  const [user, setUser] = useState(null);\n  const [theme, setTheme] = useState("light");\n  return <AppContext.Provider value={{ user, setUser, theme, setTheme }}>{children}</AppContext.Provider>;\n}' }],
        text('Every consumer re-renders whenever *any* field changes, because the `value` object is new on every render. A store with selectors fixes that: components subscribe to the slice they read.'),
        code('ts', 'export const useApp = create((set) => ({\n  user: null,\n  theme: "light",\n  setTheme: (theme) => set({ theme }),\n}));\n\nconst theme = useApp((s) => s.theme);  // re-renders only on theme')],
      ['Does this break SSR?', text(prose(2, 'a module-level store under SSR'))],
      ['How would you migrate incrementally?',
        text('Wrap the store in the old context first so both APIs work, then move consumers over one at a time. Delete the provider last.')],
    ],
  }),
  conv({
    title: 'Kyoto in late October — five days', project: 'Travel', provider: 'chatgpt', gapDays: 5,
    turns: [
      ['Plan five days in Kyoto, late October, not too rushed.',
        text('- **Day 1** — Higashiyama on foot: Kiyomizu-dera early, Sannenzaka, Yasaka.\n- **Day 2** — Arashiyama before 8am, then the Okochi Sanso garden.\n- **Day 3** — a day trip to Nara.\n- **Day 4** — Fushimi Inari at dawn; Tofuku-ji for early colour.\n- **Day 5** — Daitoku-ji sub-temples and a slow last afternoon.'),
        { type: 'image', filename: 'kyoto-map.png', width: 1456, height: 817 }],
      ['Is late October too early for autumn leaves?',
        text('Usually, for peak colour, which tends to arrive mid to late November. Tofuku-ji and the northern hills turn first.')],
    ],
  }),
  conv({
    title: 'Notes on the uploaded decoherence review', project: 'Physics',
    turns: [
      [[text('Summarise the argument in section 3.'),
        { type: 'file', filename: 'decoherence-review.pdf', mime: 'pdf', meta: { declaredBytes: 38761 },
          text: '3. Environment-induced superselection\n\nThe system couples to many environmental degrees of freedom. Tracing them out suppresses off-diagonal terms in the pointer basis...' }],
        text('Section 3 argues that the preferred basis is picked out dynamically: the states that survive coupling to the environment are the ones the interaction leaves unentangled.')],
    ],
  }),
  conv({
    title: 'Sourdough starter keeps going flat', gapDays: 1,
    turns: [['My starter rises then collapses within four hours.',
      text('That is usually a hungry starter, not a weak one. Feed at a higher ratio — 1:5:5 — and it will peak later and hold.')]],
  }),
  conv({
    title: 'What makes a commit message useful', provider: 'chatgpt', gapDays: 1,
    turns: [['What makes a commit message actually useful?',
      text('It says *why*. The diff already says what changed. A future reader needs the reason, the alternative you rejected, and anything surprising you found on the way.')]],
  }),
  conv({
    title: 'Long session — thermodynamics from scratch', project: 'Physics', gapDays: 1,
    turns: ['temperature', 'entropy', 'free energy', 'the partition function', 'phase transitions',
      'heat capacity', 'the third law', 'Maxwell relations', 'chemical potential', 'the Gibbs paradox',
    ].map((t, i) => [
      i % 3 === 0 ? `Explain ${t} from first principles, and flag where textbooks cut corners.` : `What about ${t}?`,
      ...(i % 4 === 1 ? [think('Recall the definition', 'Check the limiting case')] : []),
      text(`## ${t[0].toUpperCase()}${t.slice(1)}\n\n${prose(2 + (i % 3), t)}`),
      ...(i % 3 === 0 ? [code('python', `# ${t}\nimport numpy as np`)] : []),
    ]),
  }),
];

const pack = {
  schemaVersion: '0.2', kind: 'chatpack',
  createdAt: '2026-09-18T00:00:00.000Z',
  generator: 'tools/make-fixture.mjs — synthetic, safe to commit',
  conversations,
};
await writeFile(new URL('../fixtures/library.chatpack.json', import.meta.url), JSON.stringify(pack, null, 1));
console.log(`fixtures/library.chatpack.json — ${conversations.length} conversations, ` +
  `${conversations.reduce((n, c) => n + c.messages.length, 0)} messages`);
