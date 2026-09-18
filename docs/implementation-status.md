# Specification implementation status

Version 0.12.0, 2026-09-18. The contracts remain in `docs/specs/`; this page
maps them to the implementation and its verification boundaries.

| Specification | Implementation | Regression coverage |
| --- | --- | --- |
| Builder continuity | Per-piece builder sessions, cold-start reasons, poison handling; fresh critics | `round-guards`, `distributed-runtime` |
| Charting | Local Markdown and native GitHub maps, claims and heartbeats, research, human dialogue, prototypes, approved handoffs | `chart` |
| Control panel | Live evidence, run summaries, source-linked files/checks/findings and round comparisons, project registration, detached command execution with a persistent queue and configurable concurrency, shared-key sessions, portable deployment examples | `panel-auth`, `panel-data`, `panel-evidence`, `panel-jobs`, `panel-server`, `run-evidence-capture`, `package` |
| Distributed rounds | Outbound-polling daemons, pinned bundles, lead verification, separate critic machines, capabilities, cancellation and billing recovery | `distributed-runtime`, `distributed-lead`, `distributed-rounds`, `git` |
| First contact | Bounded execution probe, model error messages, terminal-only permission retry, packaged-install checks | `first-contact`, `package`, `session` |
| Issue runner | Shared build loop, authenticated claims and recovery, guarded branches and PRs, interrupt settlement | `work`, `github`, `git`, `live-status-stop` |
| Live status | Observed activity, per-agent stalls, budget warnings, watch mode, graceful and forced stop | `live-status-stop`, `trace-liveness` |
| Modeled protocols | TLA+ documents, exhaustive TypeScript explorer, invariant-name drift gate, broken-model counterexamples | `claim-protocol`, `distributed-rounds`, `model-pairs` |
| Ownership gate | Content snapshots including ignored files, disjoint ownership, rollback preserving pre-existing edits, optional plugin hook | `ownership-consistency`, `round-guards`, `plugin-gate` |
| Repository standards | Repository-owned standards, named goals, inherited validation, interview and chart handoffs | `standards`, `goals`, `input`, `chart` |
| Report consistency | Report/verdict checks, bounded producer corrections, advancement guards, finding fingerprints, shared outcome mapping | `ownership-consistency`, `round-guards`, `run`, `runs` |
| Run-state hygiene | Run-scoped artifacts, legacy migration, active-owner checks, resume and issue settlement | `state-hygiene`, `runs`, `live-status-stop` |
| Trace | Sanitized durable events, process liveness, read-only inspection, degradation and provider spend receipts | `trace-*` |

Test names in the table refer to `cli/test/<name>.test.js`. Run the complete
verification with `cd cli && npm test`; it builds the CLI and packaged plugin
before running the tests.

Verified on Windows on 2026-09-17: **1,535 tests passed in 47 suites**, with
zero failures, skips or cancellations. The exhaustive models visited all
44 claim-protocol states and 248 distributed-protocol states within their
declared bounds. Package-install checks and real stop/SIGINT parity checks
are included in that run. `git diff --check` also passed.

## Approved SDK adaptations

The installed Claude Agent SDK does not expose a public tool-only execution
probe. The owner approved a small model-backed permission probe before the
build. It must observe the exact no-op tool execution; its provider-reported
spend is included in accounting. See the amendment in
[First Contact](specs/first-contact-spec.md).

Local SDK dollar receipts cover whole lead sessions, including nested work.
Those totals are preserved exactly; unavailable piece/round splits are labeled
unavailable. Isolated distributed round sessions retain their exact receipts.
The owner approved this scope in [Trace R5](specs/trace-spec.md).

## Verification boundaries

Integration tests exercise real local files, Git repositories, CLI processes,
terminal interaction and package installation. The external SDK and GitHub
service boundaries are substituted; this is not evidence of a paid model run
or a live deployment across multiple machines. Distributed storage must satisfy
the documented trust and atomic-operation requirements in
[distributed rounds](distributed-rounds.md).

The control panel was also checked in Chrome at desktop and mobile sizes
against real local HTTP servers: navigation, filtering, project registration,
exports, form preservation during polling, shared sign-in, session persistence,
independent member sessions and sign-out. Run-detail checks cover summaries,
evidence provenance, round comparisons, exact older source events, event paging,
keyboard tabs and modal focus, polling preservation, inert hostile text, missing
historical evidence, and both themes at desktop and 320/390-pixel mobile widths.
These checks made no paid model calls.
The [deployment guide](control-panel.md) covers direct Node, a service behind an
HTTPS proxy and containers. Docker is unavailable in this development
environment, so the image and Compose example have not been build-tested.

The [dogfood map](../.exolvra-genesis/map/MAP.md) records source-backed decisions.
Its first live repository, operator and rollout limits remain human choices.
The map does not invent their approval. No live issues were labeled ready,
pull requests merged, or deployment performed as part of this implementation.
