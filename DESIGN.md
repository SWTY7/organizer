# Design

The reader's layout and interaction rules. Chosen 2026-09-18: **Explorer
workspace, neutral tone.**

## Layout — three panes, two of them optional

```
┌ explorer ─────┬ reader ─────────────────────────┬ inspector ──┐
│ search        │ ☰  Physics / Thermo    [≡][⋮][▯] ▯ │ Outline     │
│ ★ Starred     │                                 │  1 …        │
│ ▾ Physics     │   Title                         │  2 …  ▂▂▂   │
│   ▸ Thermo    │   claude · opus · Jun 4         │ ─ Section ─ │
│   ◦ Small os… │                                 │  3 …        │
│ ▸ Coding      │   (reading column, ≤ 760px)     │             │
│ ▸ Unsorted    │                                 │ Details     │
└───────────────┴─────────────────────────────────┴─────────────┘
```

- **Explorer.** One tree. Folders contain conversations, the way Obsidian's
  folders contain notes — there is no separate list pane. Conversations with no
  folder live under **Unsorted**, so everything is reachable from the tree.
  Searching, or picking Starred / Archived / a tag / a saved search, swaps the
  tree for a flat result list with a way back.
- **Reader.** The conversation, in a centred column capped at 760px. The
  template switch (Transcript / Outline / Focus) lives in its top bar.
- **Inspector.** The conversation's outline — sections and exchanges, each with
  a bar for its length, the current one highlighted as you scroll — and its
  details. This replaces both the Spine rail and the ribbon: one navigator,
  not two.

Both side panes collapse. The reading column is the product; it gets the room.

## Interaction rules

1. **Every action has a visible control.** A hover button, a `⋯` menu, an
   inline `+`. Right-click, double-click and keyboard shortcuts exist as
   accelerators, never as the only way in. (A subfolder behind right-click is
   the bug that produced this rule.)
2. **No native `prompt` / `confirm` / `alert`.** Names are typed inline where
   the thing appears — a new folder is an input in the tree, at the place it
   will live. Confirmations are a styled dialog. Undo-able actions skip the
   confirmation and offer Undo in a toast instead.
3. **Destructive actions are one level down.** Clearing the library lives in a
   menu, not next to the search box.
4. **Re-rendering never moves you.** Starring a conversation must not scroll the
   reader to the top or collapse the tree. Scroll positions and focus survive
   a render.
5. **Words say what they mean.** "Unsorted" means no folder, and nothing else.

## Tokens — neutral

Colour carries meaning or it is grey. One accent, used for selection, focus and
links; provider dots are the only other colour in the chrome.

| token | light | dark | use |
|---|---|---|---|
| `--bg` | `#ffffff` | `#1c1c1e` | reader |
| `--bg-side` | `#f7f7f8` | `#212124` | explorer, inspector |
| `--bg-sunk` | `#f2f2f4` | `#18181a` | your messages, code |
| `--bg-elev` | `#ffffff` | `#2a2a2d` | menus, dialogs |
| `--fg` | `#1d1d1f` | `#ececee` | text |
| `--fg-2` | `#606067` | `#a3a3aa` | secondary |
| `--fg-3` | `#9b9ba2` | `#6f6f77` | metadata |
| `--line` | 8% black | 8% white | hairlines |
| `--accent` | `#2f67d6` | `#7aa2ff` | selection, focus, links |

Type: system sans, 13px for chrome, 15px/1.7 for reading, 24px titles.
Weights 400 for text, 500 for titles in lists, 600 for headings. Radius 6px. Icons are inline SVG strokes — no icon font,
because the app makes no network requests.
