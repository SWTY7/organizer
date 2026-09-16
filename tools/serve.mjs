#!/usr/bin/env node
/**
 * Minimal static server for the reader.
 *
 * Why this exists: Chrome denies IndexedDB to `file://` and other opaque
 * origins, so opening app/index.html by double-clicking gives you a working
 * app that cannot remember anything. Serving it over http://localhost gives it
 * a real origin and persistence works.
 *
 * Deliberately dependency-free — `npm start`, nothing to install.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 4173;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);

    // Redirect rather than serving the app at "/": relative URLs in the page
    // (vendor/katex/…) must resolve against /app/, not the project root.
    if (path === '/') {
      res.writeHead(302, { location: '/app/' }).end();
      return;
    }
    if (path.endsWith('/')) path += 'index.html';

    // Refuse anything that escapes the project root.
    const full = join(ROOT, normalize(path));
    if (!full.startsWith(ROOT + sep)) {
      res.writeHead(403).end('forbidden');
      return;
    }

    const body = await readFile(full);
    res.writeHead(200, {
      'content-type': TYPES[extname(full).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
    }).end(body);
  } catch (e) {
    res.writeHead(e.code === 'ENOENT' ? 404 : 500).end(e.code === 'ENOENT' ? 'not found' : 'error');
  }
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}/`;
  console.log(`\n  organizer  ->  ${url}\n  serving ${ROOT}\n  ctrl-c to stop\n`);
  // Best effort; not worth failing the server over.
  const cmd = process.platform === 'win32' ? 'start ""'
    : process.platform === 'darwin' ? 'open' : 'xdg-open';
  import('node:child_process')
    .then(({ exec }) => exec(`${cmd} ${url}`))
    .catch(() => {});
});
