# Phase 0 probe

One file: [`probe.js`](probe.js). Paste it into the DevTools console on **either**
claude.ai **or** chatgpt.com — it detects which site it's on and runs the right
checks. If you paste it somewhere else it says so and stops.

## Running it

1. Open claude.ai or chatgpt.com, logged in.
2. `F12` → **Console**. If Chrome blocks the paste, type `allow pasting`, Enter.
3. Paste the whole file, Enter.
4. `copy(__probe.schema)` → paste that back into the Claude Code session.

Run it on both sites. Two pastes total.

**One tip that matters:** on ChatGPT, have a conversation where you **edited a
prompt or hit regenerate** at the top of your list. Otherwise the probe
correctly reports "linear" and we learn nothing about branching, which is the
single thing most likely to force a schema change.

## What it's answering

These are the questions the documentation cannot answer, and the reason nothing
else gets built until they're settled:

1. Do the internal JSON endpoints work with just a logged-in session?
2. What is the **exact** shape of what comes back?
3. Does the conversation list carry an "updated at" field? If yes, **delta sync**
   works — one click to bring the whole library current. If no, the capturer has
   to check conversations one at a time, and the ease-of-use story for capture
   changes shape entirely.
4. Are branches (edited prompts, regenerated answers) actually present, and under
   which request parameters?
5. Which content block types really occur, so `ContentBlock` in
   [`../../SPEC.md`](../../SPEC.md) covers them?

## Privacy

No outbound requests to anywhere. It calls the site you're already on, with the
session you already have.

Two outputs, deliberately separated:

| | contains | share it? |
|---|---|---|
| `__probe.schema` | key names, types, string *lengths*, and a whitelist of enum values (`role`, `content_type`, `model`, …) | **yes** — no message text, no titles |
| `__probe.raw` / `__probe.save()` | the real unredacted payloads | **no** — keep local, gitignored |

On ChatGPT the probe reads an access token from `/api/auth/session` to call
`/backend-api/`. It is never printed, stored, or included in either output.

## Reading the output

| Message | Means |
|---|---|
| `got HTML instead of JSON` | wrong site, route doesn't exist, or your session expired |
| `DELTA SYNC: VIABLE` | the list carries a timestamp — one-click sync is possible |
| `TREE CONFIRMED` | real branches exist; a flat message list would lose data |
| `This conversation is linear` | not a failure — try one where you edited a prompt |
