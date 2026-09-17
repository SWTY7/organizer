# Phase 0 findings

Probed 2026-09-16 against live claude.ai and chatgpt.com. All five questions
answered. Sample sizes: Claude 285 conversations / 2 orgs / 17 projects;
ChatGPT 21 conversations, detail sample 67 mapping nodes.

## The two that gated the schema

**1. Delta sync is viable on both.** ✅

| | list endpoint | timestamp field | messages in list? |
|---|---|---|---|
| Claude | `/api/organizations/{org}/chat_conversations` | `updated_at` | no |
| ChatGPT | `/backend-api/conversations?offset=&limit=&order=updated` | `update_time` | no (`mapping: null`) |

So the sync loop is: fetch the list (cheap, paginated), diff timestamps against
the library, then fetch detail **only for changed conversations**. One click,
proportional to what actually changed. This is the feature the whole capture
design was betting on, and it works.

**2. Branches are real, and Claude needs a parameter to expose them.** ✅

ChatGPT's sample had 67 mapping nodes but a main path of only 61 — six nodes on
an abandoned branch, from one branch point. A flat message list would have
silently dropped them.

Claude is the sharper finding:

| request | `content[]` present? | thinking blocks? |
|---|---|---|
| `?tree=True&rendering_mode=messages` | **yes** | **yes** |
| no query string | no — only a flattened `text` string | no |

Both variants carry `parent_message_uuid`, so the tree survives either way, but
**`tree=True` is mandatory** or you lose all structured content and every
thinking block. The plain variant is lossy in a way that isn't obvious until you
compare them.

## Content block types, as they actually occur

Not the tidy set the draft spec assumed.

**Claude** — `content[]` array, blocks typed directly:
- `text` — `{text, citations[], start_timestamp, stop_timestamp}`
- `thinking` — `{thinking, summaries[{summary}], cut_off, truncated, hidden, thinking_hidden}`
  - **`thinking` was an empty string while `summaries` held 18 entries.** The
    summaries are the real payload. A capturer reading only `.thinking` gets
    nothing.

**ChatGPT** — `content.content_type` discriminates, and the shape changes per type:
| `content_type` | payload |
|---|---|
| `text` | `parts: [string]` |
| `multimodal_text` | `parts: [string \| {content_type:"image_asset_pointer", asset_pointer, size_bytes, width, height}]` |
| `code` | `{language, text, response_format_name}` |
| `execution_output` | `{text}` + `metadata.aggregate_result{code, messages[], jupyter_messages[]}` |
| `thoughts` | `{thoughts: [{summary, content, chunks, finished}], source_analysis_msg_id}` |
| `reasoning_recap` | `{content: string}` |

Roles seen: `user`, `assistant`, `tool`. Claude uses `human`/`assistant` instead
— **`human`, not `user`**.

`recipient` is what distinguishes a tool call from prose: `all` means it's for
the user, `python` / `container.exec` mean it's a tool invocation. So
`code` + `recipient != "all"` → `tool_use`, and `execution_output` → `tool_result`.

## Traps found

**Timestamps are inconsistent within ChatGPT itself.** The list returns ISO
datetime strings; the conversation detail returns Unix numbers for the same
fields (`create_time`, `update_time`). Claude uses ISO throughout. Capturers
must normalize — the format keeps ISO 8601 UTC.

**Claude accounts can have multiple organizations.** This one had 2, and the
probe's `orgs[0]` happened to be right. The other is an API/console org
(`billing_type`, `rate_limit_tier`, `api_disabled_reason` populated). Selecting
by index is a latent bug: **select the org whose `capabilities` include `chat`.**

**ChatGPT messages carry `weight` and `status`.** `status` can be `in_progress`,
and the root mapping node has `message: null`. Both need handling or the parser
throws on real data.

**Attachments need a second authenticated fetch on both.** Claude messages carry
`files[]` with `preview_url` / `thumbnail_url` plus `file_uuid`; ChatGPT carries
`metadata.attachments[]` (`id`, `name`, `mime_type`, `size`, `library_file_id`)
and `asset_pointer` references in content. Neither inlines the bytes.

## A bonus worth building on

**Claude's conversation list already includes project membership** —
`project_uuid` and `project: {uuid, name}` on every item, and
`/api/organizations/{org}/projects` returned all 17 with names and descriptions.

So importing Claude can seed the folder tree automatically from Projects the
user already made. No manual filing to get started, which is directly the
ease-of-use goal. The list is generally rich: `summary`, `model`, `is_starred`,
and `current_leaf_message_uuid` all arrive without a detail fetch.

## Endpoints, confirmed

```
claude.ai
  GET /api/organizations                                     -> pick org w/ "chat" capability
  GET /api/organizations/{org}/chat_conversations             -> list (285)
  GET /api/organizations/{org}/chat_conversations/{uuid}
        ?tree=True&rendering_mode=messages                    -> detail, REQUIRED params
  GET /api/organizations/{org}/projects                       -> 17 projects

chatgpt.com
  GET /api/auth/session                                       -> accessToken (Bearer)
  GET /backend-api/conversations?offset=&limit=&order=updated -> list
  GET /backend-api/conversation/{id}                          -> detail w/ mapping
```

