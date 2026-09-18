# First Contact — spec

Status: draft, 2026-08-18. Origin: the first standalone-CLI runs on a real
machine, which surfaced three papercuts in one night — each too small for its
own run, all one theme: the distance between installing the tool and a first
successful loop. Batch precedent: 0.7.0's backlog clearing. Independent of
every other draft spec; small enough to run any time.

## Why

Three true stories from one user's first day. A `plan` printed a raw
`API Error: 404` inside its ANSWER block because the saved Claude default
model was not servable through the SDK path — the reader got a stack of JSON
where the house owes a sentence. A `run` spent 25 minutes and two dollars
capturing a bar and decomposing before discovering that the default permission
mode cannot execute a single command headlessly — the lead blocked honestly,
but the wall was findable in the first ten seconds. And nothing in the help or
README said the sentence that would have prevented both: what a real
unattended build needs. First contact is when trust is cheapest to win and
easiest to lose; every failure here must land as a short, house-shaped
sentence naming its remedy.

## Constraints

- **C1 — The default is capability, chosen by the owner (2026-08-18).**
  `run` and `resume` default to `bypassPermissions`: an unattended build
  executes the verification commands it was given, and a default that cannot
  finish a loop headlessly punished every first contact. The flag is the
  restriction — `acceptEdits` and `default` remain for cautious operators —
  and `plan` keeps the cautious default because it executes nothing. (This
  reverses this spec's original constraint after field pain; the 0.8.2
  changelog records the incident. The preflight below remains for restricted
  modes chosen explicitly.)
- **C2 — Preflight is cheap and honest.** The execution preflight costs one
  no-op command through the real session — no model tokens spent probing, no
  fake success, and its result is stated, not inferred. A preflight pass is
  never cited as evidence about anything but execution.
- **C3 — Every failure this spec touches renders in the house error shape**
  (complaint, indented detail, usage line where retyping helps) and exits 2 —
  these are all invocation problems by definition. No raw API error, no JSON,
  no stack ever reaches a reader on these paths.
- **C4 — Asking is TTY-only.** On a terminal, the preflight failure may
  become one clack question offering to continue with `bypassPermissions`
  (the answer is used once, never persisted silently). Headless, the same
  condition is a refusal naming the flag. No prompt ever blocks a headless
  run.
- **C5 — No new runtime dependencies; the loop untouched** (G3, C3 of the
  CLI spec). Everything here lives at the command layer, before or around
  the session — never inside the loop's markdown.

## Requirements

- **R1 — Execution preflight.** `run` and `resume` (and `work`, which
  inherits the same session machinery) verify, before the lead spawns and
  before any spend, that the session can execute a command under the
  effective permission mode. Denied + the input requires verification (every
  spec and goal does) → TTY: the C4 question; headless: exit 2 naming
  `--permission-mode bypassPermissions` and why. `plan` needs no execution
  and must not preflight.
- **R2 — Model resolution errors in the house shape.** A model that the SDK
  path cannot serve — the inherit default included — produces: what was
  asked for, where it came from ("your saved Claude default", the flag, the
  env), and the remedy (`--model <id>`, the known-good ids). Pinned for
  `run`, `plan`, `interview`, and `work`, with the raw API text demoted to
  an indented detail line, never the headline.
- **R3 — The sentence in the docs.** `run --help` and the README's CLI
  section each state, in one plain sentence, that an unattended build
  executes commands and therefore wants `--permission-mode
  bypassPermissions`, and that the first refusal will say so. `help
  exit-codes` already promises 2 means "the invocation must change" — these
  two failures are listed there as examples.
- **R4** The preflight result is recorded in the run's round log (and trace,
  once it exists): mode, probed capability, and outcome — so a later "why
  did this refuse" has its evidence.
- **R5** Full suite green; the packaged-install smoke exercises R1's
  headless refusal and R2's message for an unservable model as real
  processes; version bump per the one-version rule; CHANGELOG names the
  three papercuts closed.

## Non-goals

Changing the default permission mode (C1); persisting a permission choice
across runs (a security decision is made per invocation); probing model
availability at startup (R2 shapes the failure when it happens — a network
round-trip per launch to pre-check models is not worth the latency); any
change to the plugin flow, which runs inside Claude Code's own permission
system.

## Hard gate for the run that builds this

The three original failures, replayed as fixtures: the museum-free stale-404
(`plan` under an unservable inherit), the 25-minute wall (a `run` whose
session denies execution — must refuse before any bar capture, asserted by
zero files written and zero model spend), and a TTY run answering the C4
question both ways. Each must land in the exact house shape, byte-asserted.


## Implementation amendment, 2026-09-17

The owner approved: "Allow a small model-backed permission probe before the
build." This supersedes C2's no-model-token restriction and R1's before-any-spend
wording. The installed Claude Agent SDK 0.1.77 has no public execute-tool control
request: `Query` and the control protocol expose session configuration and MCP
management, but no zero-token Bash execution. A local shell command would not
exercise SDK session permissions.

The implementation therefore runs a separate, bounded SDK query before the lead
build, under the effective model, environment, project settings and permission
mode. It exposes only Bash and a hook restricts execution to one exact harmless
command. A matching tool result containing a fresh marker is required; model
prose or configuration alone never passes. Across a possible one-time TTY bypass
retry, the requested provider budget totals at most $0.10 (or the smaller remaining
run budget). Actual cost and token usage are returned for budget accounting and
recorded with mode, capability and outcome. A stopped or inconclusive probe
refuses the build. Headless failures never prompt. `plan` has no probe.

The hard gate's zero-model-spend assertion now means zero **build** spend before
permission is demonstrated; bounded probe spend is expected and must be visible.

Ceiling correction, 2026-09-18: the first real Opus 5 probe reported
$0.156694 for 3 input and 113 output tokens — the cache write of the session's
system prompt dominates — and the SDK stopped it at the $0.10 budget before the
command ran, so every run on an Opus lead was refused. The requested probe
budget is now at most $0.50 (or the smaller remaining run budget). The second
real probe executed the command and returned the marker, then the SDK ended
the session on its two-turn limit before the model's closing sentence, and the
implementation refused it. The matching tool result is the evidence the
amendment requires, so a verified marker now passes regardless of how the
session ended, unless it was interrupted; the probe allows four turns.
Everything else in this amendment stands.
