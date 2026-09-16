# export.js

Turns your live chats into `.chat` files — the format the organizer reads
([SPEC.md](../../SPEC.md)).

This is the Phase 1 converter. It exists as a console script rather than an
extension because the conversion logic needs to be proven against real data
before it gets wrapped in a UI. Phase 2 moves exactly this logic into the
browser extension with a button on it.

## Running it

1. Open claude.ai or chatgpt.com, logged in.
2. `F12` → Console. If Chrome blocks the paste, type `allow pasting`, Enter.
3. Paste [`export.js`](export.js), Enter.
4. Pick one:

```
await one()          the conversation you're looking at right now
await recent(20)     your 20 most recently updated
await all()          everything (confirms first if it's a lot)
```

`one()` downloads a `.chat.json`. The others download a `.chatpack.json` bundle
and leave it on `window.__pack` so you can poke at it in the console.

Start with `await one()` on a conversation you know well. Open the file and
check it looks right before running the big one.

## What it does

Per [SPEC.md](../../SPEC.md)'s provider mapping, with the things Phase 0 caught:

- Requests Claude with `?tree=True&rendering_mode=messages`, without which there
  is no `content[]` and every thinking block vanishes.
- Reads thinking from `summaries[]`, which is where the text actually is —
  `.thinking` itself is routinely an empty string.
- Uses `recipient` to tell a tool call from a code block, so Python calls become
  `tool_use` and their output becomes `tool_result` instead of both looking like
  prose.
- Normalizes every timestamp to ISO 8601 UTC, including ChatGPT's detail
  endpoint, which returns Unix numbers where its list endpoint returns strings.
- Picks the Claude org by `capabilities` containing `chat` rather than by index,
  because accounts can hold several.
- Skips the null root mapping node and re-roots its orphaned children.
- Preserves unrecognized block types instead of dropping them.

It keeps the message tree (`parentId`), so edited prompts and regenerated
answers survive as branches.

## Rate limiting

Roughly three requests per second, sequentially. 285 conversations takes about
a minute and a half. It is a personal archival tool and behaves like one.

## Privacy

No outbound requests. It reads the site you're on with the session you already
have, converts in memory, and downloads to your machine. The ChatGPT path reads
an access token to call `/backend-api/`; it is never printed, stored or written
to the output.

**The downloaded files contain your actual conversations.** They are gitignored
here. Treat them like any other private data.

## Known gaps

Attachments come through as `srcRef` — a URL or asset pointer, not bytes.
Neither provider inlines the data, so resolving them needs a second
authenticated fetch per file. That's deliberate for now: it keeps `one()` fast,
and a later pass can backfill blobs. Images will render as placeholders in the
reader until then.
