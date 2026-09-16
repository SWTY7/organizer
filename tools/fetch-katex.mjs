#!/usr/bin/env node
/**
 * Downloads KaTeX into app/vendor/katex/ so the reader can typeset maths.
 *
 * The app itself makes no network calls — that is design rule 2 — so this is a
 * deliberate, explicit, one-time fetch you run yourself:
 *
 *     npm run math
 *
 * Without it the reader still works and shows maths as monospace source.
 * Nothing here is committed; app/vendor/ is gitignored.
 */

import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '0.16.11';
const BASE = `https://cdn.jsdelivr.net/npm/katex@${VERSION}/dist`;
const OUT = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'app', 'vendor', 'katex');

/* Only woff2 is fetched: every browser that runs this app supports it, and the
   stylesheet lists it first, so the woff/ttf fallbacks are never requested. */
const FONTS = [
  'KaTeX_AMS-Regular', 'KaTeX_Caligraphic-Bold', 'KaTeX_Caligraphic-Regular',
  'KaTeX_Fraktur-Bold', 'KaTeX_Fraktur-Regular', 'KaTeX_Main-Bold',
  'KaTeX_Main-BoldItalic', 'KaTeX_Main-Italic', 'KaTeX_Main-Regular',
  'KaTeX_Math-BoldItalic', 'KaTeX_Math-Italic', 'KaTeX_SansSerif-Bold',
  'KaTeX_SansSerif-Italic', 'KaTeX_SansSerif-Regular', 'KaTeX_Script-Regular',
  'KaTeX_Size1-Regular', 'KaTeX_Size2-Regular', 'KaTeX_Size3-Regular',
  'KaTeX_Size4-Regular', 'KaTeX_Typewriter-Regular',
];

async function grab(path) {
  const res = await fetch(`${BASE}/${path}`);
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  console.log(`\n  fetching KaTeX ${VERSION} from jsdelivr…`);
  await mkdir(join(OUT, 'fonts'), { recursive: true });

  let bytes = 0;
  for (const f of ['katex.min.css', 'katex.min.js']) {
    const buf = await grab(f);
    await writeFile(join(OUT, f), buf);
    bytes += buf.length;
    console.log(`    ${f}`);
  }

  // Fonts in parallel — 20 small files, no reason to serialise.
  const results = await Promise.allSettled(FONTS.map(async (name) => {
    const file = `${name}.woff2`;
    const buf = await grab(`fonts/${file}`);
    await writeFile(join(OUT, 'fonts', file), buf);
    return buf.length;
  }));

  const failed = results.filter((r) => r.status === 'rejected');
  bytes += results.filter((r) => r.status === 'fulfilled').reduce((a, r) => a + r.value, 0);
  console.log(`    fonts/ (${results.length - failed.length}/${FONTS.length})`);
  if (failed.length) {
    console.warn(`\n  ${failed.length} font(s) failed:`);
    for (const f of failed) console.warn(`    ${f.reason.message}`);
  }

  console.log(`\n  done — ${(bytes / 1024 / 1024).toFixed(1)} MB in app/vendor/katex/`);
  console.log('  restart the reader (or just reload) and maths will typeset.\n');
}

main().catch((e) => {
  console.error(`\n  failed: ${e.message}`);
  console.error('  the reader still works; maths will show as monospace source.\n');
  process.exit(1);
});
