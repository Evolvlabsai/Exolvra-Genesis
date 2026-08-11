# Changelog

## 0.2.0 — 2026-08-11

- The `gauntlet` CLI (`cli/`, npm package at its own 0.1.0): runs the loop
  headlessly or interactively without opening Claude Code, built on the
  Claude Agent SDK. `run` (interactive startup on a TTY, `--auto`,
  `--max-rounds`/`--max-cost` budget guards, `--json` NDJSON with a
  `{status, rounds, cost_usd, session_id}` summary line, `--open`), `plan`
  (Steps 0–2 preview), `runs`, and `resume [id]` with a picker of unfinished
  runs. Exit codes: 0 win, 1 loss/blocked/budget-stopped, 2 usage or
  configuration error.
- The CLI never restates the loop: it loads `commands/run.md`,
  `agents/builder.md`, and `agents/critic.md` from the installed package at
  runtime (`GAUNTLET_PLUGIN_DIR` / `--plugin-dir` override), and ships those
  files inside its package so a clean `npm install` works.
- Lead model pinned by exact id (`--model`); builder and critic pinned by
  model family (`--builder-model`, `--critic-model`) — the SDK's subagent
  contract, stated honestly in help rather than silently approximated.
- Interactive choices persist to a user config and become the next run's
  defaults; `--no-config` ignores it. Run ledger in `.gauntlet/runs.json`
  with locked, atomic writes; `.gauntlet/state.json` stays compatible with
  the optional Stop-gate hook.
- Built and judged by its own loop: the CLI went through a 24-round Gauntlet
  run against `cli/cli-spec.md`, with `gh` and `@clack/prompts` transcripts
  as the bar, ending on two consecutive blind WINs by fresh critics.

## 0.1.0 — 2026-08-10

- Initial release: `/gauntlet:run` command (runs from a one-line goal or an
  existing spec file, with requirement coverage as a hard gate; prefix the
  arguments with `auto` to skip the bar-approval pause for headless runs),
  `gauntlet-builder` and `gauntlet-critic` subagents (`model: inherit`),
  optional Stop verification gate, README.
- `/gauntlet:interview` — one-question-at-a-time interview that produces a
  run-ready spec plus a single-file interactive mockup (or modifies an
  existing pair); the approved mockup becomes a visual bar candidate.
- Shared progress-page template (`templates/progress.html`): the lead copies
  it at run start and updates only its embedded JSON block, so the live card
  is identical across runs and users.
- Integrity pins, required every round: the spec's sha256 re-verified, bar
  artifacts hash-pinned in `.gauntlet/bar/BAR.md`, and critics isolated to
  temp-directory copies with the repo verified untouched after each session —
  all attested in the progress page's `integrity` footer; any failed check is
  an automatic BLOCKED.
