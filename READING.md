# Reading a single chat

A chat transcript is the worst possible shape for a long conversation. It is a
single column that only grows, with no hierarchy, no overview, and no way to
skip the parts you already read. Provider UIs all do this because they are
*writing* interfaces — the newest message is the important one. An archive is a
*reading* interface. The important message is the one you are looking for.

This document is the design for the alternatives. It is the answer to "chat
style gets vertically long very quickly, and is hard to read".

## The distinction everything depends on

There are two different structures inside a conversation, and they look similar
enough to be confused:

| | what it is | where it comes from | how sure are we |
|---|---|---|---|
| **Branch structure** | sibling messages: a regenerate, or an edited question | the `parentId` tree, captured from the provider | exact |
| **Topic structure** | "the main thread was A→B→C, but A had follow-ups A1, A2" | nowhere — it is in your head | inferred, or you say so |

The tree gives us branching for free and exactly. It does **not** give us
topics. In the data, `A → A1 → A2 → B` is almost always a straight line: each
follow-up is just the next turn. Nothing marks A1 as subordinate to A.

So the two-dimensional layout you want is right as an *interface*, but it needs
a source of sectioning, and that source is separate work from the layout. The
rest of this document keeps them apart: **templates** (how it looks) and
**sectioning** (where the divisions come from).

Getting this backwards is the trap. An auto-grouper that silently reorganises a
conversation into the wrong sections is worse than a plain transcript, because
now you cannot trust what you are reading. Sectioning is a *suggestion* with a
one-click override, always.

## Sectioning: three sources

### 1. Structural, free, exact

Every conversation is already a sequence of turns, and every assistant reply
already has markdown headings. That gives us a real outline with zero
inference — it is just not *topic* grouping. It is enough for the Outline and
Map templates below, which is why those ship first.

### 2. Manual

Hover one of your messages, or an exchange in the outline, and press the
bookmark — **start a section here** — then name it. Rename or remove it from
the heading's own buttons. Exact, and it is also how you correct source 3.

(The first version put this behind right-click only. That is a control nobody
finds; see DESIGN.md, interaction rule 1.)

Stored in `meta` as `sections: [{ startStableKey, title }]`. In `meta`, not on
the conversation, so re-capturing the chat keeps your sections — this is what
`stableKey` was built for.

Anchoring to a key rather than an index has one visible consequence: a break
can end up pointing at a message that is not on the path being shown, because
the conversation was re-captured or because the break sits on a branch you are
not following. Those are **reported and kept**, never quietly dropped. Losing
work someone did by hand in order to keep a display tidy is the wrong trade.

### 3. Suggested

An offline heuristic, no model, no dependencies, no network. It scores each
**user** turn for "does this open a new topic or continue the last one":

| signal | reads as |
|---|---|
| gap > ~30 min since the previous turn | new topic (strong) |
| opens with *what about, also, and, why, instead, no,, but, again, can you* | continuation |
| opens with a bare pronoun — *it, that, this, they* | continuation (strong) |
| under ~12 words | continuation |
| high term overlap with the previous turn | continuation |
| introduces nouns absent from everything before it | new topic |

Combine, threshold, show the result as a **proposed** outline with the dividers
draggable and a "this is a guess" marker. Off until you turn it on.

It will be wrong sometimes. That is acceptable *only* because correcting it is
one click and the correction is permanent.

## The templates

Eight, each earning its place. Switching between them is a toolbar in the thread
header.

One choice, remembered across the whole library rather than per conversation.
Per-conversation memory sounded better than it is: opening two chats and
getting two different layouts, for a reason you set weeks ago and cannot see,
is a surprise rather than a convenience. If a per-conversation default proves
necessary, the honest version is the app choosing it from length — not
remembering an old click.

### 1. Transcript — the baseline

Today's view. Best for short chats and for reading start to finish. Stays the
default; nothing here is a replacement.

### 2. Outline — collapse the wall

Each turn becomes one row: **your question in full** (questions are short) plus
the assistant's first sentence, plus a badge row — `3 code · 1 image · thought
18 steps · 900 words`. Click a row to expand it in place; click again to
collapse.

This is the whole "vertically long" problem solved with no inference at all, in
about sixty lines. **It ships first.**

### 3. Map — a ribbon you never lose

> **Since the redesign** (DESIGN.md), the ribbon and the Spine rail are one
> thing: the inspector's outline. Each exchange there carries a bar for its
> length and the one you are reading is highlighted as you scroll — the
> ribbon's job — and in Focus it is the list you pick from — the rail's job.
> Two navigators beside one conversation left the reading column 372px wide
> on a laptop; one leaves it 760.

A thin vertical strip pinned beside the thread. One bar per message, height
proportional to length, colour by role, notches for code / image / thinking. The
part currently on screen is highlighted; click anywhere to jump.

Forty lines, works with every other template, and turns a 200-message
conversation into something you can aim at. Ships with Outline.

### 4. Spine — two panes (now **Focus**)

> Now the **Focus** template: one exchange in the reader, with Previous / Next
> and `j` / `k`, and the inspector as its rail.

Outline on the left as a fixed rail, the selected turn in full on the right.
Reads like documentation rather than like chat. `j` / `k` move. This is the one
for long technical chats you return to.

The rail has a filter box rather than the in-conversation search first planned
here. `/` is already the library search, and a second meaning for the same key
depending on which template is open is exactly the kind of cleverness that
makes an app hard to use. Filtering the rail answers the same question —
*where in this chat did I talk about X* — by hiding the exchanges that do not
match, which is both simpler to build and simpler to explain.

### 5. Columns — the two-dimensional one

Your idea, made concrete. Each **section** is a column; the turns inside it
stack down the column; you scroll sideways through the conversation's topics.

    A ───────► B ───────► C        sections, horizontally
    │          │          │
    A1         B1         C1       turns within a section, vertically
    A2         B2
    A3

With a transpose toggle, because which axis feels natural depends on whether
you have many short sections or few long ones. Same code, one `flex-direction`.

Needs sectioning, so it lands after the sectioning work.

### 6. Branches — the honest 2D

For conversations with real forks. The main path runs down the page; each
alternate branch peels off sideways at its fork point as a parallel track, with
the two competing messages **diffed** so you can see what actually changed
between a regenerate and its sibling.

Uses only true captured structure, no inference. Replaces the `‹ 2/3 ›` stepper
that currently hides alternatives behind a control you have to notice.

No other reader does this, and it is the payoff for capturing trees instead of
lists.

### 7. Digest — what did I ask?

Only your questions, in order, each expandable to its answer. For finding the
thing you know you asked about somewhere in a long session.

### 8. Gallery — everything that isn't prose

Every code block, image, table, artifact and tool output in the conversation,
pulled out into a grid, each with a jump back to where it came from. This is
also where reconstructed artifacts live (see PLAN.md, Track B).

## Order of work

| | template | needs | cost |
|---|---|---|---|
| 1 | Outline + Map ✅ | nothing | small |
| 2 | Spine ✅ | Outline | small |
| 3 | Sections — manual ✅ | `meta.sections` | small |
| 4 | Columns | sections | medium |
| 5 | Branches 2D + diff | nothing (data is there) | medium |
| 6 | Sections — suggested | the heuristic | medium |
| 7 | Gallery | assets work, for images | medium |
| 8 | Digest | Outline | small |

Rows 1–3 are most of the benefit and very little of the risk.
