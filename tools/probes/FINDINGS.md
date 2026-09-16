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
