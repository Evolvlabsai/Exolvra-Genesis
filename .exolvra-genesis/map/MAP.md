# Issue runner: build and adoption decisions

## Destination

Build-ready inputs for the issue runner, followed by a human-approved choice
of its first live repository and operating limits.

## Notes

This is the first chart dogfood map, created from source inspection on
2026-09-17. Existing requirements in docs/specs/issue-runner-spec.md are inputs,
not new human decisions. Repository standards remain authoritative. Preserve
the shared markdown loop, the two allowed runtime dependencies, GitHub's
single network boundary, explicit ready-label authorization, secret redaction,
and human control of merging. The research below verifies source and tests;
it does not claim a successful live GitHub deployment or human approval.

## Decisions so far

- [Locate the runner's safety boundaries](tickets/runner-safety.md): Existing modules and spec define the build constraints.
- [Verify chart transport and approvals](tickets/chart-transport.md): Local and HTTP integration tests cover the decision workflow.

## Not yet specified

The first live deployment may expose repository-specific review capacity and
credential constraints. Those cannot be specified until a repository and an
operator have been chosen. Do not pre-slice that unknown work.

## Out of scope

- A third tracker or automatic migration between tracker modes.
- Automatic merging, approving, or closing the runner's build issues.
- Publishing this checkout or labeling real issues ready without human approval.
- Claiming a simulated provider response proves a successful live agent build.