Cookies alone were not enough for ChatGPT; `/backend-api/` needs the bearer
token from the session endpoint. Claude worked on cookies alone.

---

# Phase 0b findings — assets

Probed 2026-09-17 against live claude.ai and chatgpt.com, read-only. Sample:
Claude 286 conversations, 4 scanned before a hit; ChatGPT 40 listed, 2 scanned.

## 1. Claude already hands us the text of uploaded documents ✅

`attachments[]` is a **separate list from `files[]`**, and the converter was
reading only `files`. Its keys:

```
created_at  extracted_content  file_name  file_size  file_type  id
```

`extracted_content` was populated: **11,758 characters** for a `txt` upload
declaring `file_size: 18862`.

So every document ever attached to a Claude chat is already arriving in the
payload, and was being thrown away. No fetch, no bytes to store, and it becomes
full-text searchable on import. This is the cheapest capability in the project.

**Open, and deliberately not assumed away:** 11,758 characters against 18,862
bytes is a ratio of 0.62. That is exactly what UTF-8 does to non-Latin text —
Korean runs three bytes per character — so it is very likely complete. But it is
also what truncation looks like, and characters and bytes are not comparable.
The block keeps `meta.declaredBytes` so the question can be settled later, and
nothing claims the text is complete in the meantime. To settle it: attach a
pure-ASCII file of known length and compare.

## 2. Claude's `preview_url` is the original, not a preview ✅

| | pixels | bytes | type |
|---|---|---|---|
| declared | 1456 × 817 | — | — |
| `preview_url` | **1456 × 817** | 27,854 | `image/webp` |
| `thumbnail_url` | 400 × 224 | 5,870 | `image/webp` |

Full declared resolution, on session cookies alone. The name is misleading:
`thumbnail_url` is the downscale, `preview_url` is the image.

Two consequences. Capturing images is cheap — 27 KB for a 1456×817 frame, not
the ~300 KB the plan assumed, so a library of a few hundred images is tens of
megabytes rather than a hundred. And it is served as `webp`, which means it may
be a re-encode rather than the file as uploaded; good enough to read, not a
byte-exact archive of the original.

URL shape: `/api/{org}/files/{uuid}/preview`.

## 3. ChatGPT uploads are retrievable, byte-exact ✅

`GET /backend-api/files/{id}/download` answered, returning:

```
creation_time  download_url  file_name  file_size_bytes  metadata
mime_type  no_auth_user_upload  status
```

`download_url` is on **chatgpt.com itself** — same origin, not the cross-origin
signed blob URL the plan assumed. With the session it returns the file:

| | |
|---|---|
| status | 200 |
| type | `application/pdf` |
| bytes | **38,761** |
| declared `size` | **38,761** |

Byte-exact and complete. Unlike Claude's webp re-encode, this is the file as
uploaded.

The first run reported 403 on this same URL, and that was **the probe's fault,
not the provider's**: it asked with `credentials: 'omit'`, having been written
for a signed URL that carries its own authorisation. A same-origin URL fetched
without cookies is supposed to be refused. Worth recording because the two
outcomes are indistinguishable from the status code alone — the probe now tries
session, then bearer token, then anonymous, and prints the server's own refusal
text.

## 3b. Generated images do NOT use that route ⚠️ open

The same endpoint, given the id from an `image_asset_pointer`
(`file_00000000250c…`), returned **403**. So an upload and a generated image are
different kinds of asset, and only one of them is solved.

The probe now tries four candidate routes against one of your own images —
`/download`, bare, conversation-scoped, and a conversation-attachment path — and
dumps the pointer's own `metadata` shape, which may carry the answer without
guessing. None of those four is a known endpoint; they are measurements.

Until this closes, ChatGPT image capture is a gap and uploads are not.

## 4. ChatGPT has no extracted text ❌

`metadata.attachments[]` keys: `id`, `library_file_id`, `mime_type`, `name`,
`size`. That is all. A PDF that is free on Claude is a download on ChatGPT —
though at least on ChatGPT the download gives you the original bytes.

## 5. `asset_pointer` is not `file-service://`

The scheme observed was **`sediment://`**, on a `image_asset_pointer` declaring
476 × 685 and 30,557 bytes. Keys: `asset_pointer`, `content_type`, `fovea`,
`height`, `metadata`, `size_bytes`, `width`. The id after the scheme is
`file_…` with an **underscore**, not the `file-` the old pattern expected.

So two assumptions were wrong at once: the scheme, and the id separator.
Anything matching `file-service://file-…` matches nothing in this account.

## Where that leaves asset capture

| | document text | original bytes |
|---|---|---|
| Claude, uploads | ✅ free, in the payload | ✅ `preview_url`, re-encoded to webp |
| Claude, images | — | ✅ full resolution, 27 KB typical |
| ChatGPT, uploads | ❌ none | ✅ byte-exact via `/download` |
| ChatGPT, images | — | ⚠️ open, see 3b |

Three of four are solved and one is a live question. Nothing here needs a
cross-origin request, so the extension can do all of it.
