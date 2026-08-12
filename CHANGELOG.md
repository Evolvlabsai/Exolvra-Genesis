# Changelog

## 0.5.0 — 2026-08-11

- Critics no longer silently degrade when they cannot perceive the bar: if
  the bar demands rendering, screenshots, or measurement the session has no
  tools for, the critic reports BLOCKED naming the missing capability instead
  of judging visual work from its source. README notes that visual bars need
  a browser or screenshot tool available to critics.

## 0.4.0 — 2026-08-11

### Changed

- **Renamed the product to Exolvra Genesis.** This is a break, not an alias:
  the previous names are gone rather than accepted alongside the new ones.
  - Plugin, marketplace entry and slash commands: `/exolvra-genesis:run` and
    `/exolvra-genesis:interview`. Install with
    `/plugin install exolvra-genesis@exolvra-genesis`.
  - CLI package and bin: `exolvra-genesis`, aligned to the repo version — from 0.4.0 on, the plugin manifests, the changelog, and the npm package carry one version, moved together.
  - Run state moved to `.exolvra-genesis/` — `runs.json`, `state.json`,
    `bar/`, `runs/` and `progress.html`. The Stop hook greps the new path;
    state written under the old directory is not read or migrated.
  - Environment variables: `EXOLVRA_GENESIS_PLUGIN_DIR` and
    `EXOLVRA_GENESIS_FORCE_TTY`.
  - Subagents: `exolvra-genesis-builder` and `exolvra-genesis-critic`.
  - User config moved to the `exolvra-genesis` directory in the OS config
    location; answers saved under the old name are not read.
  - `${CLAUDE_PLUGIN_ROOT}` is unchanged — it belongs to Claude Code, as does
    everything else the host or the Claude Agent SDK defines.
- Behaviour is unchanged. This release renames; it adds and removes nothing.

## 0.3.0 — 2026-08-11

- `gauntlet interview` in the CLI (npm package now 0.2.0): runs
  `commands/interview.md` as a terminal conversation — each agent turn on the
  clack rail with a live spinner between turns, each typed answer resuming
  the same session, ending with the exact `gauntlet run` line (quoted and
  `-C`-aware). TTY-only; no `--json`; writes neither `state.json` nor the
  run ledger. Ctrl+C is stage-aware: before the first turn nothing exists
  and it says so; after, "the files written so far are yours to keep."
- The packaged CLI now ships all five plugin files — both command markdowns,
  both agents, and `templates/progress.html` — and resolves
  `${CLAUDE_PLUGIN_ROOT}` in loaded markdown to the plugin directory, so a
  clean install uses the shipped progress template instead of the
  generate-a-fallback path. This closes a plugin↔CLI drift introduced when
  the template landed plugin-side.
- Spec addendum v0.2 (R15, R16, widened C3) recorded in `cli/cli-spec.md`;
  judged under a reduced-scope gauntlet: one blind scoped critic (LOSS,
  seven findings), one batch fix, re-verified per finding to a WIN.

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
