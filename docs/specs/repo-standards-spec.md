# Repo-Owned Standards and Named Goals — Specification v0.1

Exolvra Genesis owns orchestration; the target repo owns intent. A repo
declares its own standing quality bar and hard gates in
`.exolvra-genesis/standards.md`, and its own reusable jobs in
`.exolvra-genesis/goals/`. Every run in that repo inherits them
automatically, so quality standards live and version alongside the code they
govern instead of being re-improvised per run.

## Constraints (hard gates)

- C1. No new runtime dependencies beyond the set already allowed by the CLI
  spec.
- C2. Fully optional and backward compatible: a repo with no standards file
  and no goals directory behaves exactly as it does today, with no warning
  and no prompt.
- C3. Standards are read-only for the duration of a run — pinned by sha256
  when read and re-verified before every round, exactly like a run spec. A
  mismatch is BLOCKED.
- C4. A run may add gates but can never remove or weaken a gate declared in
  standards. Any run-level input that would drop a standing gate is a
  configuration error: exit 2, naming the gate.
- C5. Exolvra Genesis never writes to `.exolvra-genesis/standards.md` or
  `.exolvra-genesis/goals/` during a run. Only the explicit authoring
  commands create or modify them, and only after the user approves the
  content.
- C6. The gate and bar merge is loop behavior and lives in the plugin
  markdown (`commands/run.md`, Step 0), where the lead performs it with
  judgment. The CLI never implements merging, deduplication, or precedence
  logic — the loop is never reimplemented (CLI spec C3 applies).
- C7. Committed intent and ignored run state share `.exolvra-genesis/`
  deliberately, so the documented ignore pattern changes from ignoring the
  whole directory to:

      /.exolvra-genesis/*
      !/.exolvra-genesis/standards.md
      !/.exolvra-genesis/goals/

  Everything a run writes stays ignored; standards and goals are tracked.
  The README quickstart line and this pattern move together, and the
  authoring commands keep a target repo's `.gitignore` consistent with it
  (R7).

## Requirements

- R1. `.exolvra-genesis/standards.md` declares a repo's standing quality bar
  in a fixed shape: a purpose paragraph, `## Gates` (G1, G2, … one checkable
  line each), `## Standing bar` (artifacts or numbers, each with a path or
  value and a one-line description), and `## Conventions` (free prose the
  lead passes to builders).
- R2. Every run in the repo inherits the standing gates and standing bar
  automatically: the lead merges standards gates first, then run-level gates,
  deduplicating by meaning, and prints the merged list — inherited and
  run-level both — in its Step 2 summary. Per C6 this merge happens in the
  markdown, not in CLI code.
- R3. Precedence for the bar: run-level bar artifacts are primary for
  judging; standing bar artifacts remain in force as gates. A critic's
  verdict is a LOSS if either is unmet.
- R4. `.exolvra-genesis/goals/<name>.md` holds a named, reusable goal in the
  same format `/exolvra-genesis:run` already consumes as a spec.
- R5. `exolvra-genesis goals` lists available goal names with one-line
  descriptions; `exolvra-genesis goals show <name>` prints one.
- R6. `exolvra-genesis run <token>` resolves in a fixed, documented order: an
  existing file path is a spec; otherwise a bare token matching a named goal
  is that goal; otherwise the token is an inline goal. When a bare token
  matches both a goal and a path, exit 2 and state which one it would have
  used.
- R7. `exolvra-genesis standards init` runs the interview scoped to repo
  standards — stack, gates, standing bar, conventions — and writes
  `.exolvra-genesis/standards.md` only after the user approves the full
  file. If the repo's `.gitignore` still ignores the whole state directory,
  the command offers the C7 pattern and applies it only on approval.
- R8. `exolvra-genesis goals new <name>` scaffolds a goal file through the
  same interview, ending with the approved file written to
  `.exolvra-genesis/goals/`.
- R9. Plugin side: Step 0 of `run.md` reads `.exolvra-genesis/standards.md`
  when present, merges its gates per R2, and adds the standards sha256 to the
  integrity attestations published every round.
- R10. The progress page distinguishes inherited standing gates from
  run-level ones, so a reader can tell which constraints came from the repo.
- R11. `exolvra-genesis standards check` validates that the file parses, that
  every gate is phrased as something checkable, and that every standing bar
  artifact resolves; exit 2 with per-line errors when it does not.

## Non-goals

- No user-level or global standards, and no inheritance between repos —
  standards are per-repo, on purpose.
- No repo registry or config file. Exolvra Genesis reads standards from the
  repo it is already running in.
- No automatic migration of existing run bars into standards.

## References (bar candidates)

- `owainlewis/factory`'s target-repo model (`AGENTS.md`, `STANDARDS.md`,
  `.factory/goals/`) as the structural reference for the split between
  orchestration and intent.
- `bars/cli-ux/` — the committed gh + clack transcript pack from the CLI
  build — for the new subcommands' help, output, and error surfaces.
- A `.exolvra-genesis/standards.md` written for this repo itself during the
  run — dogfooding is the fastest check that the format is livable.

## Addendum v0.1.1 — R7's mechanism, recorded

R7 and R8 both say "the interview," and they ship on two mechanisms: `goals
new` scope-briefs `commands/interview.md` through a live agent session,
while `standards init` is a local, deterministic question flow that reaches
no SDK. The judged run scored R7 met on substance — every clause runs: one
question at a time, scoped to stack, gates, standing bar and conventions,
with the whole file shown and approved before anything is written.

The divergence is deliberate, and the reason is access, not C6: declaring
standards must work with zero credentials, offline, in CI, because it is
the doorway to everything else — a repo should not need a model session to
state its own gates. Goal authoring produces spec-format prose where an
agent's drafting genuinely helps, so it borrows the interview. If the two
are ever unified, unify toward the interview only if `standards init` keeps
a credential-free path.
