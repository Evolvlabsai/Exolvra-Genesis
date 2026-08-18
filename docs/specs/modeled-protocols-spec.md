# Modeled Protocols — spec

Status: draft, 2026-08-18. Origin: the claim/heartbeat/reclaim protocol took
eight adversarial passes to converge, and its central discovery — with
forgeable evidence, every decision procedure either lets a stranger cause a
write or lets a stranger strand an issue — is exactly the kind of
impossibility an exhaustive state search demonstrates in minutes for free.
Round 6 of the trace-store build (a recovery seam that bypassed the thing
under test) is the same lesson smaller. The owner's constraint, adopted here:
**no Java, no new toolchain** — the standard notation is for people, and the
checking runs in plain Node inside the suite that already exists.

## Why

Protocol pieces — claims, locks, recovery, anything with concurrent actors or
an attacker — lose rounds differently than rendering pieces do: their bugs
live in interleavings no example-based test stumbles into, and each one costs
a full build-judge round to surface empirically. Model the protocol at
planning time and search its whole state space mechanically, and those rounds
move from the critic's bill to a millisecond loop. But an unchecked model is
a claim, not evidence — the stale-premise bug born formal — so the model and
its check are one deliverable here, never two.

## Constraints

- **C1 — The notation is TLA+; the checker is the suite.** The planning
  artifact is written in TLA+ syntax (the standard format: states,
  transitions, invariants, fairness notes as comments) so it is readable,
  reviewable, and portable to real TLC by anyone who has Java — but nothing
  in this repo requires TLC, Java, or any new tool. The mechanical check is
  an exhaustive explicit-state explorer in plain TypeScript, run by
  `node --test` like every other verification.
- **C2 — No new runtime dependencies (G3), and the explorer is test-land.**
  The explorer harness lives with the tests (or as a src module only if a
  command ships it — not required by this spec); the CLI's dependency list
  does not move.
- **C3 — A model without its explorer is not done.** A piece under this spec
  ships three things or none: the `.tla` document, the explorer test whose
  states, transitions, and invariants mirror it, and a green exhaustive run
  with its state count printed. Any one alone fails the piece.
- **C4 — The names are the drift guard.** Every invariant in the `.tla`
  carries a name; the explorer asserts invariants under the same names; a
  gate greps both files and fails on an invariant present in one and absent
  in the other. A premise that exists in prose and code under one name
  cannot silently become two stories.
- **C5 — Exhaustive means exhaustive, and bounds are stated.** The explorer
  visits the full reachable state space under explicitly declared bounds
  (actors, retries, queue depths), and the test prints states visited and
  the bounds. A space too large to exhaust is a design smell first and a
  bounds negotiation second — never a silent sample. The attacker is a
  first-class actor: an explicit set of moves (inject a comment, forge a
  field, crash a process) always enabled, so every claim about "a stranger
  cannot" is quantified over every reachable interleaving.
- **C6 — Models bind the pieces they model, prospectively.** New
  protocol-shaped pieces (the planning stage decides, and says so in the
  Task Spec) carry a modeling requirement in their acceptance criteria.
  Shipped protocols are modeled retroactively only where this spec's
  requirements name them; nothing else reopens.

## Requirements

- **R1 — The explorer harness.** A small, generic breadth-first
  explicit-state explorer: `explore({ init, actions, invariants, bounds })`
  returning either exhaustion (with state count) or a counterexample as a
  readable trace — the sequence of named actions from init to violation,
  printed the way a critic would want to replay it. Deterministic ordering,
  cycle detection, and a hard state ceiling that fails loudly rather than
  swallowing memory.
- **R2 — The proving ground: the claim protocol, retroactively.** Model the
  shipped claim/heartbeat/reclaim lifecycle (ready/working/review/blocked/
  triage × sticky attestation × heartbeat freshness × one attacker × one
  crashing runner) in `docs/models/claim-protocol.tla`, with the invariants
  the eight passes paid for — at minimum: one live claimant; an
  unauthenticated comment may delay recovery, never cause a write and never
  the authorization label; a crashed runner never strands an issue forever
  (bounded-liveness under the declared bounds); recovery never lands on
  `ready` without attestation. The explorer must reproduce the deleted
  degraded mode's oscillation: flip the attestation assumption off and at
  least one invariant must fail with a trace — the impossibility we
  discovered empirically, demonstrated mechanically.
- **R3 — The planning-stage rule, in the loop's own words.** `commands/run.md`
  (and the interview, where a spec is born) gains the rule: a piece whose
  acceptance criteria are protocol invariants ships under C3, and its Task
  Spec names the model file, the explorer test, and the invariant list. The
  wording is load-bearing; the CLI inherits it by loading the file (C3 of
  the CLI spec — no restatement).
- **R4 — The drift gate (C4) as a standing test**, wired like the other
  gates: it discovers model/explorer pairs by convention (`docs/models/*.tla`
  ↔ a test naming the same protocol) and fails on name drift either way.
- **R5 — `distributed-rounds-spec.md` gains one constraint line**: its
  claim/dispatch/TTL protocol ships modeled and explored under this spec
  before implementation begins — replacing any appetite for a Java toolchain
  with the explorer.
- **R6 — Suite green; the explorer's own tests** cover: a seeded bug found
  with a minimal trace, an exhaustion result with a stable state count, the
  ceiling refusing loudly, and the drift gate catching a renamed invariant
  in either direction.

## Non-goals

Running TLC or requiring Java anywhere (the `.tla` stays valid for those who
choose to — portability is the point of the standard notation, not a
dependency); Tamarin/spthy (our attacker fits as explorer actions; crypto
protocol tooling is a research detour); proving the *implementation* correct
(the explorer checks the design; the premise tests and critics keep checking
the code — the C4 names are the bridge, not a proof); modeling
non-protocol pieces (rendering, prose, redaction stay with the disciplines
that already catch their bugs).

## Hard gate for the run that builds this

R2's oscillation demonstration is the acceptance test of the whole idea: if
the explorer cannot mechanically rediscover the eight-pass impossibility from
the model with attestation disabled, the model is decoration and the run has
not met this spec. And one honesty check on the harness itself: seed the
explorer with a known-broken variant of its own cycle detection and show the
suite catches it — the checker gets checked.
