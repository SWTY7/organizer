# organizer — capture (browser extension)

One-click capture with a **selection list**: load your conversations, tick the
ones you want, export. No console pasting, no "recent 20 or nothing".

## Install

Chrome / Edge / Brave, unpacked:

1. `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → pick this `extension/` folder
4. Click the extension's toolbar icon

It opens a full tab rather than a popup, because a popup closes the moment you
click away and an export of a few hundred conversations takes minutes.

> Run `npm run build` first if `extension/adapters/` is missing — the provider
> modules are copied in from `packages/adapters/` so there is one source of
> truth.

## Using it

1. **Load conversations** on Claude, ChatGPT, or both. You need to be signed in
   to that site in this browser already; the extension uses that session.
2. Tick what you want. Filter by title, **select all / none / invert**, check
   **only new & updated** to see what has changed since your last capture, or
   **group** the list and take a whole group at once.

   Grouping uses only what the provider's conversation list already returns, so
   it costs no extra requests:

   | Group by | Claude | ChatGPT |
   |---|---|---|
   | project | yes — real Projects | custom GPT, when one was used |
   | model | yes | **no** — model is detail-only, so these land in one bucket |
   | month | yes | yes |
   | provider | yes | yes |

   Starred is available on both and has its own filter.
3. **Export selected** → a `.chatpack.json` downloads.
4. Drop it into the reader at `localhost:4173`.

Rows are tagged `new` (never captured) or `updated` (changed since you last
captured it). That list is kept in extension storage, so the second export only
needs to cover what actually moved — this is the delta sync, driven by you
rather than by a timer.

## Why a tab, and why no background timer

An MV3 service worker is killed after ~30 seconds idle, which a long export
would not survive. An extension page in a tab has the same host permissions and
no such timeout, and it lets you watch progress and cancel by closing it.

Scheduled background sync is deliberately not implemented. Quietly hitting a
provider's API on a timer is more fragile and more likely to read as abuse than
a button you press.

## Permissions, and why each is needed

| Permission | Why |
|---|---|
| `https://claude.ai/*` | read your conversations from the site you are signed in to |
| `https://chatgpt.com/*`, `https://chat.openai.com/*` | the same, for ChatGPT |
| `storage` | remember which conversations you already captured, for "new & updated" |

There is no `downloads` permission: the file is produced in the page and saved
through an ordinary link, the same as any website download.

**Nothing is uploaded anywhere.** The extension talks only to Claude and
ChatGPT, and writes the result to your computer. There is no server, no
telemetry, and no third-party request of any kind.

## The honest caveat

This reads undocumented internal endpoints — the ones the provider's own web app
uses — with your own session, to retrieve your own conversations. They can
change without notice, and automated access sits in a gray area of both
providers' terms. It requests about three conversations per second and is not a
service.

If a provider changes something, the extension says so rather than importing
half a conversation, and [`../tools/`](../tools/) keeps working as a fallback.

## Adding a provider

Write one file in [`packages/adapters/`](../packages/adapters/), add it to
`ADAPTERS`, run `npm run build`. It appears here as a new card automatically —
this UI has no per-provider code in it.
