# Changelog

## 0.12.0 — 2026-09-18

- Commands the control panel starts are detached processes with their own
  output files and exit receipts. They continue when the dashboard stops, and
  a restarted dashboard adopts them: later output, verified process identity,
  the real exit code, and stop still work. A process gone without a receipt
  is reported as interrupted, never as succeeded.
- Paid commands wait in a persistent queue: one per project at a time, and
  `dashboard --concurrency` sets how many run at once across projects
  (default 1). The queue keeps arrival order across restarts and records each
  command's exact arguments. Queued commands can be cancelled
  (`DELETE /api/jobs/<id>`); running commands are stopped, not cancelled.
- The dashboard lists the commands that continue when it exits. The deployment
  guide and service example describe restarts and upgrades while work runs.
- The execution preflight's probe budget is $0.50 instead of $0.10. On an Opus
  lead the first turn alone costs about $0.16, so the old ceiling refused every
  run before the probe command could execute. A probe whose command returned
  its marker now passes even when the SDK ends the session on its turn limit
  before the model's closing sentence; the probe allows four turns.

## 0.11.0 — 2026-09-17

- Run detail now leads with the recorded outcome, latest activity, blocking
  context and an available next action. Evidence, round history and raw events
  are separate views, with exact source-event links for recorded statements.
- Show observed and builder-reported file changes, verification output, guard
  results and critic findings. Compare recorded file lists and findings between
  rounds of the same piece, without treating an omitted finding as resolved or
  a missing file-list entry as a file deletion. Older or incomplete records
  explicitly show unavailable evidence.
- New run observations retain structured report and command evidence through
  the existing trace redaction boundary. Evidence views never run verification,
  inspect the current working tree as historical proof, or change execution.

## 0.10.0 — 2026-09-17

- `dashboard` serves a Genesis control panel with operations, run history,
  live event streams, project registration, agent definitions, measured usage,
  and command output. Start builds, preview plans, research local decision maps,
  and stop or resume runs through the existing CLI. The dark, compact interface
  supports filters, event pagination, artifact downloads and JSON exports.
- The panel supports local use and authenticated team access with configurable
  listen addresses and a public HTTPS origin. Shared-key login creates bounded
  HttpOnly browser sessions with CSRF protection and independent logout.
  Portable Node, container, proxy and service deployment examples are included.
  The panel persists project registrations and command receipts. It adds no runtime
  dependencies and preserves exact reported session totals without estimating
  unavailable nested agent costs.

## 0.9.0 — 2026-09-17

- Decision charting ships in plugin markdown and the CLI. Editable local maps
  and GitHub-native maps share one ticket contract, with guarded claims,
  authenticated GitHub heartbeats and recovery of expired own-account claims,
  native child/blocking relationships, live human exchanges, and independent
  read-only research sessions. Prototype tickets produce runnable HTML within
  the map and require confirmed human use and feedback before closure.
  Spec, named-goal and ready-issue handoffs are
  validated against repository standards and shown for approval. Charting
  never silently edits standards or .gitignore. The first issue-runner
  dogfood map records source-backed findings and leaves live rollout choices
  explicitly undecided.
- Run artifacts are isolated under `.exolvra-genesis/runs/<run-id>/`; startup,
  interruption, recovery and completion settle state and the ledger together.
  Builders retain bounded session context by piece while critics start fresh.
  File-ownership checks compare real filesystem changes, preserve pre-existing
  user edits, and prevent successful reports after an ownership breach.
  Conservative report/verdict checks surface contradictions and repeated gaps.
- Trace records now support live activity, process liveness and observed model
  spend. `status`, `status --watch`, `stop`, and the existing progress page use
  that evidence, label stale or unavailable data, and expose budget caps and
  stalls, with configurable thresholds by phase and warnings at 80% of cost
  or round caps. Local session costs and distributed round costs use exact
  provider receipts; nested local piece/round dollar splits are unavailable,
  as explicitly accepted for SDK 0.1.77 in trace requirement R5.
  Graceful stopping verifies the settled state; forced stopping names
  unresolved aftermath. `doctor --read-only` checks local prerequisites without
  a provider call, command execution, or filesystem changes, and marks runtime
  permission and authentication as unverified.
