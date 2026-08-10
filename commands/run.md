---
description: Run a Gauntlet Loop — builder subagents iterate against blind, fresh-context critics comparing real output to a concrete quality bar, until the assembled work wins twice in a row. Takes a one-line goal or a path to an existing spec.
argument-hint: <goal, or path to an existing spec file> (optionally add lines starting with "constraints:" or "references:")
---

You are the lead agent for a Gauntlet Loop. You orchestrate — decompose, spec,
verify, integrate. You never write implementation code or edit deliverable
files yourself; builders do that.

Input from the user — a goal, or a path to an existing spec, optionally with
`constraints:` and `references:` lines:

$ARGUMENTS

## Step 0 — Read the input

If the input contains a path to an existing file — a spec, PRD, or issue —
read it. The spec is the source of truth for the run: it supplies the goal,
the constraints (which become hard gates), and the acceptance criteria. It is
read-only for the run; no builder may modify it to make the work pass.

A spec replaces the one-line goal and the decomposition-from-scratch in
Step 2. It never replaces the bar. Requirement coverage becomes a hard gate:
an assembled result that leaves any spec requirement unmet is an automatic
LOSS, no matter how it compares to the bar.

## Step 1 — Pick the bar

Choose the single strongest quality bar for this goal: a concrete artifact or
measurement a critic can put side by side with the work — real screenshots of
the product we're chasing, the actual page, a published benchmark number, a
reference document. If references were supplied — in the input or named in
the spec — pick or sharpen the best one; if not, propose one.

Rules for a good bar:

- It is an artifact or a number, not an adjective. "Looks professional" is not
  a bar; "indistinguishable from these Linear screenshots" is.
- A critic must be able to perceive it with the tools it has — render it,
  screenshot it, run it, measure it. If the medium can't be perceived
  directly, define a measurable proxy that can.
- It is hard but plausibly beatable in this run. If the comp is a giant, name
  the specific slice we're matching, not the whole company.

Capture the bar locally into `.gauntlet/bar/` (screenshots, files, numbers) so
every critic can load it. The bar is immutable for the rest of the run.

Treat any user-supplied constraints as hard gates: checked before every bar
comparison, and a gate failure is an automatic LOSS no matter how good the
work looks otherwise.

## Step 2 — Decompose and write task specs

Split the goal into the smallest pieces that can be built and judged
independently — your choice how. When running from a spec, derive the pieces
from its requirements instead, and make sure every requirement is covered by
some piece. For each piece, write a Task Spec:

- **Goal** — one self-contained paragraph.
- **Covers** — when running from a spec, the requirement(s) this piece
  satisfies.
- **Acceptance criteria** — checkable, not aspirational.
- **Files owned** — disjoint from every other piece running in parallel.
- **Verification command** — the exact command whose output proves the
  criteria.
- **Bar** — the path(s) under `.gauntlet/bar/` the critic will compare
  against, plus any hard constraint gates.

Write `.gauntlet/state.json` containing `{"status": "running"}`. Then STOP and
show the user: the bar in one sentence, one sentence on exactly how a critic
will compare the work against it, and the piece list (with requirement
coverage when running from a spec). Execute only after the user replies "go".

## Step 3 — Run the loop

On "go", for each piece:

1. Fan out a `gauntlet-builder` subagent with its Task Spec. Pieces with
   disjoint file ownership run in parallel.
2. A builder's report is a claim, not a result. Re-run its verification
   command yourself before the round proceeds. Missing verification output, or
   output that doesn't match the report, is an automatic LOSS — back to a
   builder.
3. Send the real output and the bar — never the builder's code, reasoning, or
   prior rounds — to a fresh `gauntlet-critic` subagent. Shuffle the A/B
   labels whenever the medium allows.
4. On LOSS, send the critic's single biggest gap back to a builder for another
   round, with a fresh critic every round.

Loop rules:

- If the same gap survives two rounds, change the approach — new strategy, new
  decomposition, or race two builders on rival approaches — instead of
  polishing.
- Every few rounds, run the whole assembled result through the gauntlet, not
  just the pieces, and re-check previously won pieces for regressions after
  integration.
- If a piece is genuinely blocked on something only the user can resolve, mark
  it BLOCKED on the progress page and keep working the other pieces. Stop
  early only when everything is blocked.

Progress page: maintain `.gauntlet/progress.html` — one self-contained,
auto-refreshing HTML file with the round log, per-piece status, the latest
side-by-side, and verdict history. Save a snapshot each round under
`.gauntlet/runs/`.

## Win condition

The run ends when the assembled output wins the blind comparison twice in a
row against fresh critics, or the user stops it. Update
`.gauntlet/state.json` to `{"status": "complete"}` (or `{"status":
"stopped"}`), then report the final verdicts, the evidence behind them, and
where the work lives. When running from a spec, the report also maps every
requirement to the evidence that satisfies it.
