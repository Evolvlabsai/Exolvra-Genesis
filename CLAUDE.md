# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

Exolvra Genesis is a Claude Code plugin. There is no build, lint, or test tooling — the product is Markdown: one slash command and two subagent definitions that implement an adversarial orchestration loop (builder subagents iterate against blind, fresh-context critics comparing real output to a concrete quality bar, until the assembled work wins twice in a row). Editing this repo means editing prompt/contract text, and the wording is load-bearing.

## Exercising changes

There are no build/test commands. To test edits, install the plugin locally and run it:

```
/plugin marketplace add <path-to-this-repo>
/plugin install exolvra-genesis@exolvra-genesis
/exolvra-genesis:run <goal or path to spec file>
```

Prefix the arguments with `auto` to skip the bar-approval pause. Headless run:

```
claude -p "/exolvra-genesis:run auto specs/foo.md" --permission-mode acceptEdits --max-turns 80
```

## Architecture

The entire loop is defined in three Markdown files; everything else supports them:

- `commands/run.md` — the lead agent (`/exolvra-genesis:run`). Owns orchestration only: captures the bar into `.exolvra-genesis/bar/` (immutable per run), decomposes the goal (or a spec file) into Task Specs, fans out builders, re-runs their verification commands itself, dispatches fresh critics with shuffled A/B labels, and enforces the win condition (two consecutive blind wins). The lead never writes implementation code.
- `agents/builder.md` (`exolvra-genesis-builder`) — implements exactly one Task Spec end to end. Touches only its owned files; no stubs, no faked evidence. Reports only FILES CHANGED / COMMANDS RUN / VERIFICATION (verbatim output).
- `agents/critic.md` (`exolvra-genesis-critic`) — blind judge. Sees only the bar and the real output, never builder code or prior rounds. Reports only VERDICT (WIN/LOSS) / GAP (single biggest, one sentence) / EVIDENCE. A tie is a LOSS.

Two contracts tie the files together and must stay consistent across all three when edited:

- **Task Spec** (lead → builder): goal · covers (spec runs) · acceptance criteria · files owned (disjoint per parallel builder) · verification command · bar reference and hard gates.
- **Report** (builder → lead): files changed · commands run · verbatim verification output — nothing else.

Run state lives under `.exolvra-genesis/` in the *target* project (gitignored here and recommended to users): `bar/` captures, `state.json` (`{"status": "running" | "complete" | "stopped"}`), `progress.html` (self-contained live dashboard), `runs/` (per-round snapshots).

Supporting files:

- `hooks/verification-gate.example.json` — opt-in Stop hook that blocks session end while `state.json` says `running`. Users copy its `hooks` block into their settings; nothing in the plugin depends on it. Its grep patterns must match exactly how `run.md` writes `state.json`.
- `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` — manifests. The version appears in both plus `CHANGELOG.md`; bump all three together. Repo URLs point at `Evolvlabsai/Exolvra-Genesis` (manifests, README quickstart, and `MANUAL_URL` in `cli/src/usage.ts`).
- `cli/cli-spec.md` — spec for a future `exolvra-genesis` CLI (not yet implemented). Its hard constraint C3 is the key invariant: the CLI loads `commands/run.md` and the agent files rather than reimplementing the loop — the Markdown stays the single source of truth. Other gates: TypeScript strict / Node >= 18, runtime deps limited to `@anthropic-ai/claude-agent-sdk` plus at most one prompt library, exit codes 0 = win / 1 = loss, blocked, or budget-stopped / 2 = usage error.

## Design invariants

- The bar is an artifact or a number, never an adjective; captured locally and immutable for the run. User constraints and spec requirements are hard gates — any gate failure is an automatic LOSS.
- Evidence over claims: a builder report is a claim until the lead reproduces its verification output; critics reject anything simulated (self-reported success, mocks, hard-coded results).
- Spec files passed to `/exolvra-genesis:run` are read-only for the run; full requirement coverage is a hard gate for the assembled result.
- Minimalism is a stated feature ("Not a framework"): no config file, no state database, no required MCP servers. Resist additions that turn the plugin into a framework.
- Both agents ship with `model: inherit` so the plugin works on any plan; model pinning is a user-side customization documented in the README.
