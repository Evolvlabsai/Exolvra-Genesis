# Distributed Rounds — spec

Status: draft, 2026-08-17. Origin: the Multica review (its pull-model daemon)
and the design discussion that followed. The furthest-out of the draft specs,
and the only one that changes the loop's physical shape. Do not start this one
until the trace, ownership-gate, and report-consistency specs have shipped —
each is load-bearing below.

## Why

A Genesis run today is bounded by one machine and one account's rate limits.
Multica's daemon shows the transport that removes the bound without a
networking conversation: every machine dials out (no inbound ports), pulls
claimed work, runs it locally with its own logins, and streams evidence back.
The design question this spec answers — where does the blind critic run? — has
an answer that *improves* the loop: rounds travel as content-addressed refs,
the critic receives only the bar and one pinned sha, and blindness stops being
an instruction and becomes structure.

## Constraints

- **C1 — The loop is never reimplemented.** Distribution changes where a
  builder or critic executes, never what the lead does, what the contracts
  say, or how judging works. One loop, one set of plugin markdown, wherever a
  round physically runs.
- **C2 — Transport is never presentation.** Rounds move as hidden namespaced
  refs (`refs/exolvra/rounds/<run>/<piece>/<round>`) or content-addressed
  bundles through the coordinator — never branches, never PRs. Humans see
  exactly what they see today: one progress page, and (under `work`) one pull
  request.
- **C3 — Everything that crosses a machine boundary is pinned.** The Report
  contract gains one field: the sha of what was built. The lead re-verifies
  that sha before any critic sees it; the critic fetches that sha and nothing
  else. A hash mismatch anywhere is an automatic failed round.
- **C4 — Builder and critic never share a machine for the same round.** The
  judge's independence is physical. (Same-machine fallback is allowed only
  when the fleet is one machine — which is today, and must keep working.)
- **C5 — Worker machines dial out; nothing dials in.** The daemon polls and
  heartbeats; a dead worker's claim lapses by TTL and the round is re-dispatched
  — the same claim/heartbeat/reclaim discipline the issue runner already
  proved, reused, not rewritten.
- **C6 — Credentials stay on their machine.** Each worker uses its own model
  logins; the coordinator holds no model credential and no worker's GitHub
  token; the 0.8.0 rule that loop sessions never see the runner's credential
  holds on every worker.
- **C7 — Capability is scheduled, not assumed.** A bar that demands perception
  (a platform, a browser, a screen) is matched to a worker that declares it;
  a run whose bar no worker can perceive is BLOCKED with the missing
  capability named — the critic's existing BLOCKED rule, moved up to
  scheduling.
- **C8 — Single-machine remains first-class.** No daemon, no coordinator, no
  new required infrastructure for the existing experience. Distribution is
  additive (`exolvra-genesis daemon`, or equivalent), never a migration.

## Requirements

- **R1** A worker daemon: registers its capabilities (models signed in,
  platform, browser), polls for claimed rounds, executes builder or critic
  rounds through the same session machinery, streams round events (into the
  trace), and deregisters on shutdown.
- **R2** Round dispatch: the lead publishes a Task Spec + base sha; a builder
  worker claims it, works, pushes the round ref, reports with the sha. The
  lead fetches, re-verifies (verbatim verification on the pinned tree), then
  dispatches judging to a different worker with the bar + sha only.
- **R3** Ref hygiene: round refs live outside `refs/heads/`, are invisible in
  Git UIs, and are deleted when the run settles — with the same
  cannot-force-push and namespace discipline `git.ts` already enforces.
- **R4** The fleet page shows workers: name, capabilities, live/last-seen,
  current round — the same template language, no second design.
- **R5** Failure honesty end to end: a worker dying mid-round, a ref that
  will not fetch, a sha mismatch, and a capability that disappears mid-run
  each produce the truthful state, label, and exit the single-machine loop
  would produce for the equivalent local failure. The fault matrix is part of
  this spec's acceptance criteria, per the run.md rule.

## Non-goals

Auto-merge (never); a scheduler smarter than oldest-first-that-fits; worker
auto-scaling; running the coordinator as a hosted service; splitting a single
round across machines (a round is atomic — distribution parallelizes rounds
and pieces, not one builder's work).

## Open questions for the run that takes this

Whether the coordinator is the existing lead process (simplest: the lead *is*
the scheduler for its own run) or a standing queue shared by runs; whether
bundles-through-coordinator beats refs-through-remote when the target repo's
remote is rate-limited; and what the minimum honest heartbeat/TTL is for
build rounds that legitimately run for an hour.

## Relation

Depends on: trace (worker events need somewhere to land — R1), ownership gate
(a remote builder's tree must be checked the same way — its snapshot/compare
runs on the worker, its verdict travels in the Report), report-consistency
(the sha field joins R1's checks). Builder-continuity applies per worker
unchanged.
