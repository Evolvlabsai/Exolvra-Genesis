# Postmortem — the issue-runner build (v0.8.0)

Written while the run was still hot, so the numbers are exact. The feature:
`work` and `queue`, the GitHub issue runner — five pieces, one spec
(`docs/specs/issue-runner-spec.md`, C1–C12 / R1–R16 plus two addenda), built
by the loop against this repo's own standing gates.

## The score

- **8 blind write-safety passes** over the foundations (network, git, issue
  lifecycle) before the integration command existed: **25 findings**, every
  one with a working reproduction, every fix re-verified by replaying the
  critic's own attack.
- **3 assembled rounds** (so far): **6 → 9 → 4 findings**, severity falling
  each round — from "a stranger's comment can apply the authorization label"
  to "the help page omits a variable".
- Suite grew 677 → 999 tests across the build. One version everywhere; one
  `fetch` site; force-push structurally absent throughout.

## What the findings taught

### 1. Oscillation is a design smell, and it should stop the loop

The single most expensive stretch: the claim path's *degraded identity mode*
(an installation token GitHub refuses to name). Every decision there rested
on status comments any stranger could author, so each fix had two options —
trust the comment (a stranger causes a write) or distrust it (a stranger
strands an issue forever). **Both sides produced gate failures, twice each,
across roughly five rounds.** The critic finally named the pattern itself:
"the matrix is not converging, it is oscillating, because there is no correct
answer available to a decision procedure whose only evidence is forgeable" —
and recommended a spec change instead of a ninth patch. Addendum v0.1.2
(every write requires a resolvable identity) deleted the mode; both open
defect classes disappeared rather than being fixed.

**Rule adopted:** when two consecutive fixes each break a property the other
round established, stop patching and question the design or the spec. A spec
amendment is a legitimate move — record it, re-pin, continue.

### 2. A comment that asserts another function's behaviour is a premise, and premises rot

Four separate rounds were spent on justifying comments that were **true when
written and falsified by a later fix** — e.g. "an issue in a state nobody is
in is recoverable in a day," written before the recovery path narrowed. Tests
never catch this: a stale comment compiles and passes. The fix that ended the
class: a test named *"the premises this module's comments rely on, each as an
assertion"* — every cross-function premise pinned so it fails loudly when the
premise dies. (First version pinned only the cases that could not fail; the
critic caught that too.)

**Rule adopted:** every fix states the invariant it enforces and pins it as a
test beside the branch that depends on it; comments about other code either
get a test or get rewritten to claim only what the local code does.

### 3. Attack the principle, not the patch

The most productive single critic instruction of the run: *"find the next
falsified premise by reading the justifications rather than the code."* It
found two in one pass. Its counterpart on the build side: when handed a
principle ("an unattested comment may never cause a write on its own"), the
builder audited every decision against it and found a defect the critic had
not reported — the only time the fix side got ahead of the attack side.

### 4. Failure paths deserve a fault matrix up front

Assembled rounds 2 and 3 were almost entirely "break the tool mid-pass and
check what it says afterwards": exit codes per fault kind per stage, sticky
comments left lying after a partial failure, a stalled response escaping the
fault vocabulary, two clocks mixed in one printed sentence. All of it was
enumerable on day one as a table — stage × fault kind → exit, state, message.
The eventual fixes were structural (a compiler-checked outcome→exit table;
one PR-body derivation from the merge itself; independent finishing writes),
which is what the table would have demanded from the start.

**Rule adopted:** a Task Spec for anything that talks to another system
includes the fault matrix in its acceptance criteria.

### 5. Findings were valid because the standard was reproduction

Nothing in the 35 findings was taste. The standard held both directions: a
critic claim needed a transcript, and a fix needed the critic's own repro
replayed and refused. The critic also downgraded honestly (marked findings
"marginal", declared one unreachable on real GitHub) — which is what makes a
LOSS verdict trustworthy.

## What it cost, and where the waste was

- **Repeated full-suite runs by builders.** The suite takes 45–350s under
  load; one builder ran it 13 times in one round. Builders only need their
  owned suites while iterating — the lead re-runs the full gate anyway.
- **Torn builds under parallel builders.** Concurrent `npm run build` into one
  `dist/` produced phantom failures (missing exports, half-written files) that
  cost real diagnosis time in at least five rounds. Builds need to be
  staggered, or verification centralized in the lead.
- **One model tier for everything.** Opus on a singular/plural grammar fix is
  waste; Opus on the write-safety critic was the reason the oscillation got
  caught. Right-size per round.
- **Fresh spawns rebuild context.** Resuming a long-lived agent that already
  knows the file beat a fresh spawn by ~50–100k tokens each time; the run kept
  five long-lived builders and one long-lived safety critic for exactly this
  reason. (Assembled critics stay fresh — blindness is the point there.)
- **Session limits killed agents mid-edit twice.** Both times the tree
  survived because verification is external to the agent (suite + pins), and
  the fix was re-dispatching with the measured state. Checkpointing state in
  the progress page made the resume cheap.

## What held

The loop's core claim — evidence over claims — is what caught everything
above before it shipped. The bar and spec pins were verified at every round
(one real drift was caught when a critic's browser tooling wrote into the
repo root; byte-identity checks flagged it and the critic cleaned it up).
Builders' honest self-corrections (the "got" banned-substring collision, the
branch-nesting bug found by probing, refusing to fake what a harness could
not stage) were as load-bearing as the critics' attacks.

## Where the rules went

The durable rules above were folded into the plugin markdown — which *is* the
behavior, for the plugin and the CLI alike (the CLI loads these files at
runtime; C3): `agents/builder.md` (invariant-stating, premise discipline,
scoped verification), `agents/critic.md` (batched ranked findings, attack the
principle), `commands/run.md` (oscillation rule, fault-matrix requirement,
build serialization, batched-findings dispatch).
