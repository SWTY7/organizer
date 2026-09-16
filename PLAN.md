# LLM Chat Organizer — Plan

A local-first web app for importing, organizing, annotating and searching chat
histories from Claude, ChatGPT and anything else, in one place.

**Scope decisions (v1):** personal tool first, Claude + ChatGPT only, capture-led
rather than export-led.

## 1. Product thesis

The providers each give you a silo with weak organization. Claude Projects can't
hold a ChatGPT thread. ChatGPT folders can't hold a Gemini session. Nobody gives
you cross-provider collections, real highlighting, notes anchored to a specific
answer, or a way to harvest the good parts out of 400 chats.

So the product is not another chat UI. It is a **library + annotation layer**
over chats you already had. Four properties follow:

- **Imported content is immutable.** User edits live in an overlay, never
  destroying the original. Provenance stays honest.
- **Organization is orthogonal to source.** A folder can mix providers freely.
- **Local-first.** This is your entire thinking history. It should never need to
  leave your machine, and the app should work offline with no account.
- **Capture is incremental.** Requesting a full account export every time you
  want to file one conversation is untenable. See §4.

## 2. Architecture: local-first, three decoupled pieces

```
  ┌─────────────┐   .chat file   ┌──────────────┐
  │  capturers  │ ─────────────► │  organizer   │
  │ (extension, │                │ (web app +   │
  │  zip import,│                │  SQLite WASM)│
  │  paste, …)  │                │              │
  └─────────────┘                └──────────────┘
```

The **file format is the contract** (§5). The organizer ingests nothing else.
Capturers are independently replaceable and can be written by anyone, for any
provider, without touching the app.

Recommended host: a static web app (PWA) storing everything in the browser, no
backend at all.

| | Local-first (recommended) | Hosted backend |
|---|---|---|
| Trust required | none | full — you hold everyone's chat history |
| Hosting cost | $0 (static) | DB + storage + egress |
| Offline | yes | no |
| Cross-device sync | manual (export workspace file) | built in |
| Time to first usable build | days | weeks (auth, tenancy, uploads) |

Sync is the only real loss. Mitigation path, in order of cost: (a) export/import
a workspace file; (b) point the app at a folder in Drive/Dropbox/iCloud via the
File System Access API; (c) optional self-hosted sync server later. None require
changing the core, because the core is just a local SQLite database.

If this later needs to be a desktop app, wrap the same build in Tauri v2.

## 3. Canonical data model

Every provider maps into one shape. Get it right and new providers are cheap;
get it wrong and every feature grows per-provider special cases.

```ts
type Provider = 'claude' | 'chatgpt' | 'gemini' | 'claude-code' | 'generic'

interface Conversation {
  id: string              // internal uuid
  provider: Provider
  providerConvId: string  // native id — dedup key together with provider
  sourceId: string        // which import batch this came from
  title: string
  createdAt: number
  updatedAt: number
  model?: string
  sourceUrl?: string      // deep link back to the original chat
  currentLeafId?: string  // reconstructs the "main path" through the tree
  rawRef: string          // pointer to the untouched original payload
}

interface Message {
  id: string
  conversationId: string
  parentId: string | null // KEEP THE TREE — edits/regens are branches
  role: 'user' | 'assistant' | 'system' | 'tool'
  createdAt: number
  model?: string
  stableKey: string       // hash(provider, providerConvId, nativeMsgId)
}

interface ContentBlock {
  messageId: string
  seq: number
  type: 'text' | 'thinking' | 'code' | 'tool_use' | 'tool_result'
      | 'image' | 'file' | 'citation'
  text?: string
  mime?: string
  blobHash?: string       // content-addressed attachment
  meta?: Record<string, unknown>
}
```

Three non-obvious decisions:

**Keep the message tree.** Both ChatGPT (a `mapping` of nodes with
`parent`/`children`) and Claude have branches created by edits and
regenerations. Flattening to a list at import time throws away data you cannot
recover without re-fetching. Store the tree, render the main path by default,
expose branches as a UI affordance.

