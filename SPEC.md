# The `.chat` format — v0.2

> **Status: confirmed against live data.** v0.1 was written from documentation
> and guesswork. This revision is corrected against Phase 0 probe results from
> claude.ai and chatgpt.com — see [`tools/probes/FINDINGS.md`](tools/probes/FINDINGS.md).
> Remaining gaps are listed at the bottom.

## Why a format at all

The organizer ingests exactly one thing: a `.chat` file. Nothing else. That one
rule buys three properties:

1. **Capturers are swappable.** A browser extension, a zip-export converter, a
   paste parser and a shell script are all equivalent as far as the app is
   concerned. When ChatGPT changes an endpoint, one capturer breaks — not the app.
2. **Provider knowledge is quarantined** in capturers, which is the code that was
   always going to change.
3. **Anyone can add a provider** without touching the app.

## Two artifacts

### `.chat.json` — one conversation

Plain JSON. Readable, diffable, greppable. This is what one-click capture makes.

### `.chatpack` — a bundle

A zip. This is what a full export or a delta sync makes.

```
manifest.json           required
conversations/
  <id>.chat.json        one per conversation
blobs/
  <sha256>              attachments, content-addressed, no extension
overlay.json            optional — folders, tags, notes, highlights
```

`overlay.json` is separable on purpose: you can hand someone a `.chatpack` of
conversations without shipping your private notes with them.

## `manifest.json`

```jsonc
{
  "schemaVersion": "0.2",
  "kind": "chatpack",
  "generator": { "name": "organizer-capture", "version": "0.1.0" },
  "capturedAt": "2026-09-16T15:01:11Z",
  "conversationCount": 285,
  "providers": ["claude", "chatgpt"],
  "hasOverlay": false
}
```

## A conversation

```jsonc
{
  "schemaVersion": "0.2",
  "kind": "conversation",

  "id": "9f2c...",                 // stable: hash(provider, providerConvId)
  "provider": "claude",            // claude | chatgpt | gemini | claude-code | generic
  "providerConvId": "abc-123",     // native id — dedup key with provider
  "title": "Damped oscillator derivation",
  "createdAt": "2026-09-01T10:04:00Z",   // ISO 8601 UTC, always
  "updatedAt": "2026-09-03T18:22:00Z",
  "model": "claude-opus-5",
  "sourceUrl": "https://claude.ai/chat/abc-123",
  "currentLeafId": "m-88",         // tip of the main path

  "summary": "…",                  // optional; Claude's list provides one
  "starred": false,                 // optional provider-side flag
  "projectRef": {                  // optional — seeds a folder on import
    "id": "proj-uuid",
    "name": "Physics"
  },

  "messages": [ /* see below */ ],
  "raw": { "…": "optional verbatim provider payload" }
}
```

## A message

```jsonc
{
  "id": "m-02",
  "parentId": "m-01",              // tree, not list
  "role": "assistant",             // user | assistant | system | tool
  "createdAt": "2026-09-01T10:04:09Z",
  "model": "claude-opus-5",
  "stableKey": "sha256:…",         // hash(provider, providerConvId, nativeMsgId)
  "stopReason": "end_turn",        // optional
  "status": "complete",            // complete | in_progress | error
  "hidden": false,                 // provider marked it non-visible
  "content": [ /* blocks */ ]
}
```

`status` and `hidden` exist because live data contains both: ChatGPT emits
`status: "in_progress"` for messages still generating when captured, and carries
a `weight` field marking messages the UI does not show. Importers keep them and
let the reader decide, rather than dropping data at capture time.

## Content blocks

| `type` | fields | notes |
|---|---|---|
| `text` | `text`, `citations?` | Markdown as the provider emitted it |
| `thinking` | `text?`, `summaries?: string[]` | **at least one of the two** — see below |
| `code` | `text`, `lang?` | model-authored code shown as code, not a tool call |
| `tool_use` | `name`, `input?`, `text?`, `lang?`, `id?` | |
| `tool_result` | `text?`, `toolUseId?`, `blobHash?`, `isError?` | |
| `image` | `blobHash?`, `srcRef?`, `mime?`, `width?`, `height?`, `alt?` | |
| `file` | `blobHash?`, `srcRef?`, `mime?`, `filename` | |
| `citation` | `url`, `title?`, `quote?` | |

**`thinking` carries `summaries`** because that is what the data actually looks
like. In the probe, Claude returned `thinking: ""` alongside 18 populated
`summaries` entries — a capturer reading only `.thinking` would have silently
captured nothing. ChatGPT's `thoughts` blocks are shaped the same way
(`{summary, content}` pairs), so both normalize onto the same block.