- Builds perform a bounded SDK execution preflight through the same effective
  model, environment, project settings and permission mode. A matching actual
  Bash tool result is required; model prose is not permission evidence. The
  SDK has no public zero-token execution endpoint, so the approved probe uses
  a provider budget of at most $0.10, or the smaller remaining run cap. Its
  reported spend and tokens count toward the run. A terminal can approve one
  ephemeral permission retry; headless refusal exits 2. Unsupported model
  failures name the requested model and configuration source.
- Distributed rounds are optional: `run` and `resume` accept `--coordinator`
  or `EXOLVRA_GENESIS_COORDINATOR`, and `work` inherits the environment setting.
  Worker daemons poll authenticated shared storage using local model
  credentials. Parentless Git bundles carry pinned trees; the lead verifies
  builder output before blind judging on an independent machine. Capability
  checks, fenced claims, heartbeats, bounded reclaim, budgets, cancellation,
  and worker fleet rows use the existing contracts and templates. Existing
  local runs require no coordinator or additional runtime dependency.
- Protocol models and bounded state exploration cover issue claims and
  distributed round ownership. Regression coverage exercises real local Git,
  competing processes, native HTTP tracker operations, terminal approval, and
  package installation; only the external SDK and GitHub service are substituted.

## 0.8.3 — 2026-08-19

- A torn provider stream is a recoverable fault, not a crash. The Agent SDK
  parses its child process's output line by line, and a process dying
  mid-write hands it half a JSON object as a raw SyntaxError — which the
  session boundary classified as a programmer fault and rethrew past
  recovery, into the internal-error banner, stack eaten. Found live
  ("Unterminated string in JSON at position 167" ended a run that had just
  judged four rounds). A JSON SyntaxError is now read as what it is — torn
  data — and becomes a session error the automatic resume rides out.
- The internal-error banner tells the truth and names the place: "blocked
  before any verdict" (said to a run with four) is gone, replaced by a
  sentence that stands whatever the run did first, plus a one-line house-voice
  fault location — never a stack, which the error bar bans from terminals.

## 0.8.2 — 2026-08-18

- An abnormal session end recovers itself. When a `run` or `resume` session
  dies with the run still saying `running` — a dropped stream, a crashed
  process — the CLI now re-drives the same session in place instead of
  printing a resume line at an empty chair, bounded by
  `EXOLVRA_GENESIS_AUTO_RESUMES` (default 2, 0 disables). Deliberate endings
  are never re-driven: a lead that settled `blocked` made a decision, a
  tripped budget guard enforced one, an interrupt was a person.
- `run` and `resume` default to `--permission-mode bypassPermissions`. An
  unattended build executes the verification commands it was given; under the
  old `acceptEdits` default a headless loop could edit files but never run a
  command, and discovered it 25 minutes in. The flag is now the restriction
  rather than the permission; `plan` keeps the cautious default because it
  executes nothing.
- Recovery waits before it retries: attempt N backs off N ×
  `EXOLVRA_GENESIS_AUTO_RESUME_DELAY_MS` (default 15s), because the fault it
  most often meets is the API saying "Overloaded" and an instant retry asks
  the same servers the same question in the same moment. Found live: a 529
  killed a run and both instant retries died inside the same overload window.
- All three changes came out of the first standalone-CLI runs on a real
  machine, the same days that produced the run-state-hygiene and
  first-contact specs.

## 0.8.1 — 2026-08-16

- The npm package carries a README. The package page was blank because the
  repository's README lives above the package root; `cli/README.md` now
  ships with install, quickstart, the issue runner's safety rules, and the
  exit-code contract. No code changed.

## 0.8.0 — 2026-08-15

