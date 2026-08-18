# Builder Continuity — spec

Status: draft, 2026-08-17. Origin: hard-won experience (the issue-runner build
ran fastest once long-lived builders were resumed instead of respawned), and
the factory review, which makes create-or-continue a first-class primitive:
"a correction costs one message; a cold restart throws away everything the
agent learned."

## Why

Genesis's loop rules already batch findings, but the *transport* of a
correction is still ad hoc: the lead re-engages a builder if its session
happens to be alive, and silently pays a full cold start (re-reading the spec,
the bar, the code — 50–100k tokens) when it is not. The factory persists an
agent map (agent → session id) in run state, so joining a run resumes every
agent's context window by construction. Continuity should be the loop's
default, spelled out, with the cases that must NOT be continuous named just as
clearly.

## Constraints

- **C1 — Critics are never continuous.** A critic is fresh-context by
  definition; nothing in this spec touches judging. The agent map holds
  builders only.
- **C2 — Continuity is an optimization, never a dependency.** A builder session
  that cannot be resumed (expired, died, model changed) falls back to a cold
  start with the full brief; the run's outcome must be identical either way.
  No state a round depends on may live only in a builder's context window —
  the Task Spec, the findings batch, and the Report remain the contract.
- **C3 — The map is run state.** `builders.json` (or equivalent) lives under
  `.exolvra-genesis/runs/<id>/`, gitignored, covered by the state-dir
  exclusion, and settled truthfully on every exit path like everything else.
- **C4 — A resumed builder gets the delta, not the world.** The correction
  message carries the batched findings and what changed since its last round —
  never a re-pasted spec it already holds. (This is where the savings are.)
- **C5 — Poisoned context is grounds for a fresh start.** Two consecutive
  rounds where the same builder reintroduces a fixed defect, or a breach under
  the ownership gate, ends that session; the lead spawns cold and says so in
  the round log. Continuity must never become loyalty.

## Requirements

- **R1** The CLI's loop records, per piece: builder session identity, model,
  and rounds served; `resume` re-attaches to live sessions where the platform
  allows and reports honestly where it does not.
- **R2** The lead's markdown (`commands/run.md`) states the rule in its own
  voice: batched findings go back to the same builder while its session
  serves; the three fresh-start triggers (dead session, model change,
  poisoned context) are listed beside it.
- **R3** Round logs record whether each round was a continuation or a cold
  start, and the cold-start reason — so the cost of lost continuity is
  visible, not folklore.
- **R4** Works identically under `run` and the issue runner's `work` (C3 of
  the CLI spec: one loop, never two).

## Non-goals

Cross-run continuity (a builder remembering a previous run is a bug, not a
feature — every run's context begins at its own spec and bar); any form of
critic session reuse; persistence of model conversations outside the
platform's own session store.

## Relation

Independent. Pairs naturally with the trace spec (R3's continuation/cold
events belong in the trace when both exist).
