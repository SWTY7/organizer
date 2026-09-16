# tools

Two console scripts. Paste either into DevTools on **claude.ai** or
**chatgpt.com** — each detects which provider you're on and runs the matching
adapter. If you paste one somewhere else it says so and stops.

| | |
|---|---|
| [`dist/probe.js`](dist/probe.js) | diagnostics — confirms API shapes, reports what changed |
| [`dist/export.js`](dist/export.js) | converts your chats to `.chat` files |

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
