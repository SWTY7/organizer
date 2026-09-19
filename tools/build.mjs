#!/usr/bin/env node
/**
 * Bundles the adapter modules into single pasteable console scripts.
 *
 * Why this exists: the adapters are split per provider so a new LLM is one new
 * file, but a DevTools console can't import local modules. So the sources stay
 * modular and this produces one self-contained file per tool.
 *
 * Deliberately dependency-free — `node tools/build.mjs`, nothing to install.
 * It is a concatenator, not a real bundler: it assumes the module graph is the
 * fixed list below and that imports are only used for names defined in it.
 */

import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Dependency order. Shared first, adapters, then the registry. */
const MODULES = [
  'packages/adapters/shared.js',
  'packages/adapters/zip.js',
  'packages/adapters/capture.js',
  'packages/adapters/claude.js',
  'packages/adapters/chatgpt.js',
  'packages/adapters/index.js',
];

const TOOLS = [
  { entry: 'tools/probe.entry.js', out: 'tools/dist/probe.js', name: 'probe' },
  { entry: 'tools/export.entry.js', out: 'tools/dist/export.js', name: 'export' },
  { entry: 'tools/assets.entry.js', out: 'tools/dist/assets.js', name: 'assets' },
];

/** Strip module syntax so the pieces can be concatenated into one scope. */
function strip(src) {
  return src
    // import { a, b } from '…';  /  import x from '…';
    .replace(/^import\s*\{[\s\S]*?\}\s*from\s*['"][^'"]+['"];?[ \t]*$/gm, '')
    .replace(/^import\s+[\w$]+\s+from\s*['"][^'"]+['"];?[ \t]*$/gm, '')
    // export const / function / async function / class …
    .replace(/^export\s+(?=(const|let|var|function|async|class)\b)/gm, '')
    .trim();
}

const HEADER = (name) => `/*
 * ORGANIZER — ${name}.js  (GENERATED — do not edit)
 * ===========================================================================
 * Built from packages/adapters/ by tools/build.mjs. Edit the sources there.
 *
 * Paste this whole file into the DevTools console on a supported site. It
 * detects which provider you are on and runs the matching adapter.
 *
 * Nothing is uploaded anywhere. It reads the site you are already on, using
 * the session you already have.
 *
 * If Chrome blocks the paste, type:  allow pasting
 */
`;

/**
 * Concatenating modules into one scope means two files declaring the same
 * top-level name collide. That already happened once (both adapters had a
 * module-level `const http`), and the failure surfaces as a syntax error in
 * generated code rather than at the source, so check for it here.
 */
function checkCollisions(named) {
  const seen = new Map();
  const dupes = [];
  for (const [file, src] of named) {
    const re = /^(?:const|let|var|function|async function|class)\s+([\w$]+)/gm;
    for (const m of src.matchAll(re)) {
      const name = m[1];
      if (seen.has(name)) dupes.push(`${name}  (${seen.get(name)} and ${file})`);
      else seen.set(name, file);
    }
  }
  if (dupes.length) {
    throw new Error(
      'Top-level name collision between modules — they share one scope once bundled:\n  ' +
      dupes.join('\n  ') +
      '\nRename, or move the state onto the adapter object.'
    );
  }
}

async function build() {
  const modules = [];
  const named = [];
  for (const m of MODULES) {
    const stripped = strip(await readFile(join(root, m), 'utf8'));
    named.push([m, stripped]);
    modules.push(`// ---- ${m} ----\n` + stripped);
  }
  checkCollisions(named);

  await mkdir(join(root, 'tools/dist'), { recursive: true });

  for (const t of TOOLS) {
    const entry = strip(await readFile(join(root, t.entry), 'utf8'));
    const bundle = [
      HEADER(t.name),
      '(() => {',
      modules.join('\n\n'),
      `\n// ---- ${t.entry} ----`,
      entry,
      '})();',
      '',
    ].join('\n');
    await writeFile(join(root, t.out), bundle, 'utf8');
    const kb = (Buffer.byteLength(bundle) / 1024).toFixed(1);
    console.log(`  ${t.out.padEnd(24)} ${kb} KB`);
  }
  // The extension loads the adapters as real ES modules, so it just needs
  // copies inside its own directory — Chrome cannot reach outside it.
  const extDir = join(root, 'extension', 'adapters');
  await mkdir(extDir, { recursive: true });
  for (const m of MODULES) {
    const name = m.split('/').pop();
    await copyFile(join(root, m), join(extDir, name));
  }
  console.log(`  extension/adapters/     ${MODULES.length} modules copied`);

  console.log('done');
}

build().catch((e) => {
  console.error(e);
  process.exit(1);
});