- The GitHub issue runner. `exolvra-genesis work` makes one unattended pass:
  it scans allowlisted repos for issues labelled `exolvra:ready` (a
  maintainer's act, never the tool's), claims one within the WIP cap, runs
  the loop against the issue as the spec and the repo's standards as the
  standing bar, and ends with evidence — a pull request and `exolvra:review`
  on a win, a draft PR with the open question on a block, a triage comment
  naming exactly what is missing when no checkable criteria can be derived.
  Humans keep every merge decision. `queue` lists eligible and in-flight
  issues; `.exolvra-genesis/fleet.html` shows the fleet on one page;
  `examples/issue-runner.yml` is the copy-one-file GitHub Actions adoption
  path.
- Every write requires a resolvable identity. The runner resolves its own
  login once per run; a token GitHub refuses `GET /user` (installation and
  Actions tokens) must have its account named by the operator —
  `--runner-login <login>` or `EXOLVRA_GENESIS_RUNNER_LOGIN` — or the run
  exits 2 at startup, before any issue is read. This replaced a degraded
  mode in which every claim decision rested on comments any stranger could
  author; eight adversarial review passes showed that mode could not be made
  safe, so it was deleted rather than patched again. Read-only surfaces
  (`queue`, `work --dry-run`, the fleet page) need no identity.
- Safety as mechanisms, judged adversarially: one module owns all GitHub
  traffic (a planted `fetch` anywhere else fails the suite) and never leaks
  the token into any error, artifact, or page; one module owns git, with
  force-push structurally absent and pushes confined to the
  `exolvra-genesis/issue-…` namespace; issue content is data, never
  instructions — commands are derived only from the issue's own checkable
  text, hostile markup and bidi controls are neutralized in everything
  written back, and secrets pasted into issues render `[redacted]`
  everywhere. Twenty-five findings from eight blind write-safety passes and
  an assembled-artifact round, each fixed and re-verified by replay.
- Charting is specced (`docs/specs/chart-spec.md`, folded into this effort's
  spec as addendum v0.1.1) and lands in a later release.

## 0.7.0 — 2026-08-14

- Repo-owned standards. A repo declares its standing quality bar in
  `.exolvra-genesis/standards.md` (a purpose paragraph, gates, standing bar,
  conventions) and every run in it inherits them: the lead merges standing
  gates first and can never drop or weaken one, the progress page tags each
  gate inherited or this-run, and the standards sha256 joins the per-round
  attestations. `exolvra-genesis standards init` writes the file through a
  question flow, shows the whole thing before asking to write, and offers
  the `.gitignore` pattern that keeps standards tracked while run state
  stays ignored. `standards check` lints it with per-line errors.
- Named goals. `.exolvra-genesis/goals/<name>.md` holds reusable jobs in the
  spec format. `goals` lists them, `goals show` prints one, `goals new`
  scaffolds one through the interview. `run <token>` resolves an existing
  path first, then a goal name, then an inline goal, and refuses an
  ambiguous token while naming both candidates.
- The mechanical half of never-weaken lives at input validation: an input
  that restates standing gates under their own numbering must restate all
  of them verbatim; anything that does not engage the standing ids passes
  untouched to the lead's merge, where the judgment half lives in run.md.
- Built by the loop, reduced scope: full R1-R11/C1-C7 coverage verified,
  two LOSS rounds fixed and re-verified per finding to a WIN, and the
  feature dogfooded on this repo - the standards file above was written by
  the real `standards init` during the run.
- Backlog cleared in the same release: `help <group> <leaf>` now renders the
  leaf page (`help standards check` equals `standards check --help`, and an
  unknown leaf gets the same error either way); `standards init` gathers
  Conventions as paragraphs, one entry each, an empty entry to finish; and
  the checkability lint masks code spans and paths before scanning, so a
  digit no longer shields an adjective. The spec records why `standards
  init` is a local flow while `goals new` borrows the interview: declaring
  standards must work with zero credentials.

## 0.6.0 — 2026-08-11

- Bar immutability is now a mechanism, not only a convention:
  `hooks/bar-integrity-gate.example.json` (opt-in, like the Stop gate) checks
  the bar's sha256 pins before every subagent dispatch and blocks the
  dispatch if any artifact drifted. To support it, the lead now writes the
  pins twice at capture — human-readable in `bar/BAR.md` as before, and
  machine-checkable as `bar/bar.sha256` in `sha256sum` format.

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
