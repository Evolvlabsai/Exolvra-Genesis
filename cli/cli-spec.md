# Gauntlet CLI — Specification v0.1

A thin TypeScript CLI (`gauntlet`) that runs the Gauntlet Loop interactively
or headlessly without opening Claude Code, built on the Claude Agent SDK. The
plugin's markdown (command + agents) stays the single source of truth; the
CLI is transport and ergonomics only.

## Constraints (hard gates)

- C1. TypeScript, strict mode, Node >= 18. Lives in `cli/` in this repo and
  publishes one npm package exposing a `gauntlet` bin.
- C2. Runtime dependencies: `@anthropic-ai/claude-agent-sdk` plus at most one
  terminal-prompt library. Nothing else.
- C3. The loop logic is never reimplemented. The CLI loads
  `commands/run.md`, `agents/builder.md`, and `agents/critic.md` from the
  installed package (`GAUNTLET_PLUGIN_DIR` overrides the location). If CLI
  behavior and plugin behavior can drift, the design is wrong.
- C4. No telemetry; no network calls beyond the SDK's own.
- C5. Exit codes: 0 = win condition met; 1 = loss, blocked, or
  budget-stopped; 2 = usage or configuration error.

## Requirements

- R1. `gauntlet run <goal-or-spec-path>` starts a run. A path to an existing
  file is treated as a spec, exactly as the plugin does.
- R2. In a TTY with flags omitted, startup is interactive: prompt for the
  goal or spec path, then model pickers for lead, builder, and critic
  (current Claude models plus "inherit"), then auto vs. review mode. Non-TTY
  runs never prompt.
- R3. Model flags `--model`, `--builder-model`, and `--critic-model` override
  the pickers and the agents' frontmatter via the SDK's programmatic agent
  definitions. Omitted means inherit.
- R4. Review mode (the TTY default) prints the bar and the piece list and
  waits for confirmation before the loop starts. `--auto`, or any non-TTY
  run, skips the pause.
- R5. Progress streams to the terminal round by round — piece, round number,
  verdict, gap — one line each. `--verbose` streams full agent output.
- R6. Every run records session id, input, models, start time, and status in
  `.gauntlet/runs.json`. `gauntlet resume [id]` continues that session via
  the SDK's session resume; bare `gauntlet resume` offers an interactive
  picker of recent unfinished runs.
- R7. Ctrl+C marks the run `stopped` in both `runs.json` and `state.json`
  and prints the exact resume command before exiting.
- R8. `gauntlet runs` lists recent runs: id, when, input, status, last
  verdict.
- R9. `gauntlet plan <goal-or-spec-path>` executes Steps 0–2 only, prints
  the bar and the task specs, and exits 0 — a cheap decomposition preview.
- R10. Budget guards: `--max-rounds N` and `--max-cost USD` stop the run
  cleanly (status `stopped`, resumable) when exceeded, using the SDK's
  per-message cost reporting.
- R11. `--json` emits NDJSON events instead of human output; the final line
  is a summary object `{status, rounds, cost_usd, session_id}` for CI to
  parse.
- R12. `--open` opens `.gauntlet/progress.html` in the default browser at
  start; the path prints at start either way.
- R13. Interactive choices persist to a user config file and become the next
  run's defaults; `--no-config` ignores it.
- R14. `gauntlet --help` and per-command help are complete enough that the
  README needs no flag table.

## Non-goals

- No provider abstraction. Codex users point its non-interactive exec mode
  at the same markdown files.
- No TUI dashboard — `.gauntlet/progress.html` is the dashboard.
- No daemon, watch mode, or queue.

## References (bar candidates)

- The interactive UX of `@clack/prompts` example CLIs — perceivable: run
  them and screenshot terminal output side by side.
- `gh` CLI help and output structure, as the bar for R14.