**Keep the raw payload.** Store each conversation's original JSON verbatim.
Adapters will be wrong in v1 — every one of them. With raw kept, you fix the
adapter and re-derive from what you already have.

**`stableKey` on messages.** This is what lets an annotation survive a
re-capture. Derived from provider-native ids, so the same message next month
resolves to the same key.

### Storage

SQLite compiled to WASM (`@sqlite.org/sqlite-wasm`) on an OPFS-backed VFS, in a
Web Worker. Reasons: real FTS5 full-text search with BM25 ranking, a relational
model that fits the data, one file to export as a workspace, no main-thread
blocking. IndexedDB plus a JS search index degrades badly past roughly 50MB, and
heavy users have 100MB+ histories.

Attachments go to OPFS as content-addressed blobs keyed by hash, so images
duplicated across overlapping captures cost storage once.

## 4. Capture: getting chats out without full exports

You were right that export-then-import is the wrong primary loop. Bulk export is
demoted to a **one-time backfill**; the daily loop is incremental capture.

### 4.1 Why the internal JSON API, not DOM scraping

Reading rendered HTML off the page gets strictly less than reading the JSON the
page itself fetched:

| | DOM scraping | Internal JSON API |
|---|---|---|
| Off-screen messages | missing — lists are virtualized | all present |
| Thinking / tool calls | usually stripped from DOM | present |
| Branches (edits, regens) | only the visible path | full tree |
| Timestamps, model, ids | partial, formatted for display | exact |
| Breaks when… | any CSS/markup change (frequent) | API shape changes (rare) |

Both are unofficial. The API route is simply the better-engineered version of
the same idea. Keep a DOM scraper as a last-resort fallback only.

**Endpoints — confirmed 2026-09-16** against live sites. Full results in
[`tools/FINDINGS.md`](tools/FINDINGS.md).

- ChatGPT: bearer token from `GET /api/auth/session` (cookies alone are **not**
  enough); list `GET /backend-api/conversations?offset=&limit=&order=updated`;
  detail `GET /backend-api/conversation/{id}`
- Claude: cookies suffice; pick the org whose `capabilities` include `chat` from
  `GET /api/organizations` (accounts can have several); list
  `GET /api/organizations/{org}/chat_conversations`; detail
  `…/chat_conversations/{uuid}?tree=True&rendering_mode=messages` — **those query
  params are mandatory**, without them there is no `content[]` and every
  thinking block is lost.

Both list endpoints carry an update timestamp, so **delta sync works**: diff the
list, fetch detail only for what changed.

The capturer must probe and fail loudly with a clear message if the shape has
changed, never silently import a half-parsed conversation.

### 4.2 Delivery mechanism

| Option | Install cost | Verdict |
|---|---|---|
| **Unpacked extension** (Chrome dev mode) | load a folder once | **Recommended.** No store review, no approval delay, full API access with your session, can run a bulk delta sync |
| Bookmarklet | none | Tempting, but both sites send CSP headers that may block `javascript:` execution. Test in the spike before betting on it |
| DevTools console snippet | none | Works today, good for the spike. Chrome requires typing "allow pasting" the first time. Too clunky for daily use |
| Published extension | store review | Only if this ever stops being a personal tool |

For a personal tool, an unpacked extension is the clear answer — it removes the
entire store-review risk that made me put this in Phase 4 originally.

**If this ever ships to other people**, the console-paste flow is not an option
and neither is a plain website. Same-origin policy means a page at
`organizer.app` cannot fetch `claude.ai/api/…` with the visitor's cookies, ever.
Only an extension (granted host permissions, fetching from its background
worker) or a desktop app with its own embedded login can do it. The ranking:

| Route | User effort | Catch |
|---|---|---|
| Extension, Web Store | one click | review takes days–weeks, $5 fee, and an extension built to pull data out of ChatGPT/Claude may draw policy scrutiny |
| Extension, unpacked | download, enable dev mode, load folder | no review, but four steps and a scary toggle — fine personally, fails design rule 1 for anyone else |
| Desktop app | install | cannot see browser cookies; needs its own embedded login. Reading Chrome's on-disk cookie store is technically possible and indistinguishable from malware — ruled out |

