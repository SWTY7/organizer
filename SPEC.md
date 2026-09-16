# The `.chat` format — v0.1 (PROVISIONAL)

> **Status: provisional.** This draft is written from documented export formats
> and recalled API shapes. Phase 0 probes (`tools/probes/`) will correct it
> against reality before v1.0. Do not build anything load-bearing on v0.x.

## Why a format at all

The organizer ingests exactly one thing: a `.chat` file. Nothing else. That one
rule buys three properties:

1. **Capturers are swappable.** A browser extension, a zip-export converter, a
   paste parser and a shell script are all equivalent as far as the app is
   concerned. When ChatGPT changes an endpoint, one capturer breaks — not the app.
2. **Provider knowledge is quarantined** in capturers, which is the code that was
   always going to change. The organizer never learns what "ChatGPT" means.
3. **Anyone can add a provider** without touching the app, which is what makes
   "…and any others" real rather than aspirational.

## Two artifacts

### `.chat.json` — one conversation

Plain JSON. Readable, diffable, greppable, committable. This is what one-click
capture produces.

### `.chatpack` — a bundle

A zip. This is what a full library export or a delta sync produces.

```
manifest.json           required
conversations/
  <id>.chat.json        one per conversation
blobs/
  <sha256>              attachments, content-addressed, no extension
overlay.json            optional — folders, tags, notes, highlights
```

`overlay.json` is deliberately separable: you can hand someone a `.chatpack` of
conversations without shipping your private notes along with them.

## `manifest.json`

```jsonc
{
  "schemaVersion": "0.1",
  "kind": "chatpack",
  "generator": { "name": "organizer-capture", "version": "0.1.0" },
  "capturedAt": "2026-09-16T12:00:00Z",
  "conversationCount": 128,
  "providers": ["claude", "chatgpt"],
  "hasOverlay": false
}
```

## A conversation

```jsonc
{
  "schemaVersion": "0.1",
  "kind": "conversation",

  "id": "9f2c...",                    // stable: hash(provider, providerConvId)
  "provider": "claude",               // claude | chatgpt | gemini | claude-code | generic
  "providerConvId": "abc-123",        // native id — dedup key with provider
  "title": "Damped oscillator derivation",
  "createdAt": "2026-09-01T10:04:00Z",
  "updatedAt": "2026-09-03T18:22:00Z",
  "model": "claude-opus-5",           // optional, best-effort
  "sourceUrl": "https://claude.ai/chat/abc-123",

  "currentLeafId": "m-88",            // tip of the "main path"; null = last message

  "messages": [
    {
      "id": "m-01",
      "parentId": null,               // tree, not list — see below
      "role": "user",                 // user | assistant | system | tool
      "createdAt": "2026-09-01T10:04:00Z",
      "model": null,
      "stableKey": "sha256:...",      // hash(provider, providerConvId, nativeMsgId)
      "content": [
        { "type": "text", "text": "Derive the envelope for a damped oscillator." }
      ]
    },
    {
      "id": "m-02",
      "parentId": "m-01",
      "role": "assistant",
      "createdAt": "2026-09-01T10:04:09Z",
      "model": "claude-opus-5",
      "stableKey": "sha256:...",
      "content": [
        { "type": "thinking", "text": "..." },
        { "type": "text", "text": "Start from $m\\ddot x + c\\dot x + kx = 0$..." },
        { "type": "code", "lang": "python", "text": "import numpy as np" }
      ]
    }
  ],

  "raw": { "...": "optional verbatim provider payload" }
}
```

### Content block types

| `type` | fields | notes |
|---|---|---|
| `text` | `text` | Markdown as the provider emitted it |
| `thinking` | `text` | extended thinking / reasoning summaries |
| `code` | `text`, `lang?` | only when the provider marks it structurally |
| `tool_use` | `name`, `input`, `id?` | |
| `tool_result` | `toolUseId?`, `text?`, `blobHash?`, `isError?` | |
| `image` | `blobHash`, `mime`, `alt?` | blob lives in `blobs/` |
| `file` | `blobHash`, `mime`, `filename` | |
| `citation` | `url`, `title?`, `quote?` | |

Unknown `type` values MUST be preserved verbatim and rendered as a labelled
fallback rather than dropped. Forward compatibility over strictness.

## Rules

1. **`schemaVersion` is mandatory** on every file. Readers accept any version
   they know and fail with a clear message on ones they don't. Old files must
   keep importing forever.
2. **Timestamps are ISO 8601 UTC strings.** Not Unix numbers — the format is
   meant to be read by humans, and provider exports disagree about units.
3. **`messages` is a tree, flattened into an array.** `parentId` carries the
   structure. Both Claude and ChatGPT branch on edits and regenerations, and a
   linear array cannot represent that. A capturer with no branch information
   emits a linear chain, which is a valid degenerate tree.
4. **`stableKey` must be deterministic** across captures of the same
   conversation. It's what keeps highlights and notes anchored after re-capture.
5. **`raw` is optional and opaque.** It lets a capturer preserve everything
   without the format modelling every provider quirk.
6. **Trivially convertible to `messages[]`.** Taking the main path, keeping
   `role`, and concatenating `text` blocks must yield a standard OpenAI-style
   array. That's the lingua franca; a format that fights it is a dead end.

## Open questions for Phase 0

- [ ] Does Claude's `?tree=True` actually return parent pointers, or is the
      tree only reachable via a different parameter?
- [ ] Does the ChatGPT conversation list include `update_time`? (Delta sync
      depends on it.)
- [ ] What is the real, complete set of `content_type` values in the wild?
- [ ] How are attachments referenced — inline base64, or a URL needing a second
      authenticated fetch?
- [ ] Is a native message id stable across re-captures, or regenerated per
      request? `stableKey` collapses if it isn't.
