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
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { zip, crc32 } from '../packages/adapters/zip.js';

/* ------------------------------------------------ attachments, made here */
// A real PNG and a real PDF, generated rather than committed as binaries, so
// the zip fixture exercises saved images and files end to end.

const sha = (b) => createHash('sha256').update(b).digest('hex');
function png(w, h, px) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(px(x, y), y * (w * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// A shopfront, roughly: sky, a green awning with stripes, a brown door.
const STOREFRONT = png(160, 100, (x, y) => (y < 30 ? [196, 222, 240]
  : y < 44 ? ((x >> 3) & 1 ? [107, 143, 78] : [245, 239, 230])
    : x > 66 && x < 94 && y > 58 ? [120, 84, 52] : [236, 226, 208]));
const MENU_PDF = Buffer.from([
  '%PDF-1.4', '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
  '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj',
  '4 0 obj<</Length 60>>stream', 'BT /F1 18 Tf 30 150 Td (Leaf & Kettle - menu) Tj ET', 'endstream endobj',
  '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj', 'trailer<</Root 1 0 R>>', '%%EOF',
].join('\n'));
const BLOBS = new Map([[sha(STOREFRONT), STOREFRONT], [sha(MENU_PDF), MENU_PDF]]);

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
  // Appended last so no earlier id shifts. Artifacts arrive as tool calls, the
  // way Claude sends them; the reader has to rebuild the finished documents.
  conv({
    title: 'Landing page and a logo', project: 'Coding',
    turns: [
      [[text('Make me a one-page landing site for a tea shop. Here is the shopfront, for colours.'),
        { type: 'image', filename: 'storefront.png', mime: 'image/png', width: 160, height: 100,
          blobHash: sha(STOREFRONT), srcRef: 'https://claude.ai/api/example/files/storefront/preview' }],
        text('Here is a first version.'),
        { type: 'tool_use', name: 'artifacts', id: 'tu1', input: { command: 'create', id: 'tea-landing', type: 'text/html', title: 'Tea shop landing page',
          content: '<!doctype html>\n<html><head><style>body{font-family:Georgia,serif;margin:0;background:#f5efe6;color:#2d2a26}header{padding:48px;text-align:center}h1{font-size:40px;margin:0}p{color:#6b5f52}</style></head>\n<body><header><h1>Leaf &amp; Kettle</h1><p>Loose-leaf tea, brewed slowly.</p></header></body></html>' } },
        { type: 'tool_result', toolUseId: 'tu1', text: 'OK' }],
      [[text('Make the headline warmer and add opening hours — they are on the menu.'),
        { type: 'file', filename: 'menu.pdf', mime: 'application/pdf', blobHash: sha(MENU_PDF),
          text: 'Leaf & Kettle - menu', meta: { declaredBytes: MENU_PDF.length } }],
        { type: 'tool_use', name: 'artifacts', id: 'tu2', input: { command: 'update', id: 'tea-landing', old_str: 'Leaf &amp; Kettle', new_str: 'Welcome to Leaf &amp; Kettle' } },
        { type: 'tool_use', name: 'artifacts', id: 'tu3', input: { command: 'update', id: 'tea-landing', old_str: 'brewed slowly.</p>', new_str: 'brewed slowly.</p><p>Open daily, 8am – 6pm</p>' } },
        { type: 'tool_use', name: 'artifacts', id: 'tu4', input: { command: 'update', id: 'tea-landing', old_str: 'a string that is not there', new_str: 'x' } },
        text('Done — warmer headline, and hours under the tagline.')],
      ['Now a simple logo, as SVG.',
        { type: 'tool_use', name: 'artifacts', id: 'tu5', input: { command: 'create', id: 'tea-logo', type: 'image/svg+xml', title: 'Leaf & Kettle logo',
          content: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><circle cx="60" cy="60" r="56" fill="#f5efe6" stroke="#2d2a26" stroke-width="4"/><path d="M60 26c22 14 22 50 0 68c-22-18-22-54 0-68z" fill="#6b8f4e"/><path d="M60 30v60" stroke="#2d2a26" stroke-width="2"/></svg>' } },
        text('A leaf inside a circle. And a smaller mark you can paste anywhere:\n\n```svg\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="8" fill="#6b8f4e"/><text x="20" y="27" font-size="18" text-anchor="middle" fill="#fff" font-family="Georgia">L</text></svg>\n```')],
    ],
  }),
];

const pack = {
  schemaVersion: '0.2', kind: 'chatpack',
  createdAt: '2026-09-18T00:00:00.000Z',
  generator: 'tools/make-fixture.mjs — synthetic, safe to commit',
  conversations,
};
await writeFile(new URL('../fixtures/library.chatpack.json', import.meta.url), JSON.stringify(pack, null, 1));
// The same library as a .chatpack.zip, with the attachments in it — the shape
// the extension writes when it captures images and files.
const zipped = await zip([
  { name: 'manifest.json', data: JSON.stringify({ schemaVersion: '0.2', kind: 'chatpack', generator: pack.generator,
    capturedAt: pack.createdAt, conversationCount: conversations.length, providers: ['claude', 'chatgpt'], hasOverlay: false }, null, 1) },
  ...conversations.map((c) => ({ name: `conversations/${c.id}.chat.json`, data: JSON.stringify(c, null, 1) })),
  ...[...BLOBS].map(([hash, data]) => ({ name: `blobs/${hash}`, data: new Uint8Array(data) })),
]);
await writeFile(new URL('../fixtures/library.chatpack.zip', import.meta.url), zipped);
console.log(`fixtures/library.chatpack.zip — the same, plus ${BLOBS.size} attachments, ${(zipped.length / 1024).toFixed(1)} KB`);
console.log(`fixtures/library.chatpack.json — ${conversations.length} conversations, ` +
  `${conversations.reduce((n, c) => n + c.messages.length, 0)} messages`);
