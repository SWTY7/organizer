# organizer

One library for your AI chats — across Claude, ChatGPT and whatever comes next.

Claude has Projects. ChatGPT has folders. Neither can hold the other's
conversations, neither lets you highlight an answer or pin a note to it, and
neither helps you find the one chat where you actually worked something out.
This is a library and annotation layer over chats you already had.

**Status: Phase 3 — capture, read and organize.** Pick your chats, import them, file
them into folders and tags, and search everything. Annotation comes next. See [PLAN.md](PLAN.md).

## Design rules

These are constraints, not aspirations. Any change that violates one needs a
better reason than convenience.

1. **Easy to use wins over easy to build.** Fewer steps for the user, even when
   it costs more implementation work. No config files to hand-edit, no build
   step before you can try something, no settings screen where a good default
   would do.
2. **Your data stays yours.** Local-first. No account, no server, no telemetry,
   no network calls in the app at all. This isn't a privacy policy, it's an
   architecture.
3. **Never destroy an import.** Captured conversations are immutable. Your
   edits, notes and organization live in a separate overlay, and you can always
   see the original.
4. **No re-exporting.** Requesting a full account export every time you want to
   file one conversation is the problem, not the solution. Capture is one click
   and incremental.
5. **One format in.** The app ingests `.chat` files and nothing else
   ([SPEC.md](SPEC.md)). Provider-specific code lives in capturers, which is
   the part that breaks when a provider changes something.

## How it fits together

```
  ┌─────────────┐   .chat file   ┌──────────────┐
  │  capturers  │ ─────────────► │  organizer   │
  │ (extension, │                │ (web app +   │
  │  zip import,│                │  SQLite WASM)│
  │  paste, …)  │                │              │
  └─────────────┘                └──────────────┘
```

Adding a provider means writing a capturer. The app never learns what
"ChatGPT" means.

## Running it

```bash
npm start
```

Opens the reader at `http://localhost:4173`. No dependencies to install — the
server is ~40 lines of plain Node.

You can open `app/index.html` directly instead, and it works, but **nothing will
be saved**: browsers deny storage to pages loaded from `file://`. The app
detects this and says so rather than silently losing your library.

To get chats in, load [`extension/`](extension/) unpacked in Chrome, pick the
conversations you want, and drop the downloaded file onto the app. The console
scripts in [`tools/`](tools/) do the same thing with no install, as a fallback.

To typeset maths instead of showing TeX source, once:

```bash
npm run math
```

That vendors KaTeX locally. The app itself never touches the network.

## Repository

| Path | What |
|---|---|
| [`PLAN.md`](PLAN.md) | full plan, phases, risks |
| [`SPEC.md`](SPEC.md) | the `.chat` interchange format |
| [`DESIGN.md`](DESIGN.md) | the reader's layout, interaction rules and tokens |
| [`READING.md`](READING.md) | ways to read one long conversation |
| [`packages/adapters/`](packages/adapters/) | one file per provider — the reusable core |
| [`packages/organize/`](packages/organize/) | folder tree, outline and section logic — pure, tested |
| [`app/`](app/) | the reader — plain ES modules, no build step, no dependencies |
| [`extension/`](extension/) | one-click capture with a selection list |
| [`tools/`](tools/) | pasteable probe + exporter, and [what the probes found](tools/FINDINGS.md) |
| [`fixtures/`](fixtures/) | synthetic `.chat` files — `library.chatpack.json` is a whole demo library, from `tools/make-fixture.mjs` |

## Phases

- [x] **0 — spike.** Endpoints, shapes and delta-sync viability confirmed against live data.
- [x] **1 — format + reader.** `.chat` parser, import, browse, full-text search.
- [x] **2 — capturer.** One-click capture with a selection list, and delta sync.
- [x] **3 — organizer.** Folders, tags, saved searches, bulk actions, drag-to-file.
- [ ] **4 — reading.** Nested folders ✅, the explorer redesign ✅
      ([`DESIGN.md`](DESIGN.md)), Transcript / Outline / Focus / Columns ✅,
      sections ✅; next 2D branches — [`READING.md`](READING.md).
- [ ] **0b — asset probe.** Are uploaded files retrievable? Read-only, 20 minutes.
- [ ] **5 — assets.** Images and attachments captured for real; sandboxed SVG and
      HTML; artifacts reconstructed.
- [ ] **6 — notes and links.** Notes as documents, `[[links]]`, backlinks, highlights.
- [ ] **7 — graph.** Conversations, folders, tags and notes as a map you can fly around.
- [ ] **8 — power.** Semantic search, compile snippets, more providers.

## A note on capture

The extension calls the same internal JSON endpoints the provider's own web app
calls, using your existing browser session, to retrieve your own conversations.
Those endpoints are undocumented and can change without notice, and automated
access sits in a gray area of both providers' terms. This is a personal
archival tool: it rate-limits itself, it is not a service, and the app stays
fully usable through official zip exports when a capturer breaks.