Note also that **neither provider offers an official API for web chat history**.
The Anthropic and OpenAI APIs cover API usage, not claude.ai/chatgpt.com
conversations, so there is no sanctioned route to swap to.

Public distribution should therefore be a Web Store extension with sync as a
**button by default** and scheduled background sync strictly opt-in. Silently
hitting a provider's API on a timer is both more fragile and more likely to read
as abuse.

### 4.3 The two capture modes

**One-click capture.** Button on a chat page. Grabs that conversation, writes a
`.chat` file (download, or hand off to an open organizer tab via `postMessage`).

**Delta sync.** The real fix for your complaint. List conversations, compare each
`updated_at` against what the library already has, fetch only what is new or
changed, emit one `.chatpack`. One click brings the whole library current. Rate
limit the fetches — a few per second, not a flood.

### 4.4 Fallback paths

- **Bulk export import** — the one-time backfill for everything predating the
  extension. ChatGPT: Settings → Data controls → Export. Claude: Settings →
  Privacy → Export data. Both arrive by email as a zip; links expire 24h.
- **Paste** — a textarea parsing pasted Markdown transcripts. Ugly, always works,
  zero maintenance. Worth having precisely because it can never break.
- **Claude Code JSONL** — local session logs under `~/.claude/projects/`. No
  network, already structured. Cheap adapter if you want coding sessions in the
  library too.

### 4.5 The honest caveat

This uses undocumented endpoints with your own session to retrieve your own
conversations. That is ordinary personal archival, but it is automated access,
which sits in a gray area of both providers' terms, and the endpoints can change
without notice. For a personal tool that is a maintenance question rather than a
legal one. It does mean: keep the capturer in a separate package, and make sure
the app stays fully usable via §4.4 when a capturer breaks.

## 5. The `.chat` format

Your instinct here was the important one. Defining the interchange format early
is what makes everything else swappable.

**Two artifacts:**

