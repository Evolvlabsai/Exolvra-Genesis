# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

Exolvra Genesis is an adversarial orchestration loop for Claude Code — builder subagents iterate against blind, fresh-context critics comparing real output to a concrete quality bar, until the assembled work wins twice in a row. It ships two ways from one source of truth:

- **The plugin** (`commands/`, `agents/`, `templates/`, `hooks/`): plain Markdown plus one HTML template. The wording is load-bearing — editing these files is editing behavior.
- **The CLI** (`cli/`): a TypeScript package exposing an `exolvra-genesis` bin that runs the same loop without opening Claude Code. It is transport and ergonomics only; it loads the plugin files at runtime and never restates them. The CLI was built by its own loop (24 judged rounds against `cli/cli-spec.md`, ending on two consecutive blind critic WINs).

## Commands

Plugin (no build tooling — test by installing and running):

```
/plugin marketplace add <path-to-this-repo>
/plugin install exolvra-genesis@exolvra-genesis
/exolvra-genesis:run <goal or spec path>        # prefix args with `auto` to skip the approval pause
/exolvra-genesis:interview [spec or idea]       # produces a run-ready spec + HTML mockup
```

CLI (from `cli/`):

```
npm install && npm run build      # build also copies the plugin files into dist/plugin
npm run typecheck                 # tsc --noEmit
npm test                          # node --test, 677 tests; the packaging test is slow (~150s)
node --test test/<file>.test.js   # one suite, no rebuild
```

The full suite is the gate for any CLI change. One known flake: a usage test can time out while the packaging test saturates the machine; it passes in isolation and on rerun.

## Architecture

The loop lives entirely in the plugin Markdown:

- `commands/run.md` — the lead agent. Captures the bar into `.exolvra-genesis/bar/` (pinned twice: `BAR.md` for people, `bar.sha256` for the integrity hook; immutable per run), decomposes into Task Specs, fans out builders, re-runs their verification itself, dispatches fresh critics with shuffled labels, maintains the progress page from `templates/progress.html`, and enforces the win condition.
- `commands/interview.md` — one-question-at-a-time interview producing a spec plus a single-file interactive mockup. A conversation, not a build; no subagents.
- `agents/builder.md` (`exolvra-genesis-builder`) — implements exactly one Task Spec; touches only owned files; reports only FILES CHANGED / COMMANDS RUN / VERIFICATION (verbatim).
- `agents/critic.md` (`exolvra-genesis-critic`) — blind judge; sees only the bar and the real output. VERDICT (WIN/LOSS, or BLOCKED only for a missing perception capability — e.g. a visual bar with no browser/screenshot tool) / GAP / EVIDENCE. A tie is a LOSS.

Two contracts tie the files together and must stay consistent across all of them when edited: the **Task Spec** (lead → builder: goal · covers · acceptance criteria · files owned, disjoint per parallel builder · verification command · bar reference and hard gates) and the **Report** (builder → lead: files changed · commands run · verbatim verification output, nothing else).

The CLI (`cli/src/`) mirrors the plugin without duplicating it:

- `plugin-dir.ts` — resolves and loads the five plugin files (`PLUGIN_FILES`) from `EXOLVRA_GENESIS_PLUGIN_DIR`, the installed package (`dist/plugin/`, populated by `build:plugin`), or the repo; substitutes `${CLAUDE_PLUGIN_ROOT}` with the resolved directory. **Never rename `${CLAUDE_PLUGIN_ROOT}`** — it belongs to Claude Code.
- `session.ts` — the only SDK boundary; tests substitute a fake transport here and nowhere else (the one permitted simulation).
- `registry.ts` — commands self-register from `src/commands/` (zero-diff `cli.ts`); every value-taking flag must declare a validator or the registry-driven gate test fails it. Nothing reaches the SDK or filesystem unvalidated, and the agent's answer is validated too (never exit 0 having written nothing).
- `commands/` — `run` (interactive clack startup on TTY, review pause, budget guards, SIGINT settling, `--json` NDJSON with a fixed 4-key summary), `plan` (Steps 0–2 preview), `runs`/`resume` (lock-serialized ledger in `.exolvra-genesis/runs.json`), `interview` (multi-turn conversation loop), `standards` (check/init for the repo's standing bar in `.exolvra-genesis/standards.md` — committed, unlike run state), `goals` (list/show/new for reusable jobs in `.exolvra-genesis/goals/`, resolvable by bare name in `run`/`plan`).
- Rendering: display-width-aware tables (CJK/emoji/ZWJ correct), TSV when piped vs aligned on TTY, model output treated as untrusted renderer input, `--verbose` byte-verbatim. Lead model is pinned by exact id; builder/critic by model *family* — an SDK constraint, stated honestly in help.

Run state lives under `.exolvra-genesis/` in the *target* project (gitignored): `bar/`, `state.json` (`{"status": "running" | "complete" | "stopped" | "blocked"}`), `progress.html`, `runs/`, `runs.json` (CLI ledger). Every exit path settles `state.json` and the ledger truthfully — a run that never started must not say `running`.

Supporting files:

- `hooks/verification-gate.example.json` — opt-in Stop hook; blocks session end while `state.json` says `running`. Its grep must match how `run.md` writes the file.
- `hooks/bar-integrity-gate.example.json` — opt-in PreToolUse(Task) hook; blocks subagent dispatch if `bar/bar.sha256` no longer verifies.
- `cli/cli-spec.md` — the spec the CLI was built and judged against (C1–C5, R1–R16 across its addenda). Treat as read-only history; extend with addenda rather than rewriting.

## Versioning

One version everywhere, moved together: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` (two fields), `CHANGELOG.md`, and `cli/package.json`. Repo URLs point at `Evolvlabsai/Exolvra-Genesis`; the manual/issues links live in `MANUAL_URL` in `cli/src/usage.ts`.

## Design invariants

- The bar is an artifact or a number, never an adjective; captured locally, hash-pinned, immutable for the run. User constraints and spec requirements are hard gates — any gate failure is an automatic LOSS.
- Evidence over claims: a builder report is a claim until the lead reproduces its verification output; critics reject anything simulated; the SDK behind `session.ts` is the only thing tests may fake.
- C3, the CLI's key invariant: the loop is never reimplemented — if CLI and plugin behavior could drift, the design is wrong. Exit codes are a contract: 0 win, 1 loss/blocked/budget-stopped, 2 usage or configuration error (and a win outranks every guard, interrupt, and fault).
- Spec files passed to a run are read-only for the run; full requirement coverage is a hard gate for the assembled result.
- Minimalism is a stated feature ("Not a framework"): no state database, no required MCP servers; runtime deps are the Agent SDK plus `@clack/prompts`, nothing else. Resist additions that turn this into a framework.
- Both agents ship `model: inherit`; model pinning is a user-side choice.

## Working style learned from the build

- Critics report **all** substantiated findings ranked (batched), not one per round; builders fix batches. Reduced critic scope is fine for mechanical changes — lead verification (suite + grep sweep + packed-install smoke) suffices for renames and housekeeping.
- Windows dev environment: watch Bash cwd drift between tool calls (`cd` persists); prefer absolute `cd` first. Avoid regex-based multi-line edits on source files — two incidents of spliced/deleted code came from them; use plain-text edits.
