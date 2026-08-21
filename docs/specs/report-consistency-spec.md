# Report Consistency Gates — spec

Status: draft, 2026-08-17. Origin: the factory review. Its `verdict_consistent`
gate refutes a reviewer that approves while listing blocking items — a lie
caught mechanically, without reading a line of the diff. Genesis's contracts
(the builder Report, the critic verdict) deserve the same class of check: cheap,
code-only, run before any expensive step spends money on a claim that
contradicts itself.

## Why

The loop's expensive resources are critic rounds and lead attention. Both are
sometimes spent on reports that a predicate could have bounced in milliseconds:
a Report whose FILES CHANGED names files that do not exist on disk, a
verification section whose verbatim output disagrees with the exit it implies,
a WIN verdict whose own GAP text names an unfixed hard-gate failure. Every one
of these is a contradiction *inside* the artifact — no judgment required, only
reading it against itself and against the disk.

## Constraints

- **C1 — Gates check claims, never quality.** A consistency gate may compare an
  artifact against itself and against mechanically observable facts (a file
  exists, a hash matches, a number sums). It never evaluates whether the plan
  is good or the code is right — that remains the critics' whole job, and no
  green gate may ever be cited as evidence of quality.
- **C2 — A gate failure is a correction, not a verdict.** It flows back to the
  producer (builder or critic) as a named violation in the same round — it
  costs a message, not a round. Bounded attempts; exhaustion fails the round.
- **C3 — Gates live in code, in the CLI loop machinery** (and as lead-side
  checks in `run.md`'s own voice for the plugin). A gate is one function with
  one job, and each records what it verified, not only that it passed.
- **C4 — No new runtime dependencies** (G3).

## Requirements

- **R1 — Report gates**, run when a builder reports: every FILES CHANGED path
  exists (or is a recorded deletion); the verification command in COMMANDS RUN
  matches the Task Spec's; the verbatim verification output is non-empty and
  its pass/fail reading agrees with the builder proceeding to report success.
  When the ownership gate exists, its touched-set is compared against FILES
  CHANGED — the disagreement is a violation on its own.
- **R2 — Verdict gates**, run when a critic reports: WIN with a GAP that names
  an unmet hard gate is refused; LOSS with no finding at all is refused;
  BLOCKED without a named missing capability is refused; a findings list that
  contains items marked confirmed while the verdict says clean is refused.
- **R3 — Run-level gates**, run at settle: the summary the human reads (final
  report, ledger row, exit code) is derived from one source so it cannot
  self-contradict — extending the exit-table discipline the issue runner
  already has to the `run` command's own endings.
- **R4** Every gate's checks are recorded per round (in the trace, once it
  exists; in the round log regardless), so a green gate says what it looked at.
- **R5 — Finding fingerprints, the see-saw rule as a mechanism.** Each
  round's findings are normalized and hashed (finding text + the criterion or
  gate it cites), and the candidate's diff is hashed beside them. The loop's
  existing judgment rules then get mechanical triggers: the same fingerprints
  over an unchanged diff mean the round was duplicated — do not dispatch a
  builder for it; the same fingerprints recurring over a materially changed
  diff for two rounds is the gap-survives signal, surfaced to the lead by
  code rather than by memory; and two consecutive rounds whose fixes each
  reintroduce the other's fingerprints is the see-saw, surfaced the same
  way. The triggers inform the lead's judgment (run.md already owns the
  response — change approach, question the spec); they never auto-stop a run
  themselves. Origin: an external review (Codex, 2026-08-20) proposed the
  hash; the loop had the rule as prose and had already paid five rounds to
  learn it.

## Non-goals

Semantic review of any kind; schema-typed builder output (the Report stays
prose-with-structure — these gates parse what the contract already promises,
they do not change the contract); gating the plugin's conversational
interview.

## Relation

Independent. Strongest when the ownership gate exists (R1's cross-check) but
does not require it.
