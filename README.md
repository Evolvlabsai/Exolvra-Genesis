# Exolvra Genesis

[![ci](https://github.com/Evolvlabsai/Exolvra-Genesis/actions/workflows/ci.yml/badge.svg)](https://github.com/Evolvlabsai/Exolvra-Genesis/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

*A minimal orchestration loop for Claude Code: builders vs. blind critics,
against a concrete quality bar, until the work actually wins. A small,
self-contained excerpt of [Exolvra OS](https://exolvra.ai).*

![The live progress page mid-run: hard gates, per-piece verdicts, and the round log while the loop chases two consecutive blind wins](docs/progress.png)

*The progress page during a real run: the one that built this repo's own
CLI, judged against `gh` and `@clack/prompts` transcripts.*

## The problem

Coding agents grade their own homework. They report "done" based on their own
narration, stop at "looks good," and never compare their output against
anything real. Exolvra Genesis replaces self-assessment with adversarial
evidence. Every round, a critic with no memory of the build puts the actual
output next to a concrete quality bar, blind, with the labels shuffled. The
loop ends when the assembled work wins that comparison twice in a row, and
not before.

## How it works

1. **Pick the bar.** An artifact or a number, never an adjective: real
   screenshots of the product you're chasing, a benchmark figure, a reference
   document. The bar is captured into `.exolvra-genesis/bar/` and stays frozen
   for the whole run, and your constraints become hard gates checked before
   every comparison. One warning: a visual bar needs a browser or screenshot
   tool available to critics. Without one they report BLOCKED instead of
   guessing at pixels from source code.
2. **Decompose.** The lead splits the goal into the smallest independently
   judgeable pieces and writes a Task Spec for each, then shows you the bar
   and the piece list and waits for "go" (or runs straight through in `auto`
   mode).
3. **Build.** An `exolvra-genesis-builder` subagent implements one spec end to
   end. Its report is treated as a claim, so the lead re-runs the verification
   command itself before anything moves forward.
4. **Judge.** A fresh `exolvra-genesis-critic` sees only the bar and the real
   output. WIN or LOSS, the single biggest gap, and the evidence. A tie is a
   LOSS.
5. **Loop.** Gaps go back to builders with a fresh critic each round. A gap
   that survives two rounds forces a change of approach, and whole-artifact
   rounds with regression checks keep the pieces honest together.

A live progress page (`.exolvra-genesis/progress.html`) shows the round log,
per-piece status, the latest side-by-side, and verdict history while it runs,
with per-round snapshots under `.exolvra-genesis/runs/`. The page is rendered
from a template shipped with the plugin (the lead only ever swaps out one JSON
block), so every run on every machine gets the same card.

## Quickstart

```
/plugin marketplace add Evolvlabsai/Exolvra-Genesis
/plugin install exolvra-genesis@exolvra-genesis
/exolvra-genesis:run Build a landing page indistinguishable from <your reference>
```

Exolvra Genesis shows you the bar and the piece list, then waits. Reply `go`
to start the loop. Add `.exolvra-genesis/` to your project's `.gitignore`.

## Running from a spec

Pass a path instead of a goal:

```
/exolvra-genesis:run specs/checkout-flow.md
```

The spec becomes the source of truth. It supplies the goal, the constraints
(which become hard gates), and the acceptance criteria, and it is read-only
for the run. Pieces are derived from its requirements, the assembled result
fails automatically if any requirement is left unmet, and the final report
maps each one to the evidence that satisfies it. The bar still applies: the
spec tells the critics what must be true, the bar tells them what good looks
like.

## No spec yet? Interview

`/exolvra-genesis:interview` turns an idea into a run-ready spec by asking one
question at a time (what it is, the stack, must-haves, hard gates, non-goals,
references), then builds a single-file interactive HTML mockup and iterates
on it with you in the browser. The approved mockup lands in the spec's
references as the primary visual bar candidate, and the command finishes by
printing the exact `/exolvra-genesis:run` line to fire. Point it at an
existing spec and it modifies the pair instead of starting over.

## Headless & CI

Prefix the arguments with `auto` and Exolvra Genesis won't pause for bar
approval; it prints the bar and the piece list, then keeps going. Combined
with Claude Code's headless mode, a full run is one line from any shell,
script, or CI job:

```
claude -p "/exolvra-genesis:run auto specs/checkout-flow.md" \
  --permission-mode acceptEdits --max-turns 80
```

Add `--output-format stream-json` for machine-readable events, and treat
`--max-turns` as your cost guard, since it stops the run at the cap instead
of looping forever. Prefer to approve the bar even when headless? Run without
`auto`, capture the session id from `--output-format json`, review the
printed bar, then continue with `claude -p --resume <session-id> "go"`. To
embed the same loop inside your own tools, the Claude Agent SDK runs this
exact harness as a TypeScript or Python library. The CLI below is exactly
that, shipped.

## The CLI

`cli/` holds `exolvra-genesis`, a thin TypeScript CLI on the Claude Agent SDK
that runs the loop without opening Claude Code. It is transport and
ergonomics only: the plugin markdown stays the single source of truth. The
CLI loads `commands/run.md` and both agent files from the installed package
at runtime (`EXOLVRA_GENESIS_PLUGIN_DIR` or `--plugin-dir` override the
location), so the two cannot drift.

Not yet on npm; build it from the repo:

```
cd cli && npm install && npm run build && npm link
```

Five commands:

- `exolvra-genesis interview [spec-or-idea]` runs the same interview in the
  terminal. Each question renders in the frame, your typed answer resumes the
  session, and the handoff prints the exact `exolvra-genesis run` line to
  fire (with `-C` when you ran it somewhere else). TTY-only, and it touches
  no run state.
- `exolvra-genesis run <goal-or-spec-path>` is the full loop. On a terminal
  with nothing else to go on, it asks for the goal, the models, and auto vs
  review, and your answers persist as the next run's defaults (`--no-config`
  ignores them). `--auto` skips the approval pause, `--max-rounds N` and
  `--max-cost USD` stop a run cleanly so it can be resumed, `--json` emits
  NDJSON ending in a `{status, rounds, cost_usd, session_id}` summary for CI,
  and `--open` opens the live progress page.
- `exolvra-genesis plan <goal-or-spec-path>` runs Steps 0 through 2 and
  stops: it prints the bar and the task specs, a cheap preview of how a run
  would decompose.
- `exolvra-genesis runs` lists recent runs: id, when, input, status, last
  verdict.
- `exolvra-genesis resume [id]` continues a run in the session it started in.
  Bare `resume` offers a picker of unfinished runs.

`--model` pins the lead by exact model id. `--builder-model` and
`--critic-model` take a model *family* (`opus`, `sonnet`, `haiku`, or
`inherit`), because the SDK pins subagents to a family rather than a version,
and the CLI's help says so rather than pretending otherwise. Exit codes are a
contract: **0** the run met its win condition, **1** it lost, was blocked, or
was stopped by a budget guard, **2** the invocation itself has to change.
`exolvra-genesis help exit-codes` and `exolvra-genesis help environment`
cover the rest. There is no flag table in this README because `--help` makes
one unnecessary.

## The two contracts

Everything rides on two small formats.

**Task Spec (lead → builder):** goal · acceptance criteria · files owned
(disjoint per parallel builder) · verification command · bar reference and
gates.

**Report (builder → lead):** files changed · commands run · verbatim
verification output. Nothing else. A report the lead can't reproduce by
re-running the verification command is a LOSS.

## Choosing models

Both agents ship with `model: inherit`, so they run on whatever your session
runs on and the plugin works on any plan at any budget. To split roles, pin
models in the agent frontmatter:

```yaml
# agents/builder.md
model: claude-opus-4-8   # strong implementer
```

A recipe that has worked well: run the session (the lead) on your strongest
model, since orchestration is judgment-heavy but token-light; pin builders to
a strong implementation model, where the token volume actually goes; leave
critics on `inherit`.

## Optional: the gates

Two hook examples turn the loop's conventions into mechanisms. Copy either
`hooks` block into your project's `.claude/settings.json` to enable it; both
are off by default and nothing depends on them.

- `hooks/verification-gate.example.json` is a Stop hook that refuses to let a
  session end while `.exolvra-genesis/state.json` still says `running`. That
  turns the win condition from a convention into a mechanism.
- `hooks/bar-integrity-gate.example.json` is a PreToolUse hook that re-checks
  the bar's sha256 pins (written to `.exolvra-genesis/bar/bar.sha256` at
  capture) before every subagent dispatch. If the bar drifted or was tampered
  with, no builder or critic gets sent until it is restored.

## What it is not

- **Not a framework.** The plugin is two agents, two commands, and one page
  template: plain Markdown with no config file, no state database, and no
  required MCP servers, small enough to read in minutes. The CLI is a
  companion rather than a wrapper. It loads that same Markdown instead of
  reimplementing the loop, and if the two could ever drift, the design is
  wrong.
- **Not a CI system.** It runs inside a Claude Code session and ends when the
  work wins. Your CI still owns the repo.
- **Not a prompt library.** There is exactly one loop, and what you customize
  per task is the bar, not the prompt.

## Part of Exolvra

Exolvra Genesis is a small piece of a much bigger machine: the genesis phase
of **Exolvra OS**, distilled. The interview, the spec, a mockup you approve
by using it, and a build loop that only ends when the work beats a bar nobody
graded on trust.

[Exolvra OS](https://exolvra.ai) applies the same discipline to the whole
life of an application. Specs are approved at doors and recorded immutably,
human decisions are enforced by the platform instead of promised by a prompt,
and the loop you just read about keeps going after genesis, through delivery,
release, and operations, with an audit trail behind all of it.

[Exolvra](https://exolvra.ai) is the workplace those agents do it in, the
right software for your agents: a project board where work gets assigned,
real tools to do it with, and reviews before anything ships, rather than
another chat window.

If evidence over claims is a philosophy you want more of, the full platform
is the same idea grown up. **[Join the waitlist](https://exolvra.ai)**

## Credits

The pattern originates with Matt Shumer's Claude-of-Duty experiment. Exolvra
Genesis generalizes it (quality-bar rules, blind shuffled judging,
anti-simulation gates, the two handoff contracts) while trying to keep the
original's minimal spirit.

## License

[MIT](LICENSE)
