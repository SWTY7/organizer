# Phase 0 probes

Throwaway diagnostic scripts. They answer the questions the plan cannot answer
from documentation, before we commit any of it to code:

1. Do the internal JSON endpoints work with just a logged-in session?
2. What is the **exact** shape of what comes back?
3. Does the conversation list carry an "updated at" field? (If yes, **delta
   sync** works — the one-click "bring my library current" feature. If no, the
   capturer has to check conversations one by one, which is much slower.)
4. Are branches (from edited prompts / regenerated answers) actually present?
5. What `content_type` / block types really occur, so `ContentBlock` covers them?

## Running them

| | |
|---|---|
| **Claude** | Open [claude.ai](https://claude.ai), F12 → Console, paste [`claude.js`](claude.js) |
| **ChatGPT** | Open [chatgpt.com](https://chatgpt.com), F12 → Console, paste [`chatgpt.js`](chatgpt.js) |

If Chrome refuses the paste, type `allow pasting` into the console first, press
Enter, then paste.

Tip for question 4: run the ChatGPT probe while a conversation **where you
edited a prompt or hit regenerate** is at the top of your list, otherwise the
probe will correctly report "linear" and tell us nothing about branching.

## Privacy

These scripts make no outbound requests. They call the site you are already on,
with the session you already have.

Two outputs, deliberately separated:

- **`__probe.schema`** — key names, types, string *lengths*, and a short
  whitelist of enum values (`role`, `content_type`, `model`, …). No message
  text, no conversation titles. **This is the one to share.**
- **`__probe.raw`** / **`__probe.save()`** — the actual unredacted payloads,
  for your own inspection. These contain real conversation content. Keep them
  local; they are gitignored.

The ChatGPT probe reads an access token from `/api/auth/session` in order to
call `/backend-api/`. It never prints, stores, or downloads that token.

## After running

```
copy(__probe.schema)
```

Paste that back into the Claude Code session. It's what pins down the canonical
model in [`../../PLAN.md`](../../PLAN.md) §3 and the format in
[`../../SPEC.md`](../../SPEC.md).
