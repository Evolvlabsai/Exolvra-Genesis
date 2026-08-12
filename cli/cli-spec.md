# Exolvra Genesis CLI — Specification v0.1

A thin TypeScript CLI (`exolvra-genesis`) that runs the Exolvra Genesis loop interactively
or headlessly without opening Claude Code, built on the Claude Agent SDK. The
plugin's markdown (command + agents) stays the single source of truth; the
CLI is transport and ergonomics only.

## Constraints (hard gates)

- C1. TypeScript, strict mode, Node >= 18. Lives in `cli/` in this repo and
  publishes one npm package exposing a `exolvra-genesis` bin.
- C2. Runtime dependencies: `@anthropic-ai/claude-agent-sdk` plus at most one
  terminal-prompt library. Nothing else.
- C3. The loop logic is never reimplemented. The CLI loads
  `commands/run.md`, `agents/builder.md`, and `agents/critic.md` from the
  installed package (`EXOLVRA_GENESIS_PLUGIN_DIR` overrides the location). If CLI
  behavior and plugin behavior can drift, the design is wrong.
- C4. No telemetry; no network calls beyond the SDK's own.
- C5. Exit codes: 0 = win condition met; 1 = loss, blocked, or
  budget-stopped; 2 = usage or configuration error.

## Requirements

- R1. `exolvra-genesis run <goal-or-spec-path>` starts a run. A path to an existing
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
  `.exolvra-genesis/runs.json`. `exolvra-genesis resume [id]` continues that session via
  the SDK's session resume; bare `exolvra-genesis resume` offers an interactive
  picker of recent unfinished runs.
- R7. Ctrl+C marks the run `stopped` in both `runs.json` and `state.json`
  and prints the exact resume command before exiting.
- R8. `exolvra-genesis runs` lists recent runs: id, when, input, status, last
  verdict.
- R9. `exolvra-genesis plan <goal-or-spec-path>` executes Steps 0–2 only, prints
  the bar and the task specs, and exits 0 — a cheap decomposition preview.
- R10. Budget guards: `--max-rounds N` and `--max-cost USD` stop the run
  cleanly (status `stopped`, resumable) when exceeded, using the SDK's
  per-message cost reporting.
- R11. `--json` emits NDJSON events instead of human output; the final line
  is a summary object `{status, rounds, cost_usd, session_id}` for CI to
  parse.
- R12. `--open` opens `.exolvra-genesis/progress.html` in the default browser at
  start; the path prints at start either way.
- R13. Interactive choices persist to a user config file and become the next
  run's defaults; `--no-config` ignores it.
- R14. `exolvra-genesis --help` and per-command help are complete enough that the
  README needs no flag table.

## Non-goals

- No provider abstraction. Codex users point its non-interactive exec mode
  at the same markdown files.
- No TUI dashboard — `.exolvra-genesis/progress.html` is the dashboard.
- No daemon, watch mode, or queue.

## References (bar candidates)

- The interactive UX of `@clack/prompts` example CLIs — perceivable: run
  them and screenshot terminal output side by side.
- `gh` CLI help and output structure, as the bar for R14.

## Addendum v0.2 — interview

- C3 (widened). The CLI loads every plugin file it uses from the installed
  package — `commands/run.md`, `commands/interview.md`, `agents/builder.md`,
  `agents/critic.md`, `templates/progress.html` — never reimplementing or
  restating any of them. `${CLAUDE_PLUGIN_ROOT}` inside the markdown resolves
  to the directory the CLI loaded the plugin from, so the template copy in
  `run.md` works identically under the plugin and the CLI.
- R15. `exolvra-genesis interview [spec-path-or-idea]` runs `commands/interview.md`
  as a conversation: each agent turn renders in the terminal, the user's
  typed answer resumes the same session, repeating until the markdown's
  handoff. It is TTY-only (exit 2 with a plain reason otherwise), has no
  `--json`, and touches neither `state.json` nor the run ledger — an
  interview is not a run. On handoff the CLI prints the exact
  `exolvra-genesis run specs/<slug>.md` line (the CLI-native translation of the
  markdown's `/exolvra-genesis:run` handoff).
- R16. The packaged CLI ships every file in the widened C3 list; from a clean
  tarball install, `run` uses the shipped progress template rather than the
  generate-a-fallback path, and `interview` works end to end.

## Addendum v0.3 — rename

The product is **Exolvra Genesis**. The rename is a break, not an alias: the
old names are gone rather than accepted alongside the new ones.

- The published package and its bin are `exolvra-genesis`; the plugin, the
  marketplace entry, and the slash commands (`/exolvra-genesis:run`,
  `/exolvra-genesis:interview`) carry the same name.
- Run state lives under `.exolvra-genesis/` — `runs.json`, `state.json`,
  `bar/`, `runs/`, `progress.html` — and the Stop hook greps that path.
- The environment variables are `EXOLVRA_GENESIS_PLUGIN_DIR` and
  `EXOLVRA_GENESIS_FORCE_TTY`, and `exolvra-genesis help environment`
  documents them under those names.
- The subagents are `exolvra-genesis-builder` and `exolvra-genesis-critic`,
  and the transport markers the CLI reads off the stream are
  `@exolvra-genesis …`.
- `${CLAUDE_PLUGIN_ROOT}` is unchanged: it belongs to Claude Code, not to this
  product, as does everything else the host or the SDK defines.

Nothing above changes behaviour. Every requirement and constraint in this
document holds as written, read under the new names.