- **`.chat.json`** — one conversation, plain readable JSON. Diffable, greppable,
  git-friendly, trivially converted to an OpenAI-style `messages[]` array (a
  constraint worth honoring, since that's the de facto lingua franca).
- **`.chatpack`** — a zip for libraries and anything with attachments:

```
manifest.json          # schemaVersion, generator, provider, counts, capturedAt
conversations/*.json   # one .chat.json per conversation
blobs/<sha256>         # content-addressed attachments
overlay.json           # OPTIONAL: folders, tags, notes, highlights
```

**Design rules:**

1. `schemaVersion` on every file. Old files must keep importing forever.
2. Mirrors the canonical model in §3 — one shape to learn, not two.
3. `raw` is an optional passthrough field, so a capturer can preserve the
   provider's original payload without the format having to model every quirk.
4. `overlay.json` is separable. Share conversations without your private notes.
5. Spec lives in `SPEC.md` with example files, versioned alongside the code.

This also makes the organizer's import path trivial: one parser, not N adapters.
Provider-specific knowledge lives entirely in capturers, which is exactly where
it should be — the part that has to change when a provider changes.

## 6. Organizing

Imported data is read-only; everything here lives in separate overlay tables.

- **Folders** — a tree, one parent per conversation, for "where does this live".
- **Tags** — many-to-many, for cross-cutting facets. Both, not one; they answer
  different questions, and users will force one to do the other's job otherwise.
- **Smart folders** — a saved query (provider, date range, model, tag, text) that
  stays live. Where this beats Projects: "everything about the thesis, any
  provider, last 3 months" maintains itself.
- **Manual ordering** via fractional indexing, so drag-to-reorder is one write.
- Pin, star, archive, read-later queue.
- Bulk actions from the list view — multi-select, tag, move, archive.

## 7. Annotating and modifying

- **Notes** at conversation level and at individual message level.
- **Highlights** over text ranges inside a message. Anchor by
  `(stableKey, quoted text, offset)`, re-anchoring fuzzily on the quote if the
  offset drifts — the approach Hypothesis uses. Without this, every re-capture
  silently orphans annotations.
- **Snippet library.** Select text in any chat, clip it. Clips collect into a
  cross-chat document with backlinks to source. The highest-value feature in the
  plan: it turns a chat archive into usable material.
- **Overlay edits.** Corrections, trimming, rewriting — stored as a revision on
  top of the immutable original, with a toggle to view the original and a visible
  "edited" marker.
- **Redact** — hide a range or message when sharing an export.
- Tags on messages, not only conversations.

## 8. Search

FTS5 over message text, filtered by provider, date range, model, role, folder,
tag, has-code, length. BM25 ranking, grouped by conversation, snippet
highlighting.

Semantic search (local embeddings via transformers.js) is later and optional.
Useful for "that chat where I worked out the damping thing", but it costs an
embedding pass over the corpus plus a vector index — off the critical path.

## 9. Stack

- Vite + React + TypeScript (app), plain TS + Manifest V3 (extension)
- SQLite WASM + OPFS, in a Web Worker
- Tailwind + Radix/shadcn
- TanStack Virtual — conversations run to thousands of messages
- `fflate` for zips, in a worker
- `react-markdown` + `remark-gfm` + Shiki for code, KaTeX for math
- Vitest for format and capturer fixture tests
- Optional later: Tauri v2 desktop shell

No telemetry, no network calls in the organizer. That's a feature; put it in the
README.

## 10. Phases

**Phase 0 — spike. ✅ Done 2026-09-16.** Probed both sites live. Delta sync
confirmed viable on both; branching confirmed real (67 nodes vs a 61-node main
path); Claude's `tree=True` found to be mandatory rather than optional; six
ChatGPT content types and two Claude ones catalogued; four traps found that
would each have been a bug. [`SPEC.md`](SPEC.md) revised to v0.2 against real
data. Findings: [`tools/FINDINGS.md`](tools/FINDINGS.md).

**Phase 1 — format + reader.** `SPEC.md` and the `.chat`/`.chatpack` parser.
Organizer ingests a `.chat` file → SQLite → conversation list → thread view →
full-text search. Plus the zip-export backfill adapter, since that's how you get
your existing history in once.

**Phase 2 — capturer. ✅ Done.** Unpacked MV3 extension: a selection list, then delta
sync, emitting `.chat`/`.chatpack`. This is the phase that fixes the friction you
raised, and it lands early now rather than last.

**Phase 3 — organizer. ✅ Done.** Folders, tags, saved searches, archive, bulk actions,
drag and drop.

**Phase 4 — annotation.** Notes, highlights, snippet library, overlay edits.

**Phase 5 — power.** Semantic search, compile snippets to Markdown/PDF, library
stats, workspace sync, Gemini and other providers as new capturers.

## 11. Risks

| Risk | Mitigation |
|---|---|
| Internal endpoints change without notice | probe and fail loudly; capturer isolated in its own package; §4.4 fallbacks always work |
| Automated access is ToS-gray | personal use only, gentle rate limiting, never a hosted/shared service |
| CSP blocks bookmarklet approach | tested in Phase 0 before anything depends on it; extension is the primary plan anyway |
| Export/API formats drift | keep raw payloads; fixture tests per capturer; `schemaVersion` in the format |
| Re-capture duplicates the library | idempotent merge on `(provider, providerConvId)` + message `stableKey`, tested explicitly |
| Annotations orphaned on re-capture | `stableKey` plus fuzzy quote re-anchoring |
| Large libraries (100MB+, 10k+ messages) | parse in workers, virtualize lists, stream rather than slurp |
| Scope creep into "another chat client" | explicitly out of scope: sending new messages to any model |

### Deferred (decided, not forgotten)

- **Gemini** — Takeout gives a flat activity log (`My Activity → Gemini Apps →
  JSON`), one record per prompt/response with no reliable conversation id.
  Session grouping would be heuristic and lossy. Revisit in Phase 5 as a
  capturer, where the live page can supply real structure.
- **Cross-device sync** — workspace file first, real sync only if it becomes a
  genuine irritation.
