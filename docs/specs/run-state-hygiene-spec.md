# Run-State Hygiene — spec

Status: draft, 2026-08-18. Origin: a live failure this morning. A fresh run
started into `.exolvra-genesis/` still holding a finished run's world — its
bar, its task specs, its progress page marked COMPLETE — and the lead spent 33
minutes and $4.51 reading the museum without writing a file; the resumed lead
found `state.json` saying `running` beside a progress page saying `complete`
and settled `blocked` rather than bulldoze. Both leads behaved honestly inside
a layout that made honesty expensive. The layout is the bug.

## Why

Run-scoped artifacts (`bar/`, task specs, `progress.html`, briefs) live at the
state root and survive their run, so every later run inherits a stage full of
someone else's props. The fix is structural, not janitorial: state that
belongs to a run lives under that run's directory and dies (archives) with
it; the root holds only what is genuinely cross-run. A startup sweep exists
only to migrate the legacy layout and to catch strays — not as the design.

## Constraints

- **C1 — Scope by run.** Everything a single run produces lives under
  `.exolvra-genesis/runs/<run-id>/` — the bar and its pins, task specs, the
  progress page, critic briefs, snapshots. The state root holds only
  cross-run state: `standards.md`, `goals/`, `runs.json`, `state.json`, and
  `runs/` itself. One active run per project remains the contract.
- **C2 — The plugin and the CLI move together (C3 of the CLI spec).** The
  paths are written into `commands/run.md`, both hook examples, and the
  templates; every file that names a path changes in the same commit, and the
  hooks' greps must match how the files are actually written afterward.
  Behavior lives in the markdown — this spec's paths are load-bearing wording.
- **C3 — Startup hygiene is mechanical and runs before any model spawns.**
  The lead's judgment is never the janitor. On `run` start: a previous run
  that settled (`complete`/`stopped`) has any legacy root-level artifacts
  archived into its own run directory, reported in one line; a previous run
  still `running` or `blocked` is a refusal, exit 2, naming both remedies
  (`resume <id>` or `stop`-and-confirm) — an unfinished run's state is never
  swept, moved, or overwritten.
- **C4 — The janitor archives, never deletes.** Nothing under
  `.exolvra-genesis/` is ever removed by hygiene — moved into the owning
  run's directory, with `standards.md`, `goals/`, and the ledger untouchable
  by the sweep under any input.
- **C5 — Integrity pins scope with the run.** `state.json` names the active
  run (`{"status": ..., "run": "<id>"}` — additive, so the verification
  hook's existing grep keeps matching); the bar-integrity hook resolves the
  active run's `bar.sha256` through it. A pin check can never again verify a
  dead run's bar against a live run's work.

## Requirements

- **R1** The reported failure, reproduced as a fixture and pinned: a state
  dir carrying a settled run's full leftovers at legacy root paths; a new
  `run` starts; assert the sweep archived them before the session spawned,
  the lead's working paths were empty, and the archive landed under the old
  run's directory with the one-line report printed.
- **R2** The unfinished-previous-run refusal, both flavors (`running`,
  `blocked`), with zero writes and the remedies named — and `resume` still
  working on the refused run afterward.
- **R3** `resume` handles both layouts: a run created before this change
  migrates on resume (same rules: settled strays archive, its own live state
  moves to its run directory) or refuses with a clear message — decided in
  the run, documented in help.
- **R4** `runs` shows which run is active; the progress page and snapshots
  for a run are findable from its ledger row alone.
- **R5** The hooks' example JSON, the README's state-layout paragraph, and
  `CLAUDE.md`'s run-state section all describe the new layout in the same
  commit — G6's contract-consistency gate extended to the paths.
- **R6** Full suite green; version bump per the one-version rule; CHANGELOG
  entry that names the incident class this closes.

## Non-goals

Multiple concurrent runs per project (still one; this spec just makes the
one honest); any automatic deletion or retention policy (archives accumulate
until a human decides — disk is cheaper than a destroyed run); changing what
any artifact contains — only where it lives.

## Hard gate for the run that builds this

An adversarial pass must attack the janitor itself: a hostile `state.json`
(garbage JSON, absurd run id, path traversal in the id), a sweep interrupted
halfway (re-running must converge, never double-archive or lose a file), and
the race of two `run` starts in one project (one wins, one refuses; never
two archives, never a shared bar).