**`srcRef` vs `blobHash`.** Neither provider inlines attachment bytes; both hand
you a reference needing a second authenticated fetch. A capturer that resolves
it sets `blobHash` and puts the bytes in `blobs/`. One that doesn't sets
`srcRef` and the block renders as an unresolved placeholder. Both are valid —
this keeps one-click capture fast and lets a full sync backfill blobs later.

Unknown `type` values MUST be preserved verbatim and rendered as a labelled
fallback, never dropped.

## Provider mapping

This table is the contract each capturer implements. It is derived from real
responses, not documentation.

### Claude → canonical

Requires `?tree=True&rendering_mode=messages`. Without it the response has no
`content[]` at all, only a flattened `text` string, and every thinking block is
lost.

| Claude | canonical |
|---|---|
| `uuid` | `providerConvId` |
| `name` | `title` |
| `chat_messages[].uuid` | message `id` / `stableKey` source |
| `chat_messages[].parent_message_uuid` | `parentId` |
| `sender: "human"` | `role: "user"` — **not `"user"` natively** |
| `sender: "assistant"` | `role: "assistant"` |
| `current_leaf_message_uuid` | `currentLeafId` |
| `content[].type: "text"` | `text` |
| `content[].type: "thinking"` | `thinking` (map `summaries[].summary` → `summaries[]`) |
| `stop_reason` | `stopReason` |
| `files[]` | `image` / `file` with `srcRef` from `preview_url` |
| `project_uuid` + `project.name` | `projectRef` |

### ChatGPT → canonical

| ChatGPT | canonical |
|---|---|
| `conversation_id` | `providerConvId` |
| `mapping[id].parent` | `parentId` (root node has `message: null` — skip it) |
| `current_node` | `currentLeafId` |
| `author.role` | `role` (`user` / `assistant` / `tool` pass through) |
| `content_type: "text"` | `text`, joining `parts[]` |
| `content_type: "multimodal_text"` | split `parts[]`: strings → `text`, `image_asset_pointer` → `image` with `srcRef: asset_pointer` |
| `content_type: "code"`, `recipient: "all"` | `code` |
| `content_type: "code"`, `recipient: "python"` \| `"container.exec"` | `tool_use` with `name: recipient` |
| `content_type: "execution_output"` | `tool_result` |
| `content_type: "thoughts"` | `thinking`, `thoughts[].summary` → `summaries[]`, `thoughts[].content` → `text` |
| `content_type: "reasoning_recap"` | `thinking` with `summaries: [content]` |
| `metadata.model_slug` | `model` |
| `weight === 0` | `hidden: true` |

**`recipient` is the tool-call discriminator.** `all` means the block is
addressed to the user; anything else means the model is calling a tool. Without
this rule, every Python call renders as a normal code block and the execution
output has no parent.

## Rules

1. **`schemaVersion` is mandatory.** Readers accept versions they know and fail
   with a clear message otherwise. Old files must keep importing forever.
2. **Timestamps are ISO 8601 UTC strings.** Providers disagree with *themselves*
   here — ChatGPT's list returns ISO strings while its conversation detail
   returns Unix numbers for the same field names. Capturers normalize; the format
   does not accept both.
3. **`messages` is a tree flattened into an array**, with structure in
   `parentId`. Confirmed necessary: a probed ChatGPT conversation had 67 nodes
   but a 61-node main path. A capturer with no branch data emits a linear chain,
   which is a valid degenerate tree.
4. **`stableKey` must be deterministic** across captures of the same
   conversation. It is what keeps highlights and notes anchored after re-capture.
5. **`raw` is optional and opaque.**
6. **Trivially convertible to `messages[]`.** Walking the main path, keeping
   `role`, concatenating `text` blocks must yield a standard OpenAI-style array.

## Still open

- [ ] Are provider message ids stable across re-captures, or regenerated per
      request? `stableKey` degrades to content-hashing if they aren't. Needs two
      captures of the same conversation a day apart.
- [ ] Attachment fetch: exact endpoint and auth for resolving Claude
      `preview_url` and ChatGPT `asset_pointer` to bytes.
- [ ] ChatGPT list pagination past the first page (`total` was 21, under one page).
- [ ] Whether ChatGPT node `id` always equals `message.id`.
- [ ] Gemini — deferred to Phase 5, see [PLAN.md](PLAN.md).
