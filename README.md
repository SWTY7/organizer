# organizer

One library for your AI chats — across Claude, ChatGPT and whatever comes next.

Claude has Projects. ChatGPT has folders. Neither can hold the other's
conversations, neither lets you highlight an answer or pin a note to it, and
neither helps you find the one chat where you actually worked something out.
This is a library and annotation layer over chats you already had.

**Status: Phase 0.** Nothing is usable yet. See [PLAN.md](PLAN.md).

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

## Repository

| Path | What |
|---|---|
| [`PLAN.md`](PLAN.md) | full plan, phases, risks |
| [`SPEC.md`](SPEC.md) | the `.chat` interchange format |
| [`tools/probes/`](tools/probes/) | Phase 0 diagnostic — confirms real API shapes |

## Phases

- [ ] **0 — spike.** Confirm the endpoints, shapes and whether delta sync is possible.
- [ ] **1 — format + reader.** `.chat` parser, import, browse, full-text search.
- [ ] **2 — capturer.** One-click capture and delta sync from a browser extension.
- [ ] **3 — organizer.** Folders, tags, smart folders, bulk actions.
- [ ] **4 — annotation.** Notes, highlights, snippet library, overlay edits.
- [ ] **5 — power.** Semantic search, compile snippets, more providers.

## A note on capture

The extension calls the same internal JSON endpoints the provider's own web app
calls, using your existing browser session, to retrieve your own conversations.
Those endpoints are undocumented and can change without notice, and automated
access sits in a gray area of both providers' terms. This is a personal
archival tool: it rate-limits itself, it is not a service, and the app stays
fully usable through official zip exports when a capturer breaks.
