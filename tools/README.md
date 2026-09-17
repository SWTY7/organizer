# tools

Three console scripts. Paste any of them into DevTools on **claude.ai** or
**chatgpt.com** — each detects which provider you're on and runs the matching
adapter. If you paste one somewhere else it says so and stops.

| | |
|---|---|
| [`dist/probe.js`](dist/probe.js) | diagnostics — confirms API shapes, reports what changed |
| [`dist/export.js`](dist/export.js) | converts your chats to `.chat` files |
| [`dist/assets.js`](dist/assets.js) | are uploaded files retrievable? — Phase 0b |

If Chrome blocks the paste, type `allow pasting`, Enter, then paste.

## export.js

```
await one()          this conversation -> .chat.json
await recent(20)     20 most recent -> .chatpack.json
await all()          everything (confirms first if it's a lot)
```

Start with `await one()` on a chat you know well and read the output before
running anything larger.

It prints a block-type breakdown per conversation, and warns when a conversation
ends up with more than one root — that means either real branching or a splice,
and it's the fastest way to spot a mapping bug.

## probe.js

Answers the questions that gate schema decisions: do the endpoints work on
session auth alone, what's the exact response shape, does the list carry an
update timestamp (delta sync), are branches present, which content types occur.

Outputs are deliberately split:

| | contains | share it? |
|---|---|---|
| `__probe.schema` | key names, types, string *lengths*, a whitelist of enum values | **yes** — no message text, no titles |
| `__probe.save()` | writes the schema to a file | yes |

Run `copy(__probe.schema)` to put it on the clipboard.

See [FINDINGS.md](FINDINGS.md) for what the Phase 0 run turned up.

## assets.js

Phase 0b. Three questions that gate whether the `.chat` format starts carrying
bytes, and they are worth answering before it does:

1. **Does Claude already hand us the text of uploaded documents?** Messages
   carry `files[]` *and* `attachments[]`, and the converter only reads the
   first. If `attachments[].extracted_content` is populated, the text of every
   PDF and source file you have ever uploaded is already arriving in the
   payload and being discarded — searchable for free, no download at all.
2. **Is Claude's `preview_url` the original image, or a downscaled preview?**
   It fetches the image and compares its real pixel dimensions against the
   dimensions the payload declares.
3. **Does ChatGPT turn a file id into bytes this page may fetch?** The download
   endpoint hands back a signed URL on another origin, which a page on
   chatgpt.com may well be refused. That refusal is an answer, not a failure —
   the extension can request an origin a page cannot.

It scans up to 40 conversations looking for one that has an attachment, at
about three requests a second, and stops as soon as it finds what it needs. If
it reports finding nothing, upload a file to any chat and run it again.

Read-only, and it records what assets **are** — status, type, byte size, pixel
dimensions — never what they contain. No filename, no document text, no
signature from a signed URL. `copy(__assets.schema)` is safe to paste back.

## Where the code actually lives

`dist/` is **generated**. Don't edit it.

```
packages/adapters/
  shared.js      helpers no provider owns — timestamps, hashing, tree fixup
  claude.js      everything Claude-specific
  chatgpt.js     everything ChatGPT-specific
  index.js       registry: host -> adapter
tools/
  probe.entry.js    drives an adapter's probe()
  assets.entry.js   drives an adapter's probeAssets()
  export.entry.js   drives an adapter's convert()
  build.mjs         concatenates the above into dist/
```

Sources are split per provider so adding an LLM is one new file. A DevTools
console can't import local modules, so `build.mjs` flattens them into one
pasteable script:

```bash
npm run build
```

No dependencies — it's plain Node. `dist/` is committed so you never have to run
it just to use the tools.

```bash
npm test
```

## Adding a provider

1. Copy `packages/adapters/chatgpt.js` and rewrite it for the new service. The
   shape it must expose is documented on the `Adapter` typedef in
   [`index.js`](../packages/adapters/index.js).
2. Add it to `ADAPTERS` in `index.js`.
3. `npm run build`.

Nothing else changes — not the probe, not the exporter, not the app. That is the
whole point of the `.chat` format being the only thing the organizer ingests.

Two things to get right, because both have already caused real bugs:

- **Build `parentOf` from every raw node, including ones you drop**, then call
  `spliceParents`. Providers emit nodes that map to no content; dropping them
  without reattaching their children severs the thread in the middle.
- **Run every timestamp through `iso()`.** Providers are not internally
  consistent about their own formats.

## Privacy

No outbound requests. These read the site you're already on, with the session
you already have. `export.js` on ChatGPT reads an access token to reach
`/backend-api/`; it is never printed, stored, or written to output.

Exported files contain your real conversations. They're gitignored. Treat them
accordingly.

## Known gap

Attachments come through as `srcRef` — a URL or asset pointer, not bytes.
Neither provider inlines the data, so resolving them needs a second
authenticated fetch per file. Images render as placeholders in the reader until
a later backfill pass.

`assets.js` is the script that measures how big that gap actually is. Run it
before the format changes to carry bytes.
