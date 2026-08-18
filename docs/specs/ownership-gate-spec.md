# The Ownership Gate — spec

Status: draft, 2026-08-17. Origin: the factory review. Its `permissions.py`
turns "this agent may only touch these files" into a mechanism — snapshot the
tree before an agent runs, compare after, roll back what it was not allowed to
change, fail the phase. Genesis polices the same rule (Task Spec "files owned,
disjoint") by convention and critics. This spec turns it into code, and closes
the three holes the factory's version ships with.

## Why

A builder that edits outside its owned files corrupts a parallel builder's
work, and today we find out at integration or judging — rounds later. The
factory's insight: enforcement after the fact, against the repo itself, catches
what capability lists cannot (`bash` can `git checkout` anything). Its holes,
found in our code review, become this spec's hard requirements: fingerprints
were line counts (an edit that keeps the counts is invisible), gitignored paths
were entirely out of scope (any agent could rewrite `.env` undetected), and the
enforcement layer itself shipped with zero tests.

## Constraints

- **C1 — Enforcement is the lead's, in code.** The comparison and rollback run
  in the loop machinery (CLI) or as a hook (plugin), never inside a builder's
  own instructions. An agent must not be able to edit the mechanism that
  grades it — including its own Task Spec's ownership list.
- **C2 — Fingerprints are content, not counts.** A path's before/after state is
  a content hash. Same-shape edits, binary changes, and mode changes all
  register.
- **C3 — Gitignored paths are in scope.** The run's own state directory
  (`.exolvra-genesis/`) and each builder's declared scratch space are the only
  exclusions. Everything else — `.env` included — counts.
- **C4 — Rollback never destroys the operator's work.** A path that was already
  dirty before the round is never "restored" by the gate; if a builder reverted
  uncommitted work the gate cannot reconstruct, it says so loudly and fails the
  round. (The factory got this right; keep it.)
- **C5 — A breach is not a finding.** Findings are for work a builder can redo.
  A breach aborts the round after rollback, names every offending path, and is
  recorded in the round log. Repeated breach by the same builder is grounds for
  a fresh builder, not a third correction.
- **C6 — No new runtime dependencies** (G3). Hashing and diffing use node
  built-ins and git.

## Requirements

- **R1** Snapshot before dispatch, compare after the builder reports; the
  legitimate touched-set is recorded (what a builder actually changed, beside
  what its Report claimed — disagreement between the two is itself a finding).
- **R2** Ownership comes from the Task Spec's files-owned list, resolved to the
  same pattern semantics everywhere (document them; `*` must not cross `/`).
- **R3** Unauthorized introductions are rolled back (delete what appeared,
  restore what changed from HEAD), then the round fails with the full list.
- **R4** Disjointness is checked at decomposition time: two parallel pieces
  claiming overlapping patterns is a configuration error before any builder
  spawns.
- **R5** The plugin gets the same protection as an opt-in hook (the existing
  hook pattern: like `bar-integrity-gate`, a PreToolUse/Stop pair), honestly
  documented as weaker than the CLI's in-loop enforcement.
- **R6** The gate's own test suite is adversarial and includes at minimum: the
  same-count edit, the gitignored write, the binary change, the revert of
  operator work, a git failure mid-snapshot (must fail loudly, never blind the
  gate silently), and a breach interleaved with a legitimate change.

## Non-goals

Sandboxing, syscall interception, or preventing writes in real time — this is
detection and repair after the fact, which is the same trust model as the rest
of the loop (evidence over claims). Subagent credential scrubbing already
shipped in 0.8.0 and is not re-specified here.

## Relation

Independent of the trace spec, but if the trace lands first, breaches and
touched-sets should land in it (trace R1 already names the event).
