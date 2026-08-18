# Live Status & Run Control — spec

Status: draft, 2026-08-18. Origin: the observation that Genesis is excellent at
showing what happened and weak at showing what is happening now — a builder
round can run twenty minutes while the progress page shows the previous round.
Sits directly on top of the trace spec and should be built in the same run or
the one after it: every surface here is a thin reader over trace data, and
every control verb closes through state the loop already settles.

## Why

Three moments this month wanted these features and did not have them: builders
killed by session limits mid-run, discovered only by their absence; a stalled
external process distinguishable from a working one only by patience; and a
budget question ("how much has this cost so far?") answerable only after the
round ended. Monitoring answers "what is happening"; management answers "make
it stop" — they share every data structure, so they ship together.

## Constraints

- **C1 — Readers, not actors.** Every monitoring surface reads the trace and
  run state; none of them writes anything a run depends on, and a monitoring
  failure never fails a run (trace C1/R6 inherited).
- **C2 — Silence is never green.** Any live view that cannot distinguish "no
  events because idle" from "no events because dead" must say which it cannot
  tell. A stall is rendered as loudly as a failure.
- **C3 — Stopping settles truthfully.** `stop` is not `kill`: the run must end
  in the same state an interrupt in its own terminal produces — state.json
  settled, ledger truthful, claims released or labelled per R15 of the
  issue-runner spec, no lifecycle label stranded. Only when graceful stopping
  fails does escalation to a hard kill happen, and then the aftermath is
  recorded as exactly that.
- **C4 — One design language.** The live page is the progress template's data
  contract fed at event cadence — sentinel markers, same renderer, no second
  design (R8 discipline). The status command uses the house table discipline.
- **C5 — No server, no sockets, no new runtime dependencies** (G3). Pages are
  files; the terminal surfaces poll the trace cursor. The 20-second page
  refresh may drop to 2 for an active run, still file-polled.
- **C6 — Everything shown passes the redaction chokepoints** before rendering,
  as on every other surface.

## Requirements

- **R1 — `status`.** One screen for the current project: each active run —
  phase, piece table, current round, live subagents (age, last-event age),
  spend vs. cap, and a STALLED flag when last-event age exceeds the threshold.
  Exit 0 with "nothing is running" as a normal state. `--json` fixed-shape;
  `--watch` re-renders on the trace cursor.
- **R2 — Live progress.** The lead (CLI loop) updates the progress page's data
  block from trace events at most every few seconds during a round — current
  builder, current activity line, tokens/cost so far — while round-boundary
  updates keep their existing meaning. The page states the data's age
  ("as of 12s ago"), so a stale page reads as stale, never as current.
- **R3 — The stall watchdog.** A configurable threshold (default on the order
  of minutes, distinct per phase kind — builders may think long, verification
  should not) marks a subagent STALLED on the page, in `status`, and as a
  trace event. The watchdog flags; it never kills. Killing is R4's job, a
  human's decision.
- **R4 — `stop <run-id>` (and `stop` bare with one active run).** From any
  terminal: signal the run's process tree per the trace's process map, wait
  for graceful settling with a visible countdown, verify the settled state
  (C3), and report what was released. `--force` escalates after grace expires
  and reports the aftermath honestly — including anything it could not settle.
- **R5 — Budget at a glance.** Spend accumulates in the trace per round and
  per piece (trace R5); `status` and the live page render burn-down against
  the caps, and crossing 80% of any cap is a trace event the page renders
  amber.
- **R6 — Honest degradation.** All of R1–R5 behave sensibly when the trace is
  absent (older runs, disabled tracing): `status` falls back to ledger + state
  truthfully labelled as "last written", the page keeps round-boundary
  updates, and `stop` still works through state.json and the ledger alone.

## Non-goals

Web servers, sockets, push notifications, webhooks, and hosted dashboards;
pausing/resuming a round in place (stop-and-resume through the existing
`resume` is the supported path); cross-project aggregation (the fleet page
already covers the issue runner's multi-repo view); killing individual
subagents while keeping the run alive (a round is atomic — stop the run or
let the round finish).

## Hard gates for the run that builds this

A run stopped via R4 must be indistinguishable on disk and on GitHub from the
same run interrupted in its own terminal — asserted, not assumed. The
watchdog must never fire on a healthy long round given only slow output
(feed it a builder that emits one event per threshold-minus-epsilon). And the
live page under a hostile activity line (secrets, markers, bidi) stays inert
— the R2 activity text is model output, therefore untrusted renderer input.

## Relation

Depends on the trace spec (events, cursor, process map, spend). Extends, and
must not fork, the progress template's data contract. `stop` reuses the
settling paths R15/C7 of the issue-runner spec proved; distributed-rounds
later extends `status` to workers with the same vocabulary.
