# The Run Trace — spec

Status: draft, 2026-08-17. Origin: reviewing disler/super-simple-software-factory,
whose SQLite trace is the strongest observability design we have seen for agent
runs. Independent of every other draft spec; a natural first pick because it is
pure observability — it changes what we can see, never what runs do.

## Why

A Genesis run today leaves `progress.html` (human-readable, per-round), snapshots,
and `runs.json`. None of it is queryable, none of it is tool-call-granular, and
when a subagent dies mid-run (session limits killed two in one day) nothing maps
runs to living processes. The factory's answer: every event lands in one SQLite
file *while it happens*, readers poll a rowid cursor, WAL keeps reads from ever
blocking writers, and a `processes` table makes a stuck run findable and
killable. Files stay the record; the db is a disposable mirror.

## Constraints

- **C1 — The ledger and the artifacts remain the record.** `runs.json`,
  `progress.html`, and round snapshots keep their exact current meaning.
  Deleting the trace loses nothing that cannot be rebuilt; the trace is a
  mirror, never a source of truth. No behavior may read the trace to decide
  anything.
- **C2 — No new runtime dependencies.** G3 stands: the SDK and `@clack/prompts`,
  nothing else. `node:sqlite` may be used where the running Node provides it;
  where it does not, the same contract must be met by an append-only NDJSON
  event file with a byte-offset cursor. The storage engine is an implementation
  choice behind one module; the query contract is not.
- **C3 — One writer path, in one module.** Every event enters through a single
  tracer seam. Nothing else in `src/` opens the trace store.
- **C4 — Reads never block a running run.** Live view and history are the same
  query at different cadence; there is no ingest endpoint, no socket, no
  second transport.
- **C5 — Redaction before persistence.** Everything issue- or model-derived
  passes the existing `redactSecrets`/flattening chokepoints before it lands in
  the trace, the same as every other surface. A trace row is an artifact under
  C12 of the issue-runner spec.
- **C6 — The trace lives in run state.** Under `.exolvra-genesis/` in the target
  project, gitignored, covered by the runner's own state-dir exclusion.

## Requirements

- **R1** Events for: run started/finished, piece dispatched, builder
  round started/ended (with verbatim-verification status), critic dispatched,
  verdict recorded (with gap summary), gate/pin checks, budget spend, and
  every error path — each stamped with run id, piece, round, and time.
- **R2** A `processes` mapping: run id → live subagent/task identifiers, opened
  on dispatch, closed on completion or death, so `exolvra-genesis runs` can show
  what is actually alive and a stuck run can be found.
- **R3** A `trace` CLI surface: `exolvra-genesis trace <run-id>` prints the
  event stream (house table discipline, `--json` NDJSON, `-f` to follow via
  the cursor). Empty trace is a normal state, not an error.
- **R4** The progress page keeps working unchanged; it may later be derived
  from the trace, but this spec does not require it.
- **R5** Token/cost totals per round and per piece, accumulated across retries
  (a retried round paid for every attempt — record what was spent, not what
  the last attempt cost).
- **R6** The tracer's failure never fails a run: if the trace store cannot be
  written, the run warns once and continues. Observability must not become a
  new way to lose work.

## Non-goals

The visualizer UI (the fleet/progress pages already exist); cross-run
analytics; any scheduling or control decisions read from the trace.

## Hard gate for the run that builds this

An adversarial pass must include: hostile content in event payloads (secrets,
bidi, markers) never reaching the store unredacted; the reader mid-write under
load; and a run killed mid-round leaving the trace finalized as failed, never
`running` forever.
