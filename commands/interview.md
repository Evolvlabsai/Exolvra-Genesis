---
description: Interview your way to a Gauntlet-ready spec and a single-file interactive mockup — or modify an existing pair. Ends with the exact /gauntlet:run line to fire.
argument-hint: [path to an existing spec to modify, or a one-line idea to start from]
---

You are running a Gauntlet interview. The output is two files the user owns:
a spec that `/gauntlet:run` can execute directly, and a single-file
interactive mockup that doubles as a visual bar candidate for the run. This
command is a conversation, not a build — you write both files yourself; no
subagents.

$ARGUMENTS

## Mode

If the input is a path to an existing spec, this is a modification pass: read
the spec (and its mockup, if referenced), summarize what exists in three
sentences, and ask what should change. Otherwise start fresh, seeded by
whatever idea the input contains.

## The interview

One question at a time, never two in one message. Short questions, with
concrete options when they help. Adapt — skip what's already answered, dig
where answers are vague. Cover, in whatever order the conversation makes
natural:

1. **The thing** — what's being built, for whom, and the one job it must do.
2. **Tech stack** — languages, frameworks, runtime, storage, deploy target.
   If the user doesn't care, propose a sensible default and confirm it.
3. **Must-haves** — the requirements. Push each until it's checkable.
4. **Hard gates** — constraints that make the run an automatic LOSS if
   violated: stack, performance, size, licensing, accessibility.
5. **Non-goals** — what's explicitly out, so builders don't wander.
6. **The bar** — what existing thing should this be indistinguishable from,
   or measurably better than? Collect links, files, numbers.

Stop interviewing when new answers stop changing the spec — usually six to
ten questions.

## The spec

Write `specs/<slug>.md` in exactly the format `/gauntlet:run` consumes:

- A one-paragraph purpose.
- `## Constraints (hard gates)` — C1, C2, … one line each, checkable.
- `## Requirements` — R1, R2, … one or two lines each, checkable, covering
  every must-have from the interview.
- `## Non-goals`.
- `## References (bar candidates)` — the user's references, plus the mockup
  once it exists.

Show the user the whole file — not fragments — and iterate until they
approve it.

## The mockup

Build `specs/<slug>.mockup.html`: one self-contained HTML file — inline CSS
and JS, no external assets, opens straight from disk. Interactive means
clickable: navigation switches views, buttons and forms respond, realistic
sample data throughout, hover and empty states where they matter. It matches
the chosen stack's idioms in look only — it is a mockup, not the app.

Tell the user to open it in a browser, then iterate: take their feedback,
modify the file, ask them to refresh. Repeat until approved. Then add it to
the spec's References as the primary visual bar candidate.

## Handoff

When both files are approved, print exactly what to run next:

    /gauntlet:run specs/<slug>.md

and note that prefixing the arguments with `auto` makes it a fire-and-forget
run. Do not start the run yourself.
