# Specification implementation status

Version 0.13.0, 2026-09-18. The contracts remain in `docs/specs/`; this page
maps them to the implementation and its verification boundaries.

Since 0.13.0 this repository holds the loop only: the plugin and the CLI
commands that run it (`interview`, `plan`, `run`, `resume`, `runs`, `status`,
`stop`, `trace`, `doctor`, `standards`, `goals`, local `chart`, `gate`). The
GitHub issue runner, the control panel, distributed rounds, GitHub-backed
charts, and their specifications and protocol models moved to the Exolvra
control plane, which is private. Earlier public commits and published versions
up to 0.12.0 still contain them.

| Specification | Implementation | Regression coverage |
| --- | --- | --- |
| Builder continuity | Per-piece builder sessions, cold-start reasons, poison handling; fresh critics | `round-guards` |
| Charting | Local Markdown maps, claims, parallel research, human dialogue, prototypes, spec and goal handoffs | `chart` |
| First contact | Bounded execution probe, model error messages, terminal-only permission retry, packaged-install checks | `first-contact`, `package`, `session` |
| Live status | Observed activity, per-agent stalls, budget warnings, watch mode, graceful and forced stop | `live-status-stop`, `trace-liveness` |
| Ownership gate | Content snapshots including ignored files, disjoint ownership, rollback preserving pre-existing edits, optional plugin hook | `ownership-consistency`, `round-guards`, `plugin-gate` |
| Repository standards | Repository-owned standards, named goals, inherited validation, interview and chart handoffs | `standards`, `goals`, `input`, `chart` |
| Report consistency | Report/verdict checks, bounded producer corrections, advancement guards, finding fingerprints, shared outcome mapping | `ownership-consistency`, `round-guards`, `run`, `runs` |
| Run-state hygiene | Run-scoped artifacts, legacy migration, active-owner checks, resume settlement | `state-hygiene`, `runs`, `live-status-stop` |
| Trace | Sanitized durable events, process liveness, read-only inspection, degradation and provider spend receipts | `trace-*`, `run-evidence-capture` |

Test names in the table refer to `cli/test/<name>.test.js`. Run the complete
verification with `cd cli && npm test`; it builds the CLI and packaged plugin
before running the tests.

Verified on Windows on 2026-09-18: **1,035 tests passed in 47 suites**, with
zero failures, skips or cancellations. Package-install checks and real
stop/SIGINT parity checks are included in that run. `git diff --check` also
passed.

## Approved SDK adaptations

The installed Claude Agent SDK does not expose a public tool-only execution
probe. The owner approved a small model-backed permission probe before the
build. It must observe the exact no-op tool execution; its provider-reported
spend is included in accounting. See the amendment in
[First Contact](specs/first-contact-spec.md).

Local SDK dollar receipts cover whole lead sessions, including nested work.
Those totals are preserved exactly; unavailable piece/round splits are labeled
unavailable. The owner approved this scope in [Trace R5](specs/trace-spec.md).

## Verification boundaries

Integration tests exercise real local files, Git repositories, CLI processes,
terminal interaction and package installation. The external SDK boundary is
substituted; this is not evidence of a paid model run. The first real run
after 0.12.0, on a small Node project, won after two rounds and is what fixed
the probe's budget and turn handling recorded in the First Contact amendment.
