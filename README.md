# Gauntlet

*A minimal orchestration loop for Claude Code: builders vs. blind critics,
against a concrete quality bar, until the work actually wins.*

<!-- TODO: record .gauntlet/progress.html evolving over a run and drop the GIF here -->
<!-- ![Gauntlet progress page](docs/progress.gif) -->

## The problem

Coding agents grade their own homework. They report "done" based on their own
narration, stop at "looks good," and never compare their output against
anything real. Gauntlet replaces self-assessment with adversarial evidence:
every round, a fresh-context critic puts the actual output side by side with a
concrete quality bar — blind, labels shuffled — and the loop doesn't end until
the assembled work wins that comparison twice in a row.

## How it works

1. **Pick the bar.** An artifact or a number, never an adjective — real
   screenshots of the product you're chasing, a benchmark figure, a reference
   document. Captured locally into `.gauntlet/bar/`, immutable for the run.
   User constraints become hard gates checked before every comparison.
2. **Decompose.** The lead splits the goal into the smallest independently
   judgeable pieces and writes a Task Spec for each, then shows you the bar
   and the piece list and waits for "go" (or runs straight through in `auto`
   mode).
3. **Build.** A `gauntlet-builder` subagent implements one spec end to end.
   Its report is a claim — the lead re-runs the verification command itself
   before anything proceeds.
4. **Judge.** A fresh `gauntlet-critic` sees only the bar and the real output.
   WIN or LOSS, the single biggest gap, and the evidence. A tie is a LOSS.
5. **Loop.** Gaps go back to builders with a fresh critic each round. A gap
   that survives two rounds forces a change of approach. Whole-artifact rounds
   and regression checks keep the pieces honest together.

A live progress page (`.gauntlet/progress.html`) shows the round log,
per-piece status, the latest side-by-side, and verdict history while it runs,
with per-round snapshots under `.gauntlet/runs/`.

## Quickstart

```
/plugin marketplace add YOUR-GITHUB-USERNAME/gauntlet
/plugin install gauntlet@gauntlet
/gauntlet:run Build a landing page indistinguishable from <your reference>
```

Gauntlet shows you the bar and the piece list, then waits. Reply `go` to start
the loop. Add `.gauntlet/` to your project's `.gitignore`.

## Running from a spec

Pass a path instead of a goal:

```
/gauntlet:run specs/checkout-flow.md
```

The spec becomes the source of truth — it supplies the goal, the constraints
(as hard gates), and the acceptance criteria, and it's read-only for the run.
Pieces are derived from its requirements, full requirement coverage is a hard
gate for the assembled result, and the final report maps every requirement to
the evidence that satisfies it. The bar still applies: the spec tells the
critics what must be true; the bar tells them what good looks like.

## Headless & CI

Prefix the arguments with `auto` and Gauntlet won't pause for bar approval —
it prints the bar and the piece list, then keeps going. Combined with Claude
Code's headless mode, a full run is one line from any shell, script, or CI
job:

```
claude -p "/gauntlet:run auto specs/checkout-flow.md" \
  --permission-mode acceptEdits --max-turns 80
```

Add `--output-format stream-json` for machine-readable events, and treat
`--max-turns` as your cost guard — it stops the run at the cap instead of
looping forever. Prefer to approve the bar even when headless? Run without
`auto`, capture the session id from `--output-format json`, review the
printed bar, then continue with `claude -p --resume <session-id> "go"`. To
embed the same loop inside your own tools, the Claude Agent SDK runs this
exact harness as a TypeScript or Python library.

## The two contracts

Everything rides on two small formats.

**Task Spec (lead → builder):** goal · acceptance criteria · files owned
(disjoint per parallel builder) · verification command · bar reference and
gates.

**Report (builder → lead):** files changed · commands run · verbatim
verification output. Nothing else. A report the lead can't reproduce by
re-running the verification command is a LOSS.

## Choosing models

Both agents ship with `model: inherit` — they run on whatever your session
runs on, so the plugin works on any plan at any budget. To split roles, pin
models in the agent frontmatter:

```yaml
# agents/builder.md
model: claude-opus-4-8   # strong implementer
```

A common recipe: run the session (the lead) on your strongest model, since
orchestration is judgment-heavy but token-light; pin builders to a strong
implementation model, where the token volume actually goes; leave critics on
`inherit`.

## Optional: the Stop gate

`hooks/verification-gate.example.json` contains a Stop hook that refuses to
let a session end while `.gauntlet/state.json` still says `running` — turning
the win condition from a convention into a mechanism. Copy its `hooks` block
into your project's `.claude/settings.json` to enable it. It is off by
default and nothing depends on it.

## What it is not

- **Not a framework.** No config file, no CLI wrapper, no state database, no
  required MCP servers. Two agents, one command, plain Markdown you can read
  in five minutes.
- **Not a CI system.** It runs inside a Claude Code session and ends when the
  work wins; your CI still owns the repo.
- **Not a prompt library.** There is exactly one loop, and the bar — not the
  prompt — is what you customize per task.

## Credits

The pattern originates with Matt Shumer's Claude-of-Duty experiment. Gauntlet
generalizes it — quality-bar rules, blind shuffled judging, anti-simulation
gates, and the two handoff contracts — while keeping the original's minimal
spirit.

## License

[MIT](LICENSE)

<!-- Building something bigger on the same evidence-over-claims philosophy?
     Link it here. -->
