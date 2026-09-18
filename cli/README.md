# exolvra-genesis

Builders iterate against blind, fresh-context critics comparing real output
to a concrete quality bar, until the assembled work wins twice in a row.
This package runs that loop from the command line — the same loop the
[Exolvra Genesis Claude Code plugin](https://github.com/Evolvlabsai/Exolvra-Genesis)
runs, loaded from the same files, never reimplemented.

```
npm install -g exolvra-genesis
```

Requires Node 18 or newer, and access to Claude (an `ANTHROPIC_API_KEY`, or
a machine where Claude Code is logged in).

## Start here

```
exolvra-genesis interview          # turn an idea into a run-ready spec
exolvra-genesis run spec.md        # run the loop against it
exolvra-genesis plan spec.md       # preview the bar and pieces, run nothing
```

`run` picks a concrete bar (an artifact or a number, never an adjective),
splits the work into pieces, fans out builders, and judges the assembled
result with fresh critics who see only the bar and the real output. A tie
is a loss. The run ends on two consecutive wins, and `.exolvra-genesis/runs/<run-id>/progress.html`
in your project shows every round while it happens. `runs` lists past runs;
`resume` continues one.

For a browser interface, run `exolvra-genesis dashboard --open`. The
control panel shows projects, run history, live events, agent definitions and
measured usage. Start builds or plans and stop or resume work from the panel.
Commands it starts continue if the panel stops, and paid commands wait in a
persistent queue; `--concurrency 2` lets two run at once across projects.
Use `-C /path/to/project` to select the initial project and `--port 4317` to
choose the port. For shared access, configure `EXOLVRA_GENESIS_PANEL_TOKEN`
and `--public-url` behind an HTTPS reverse proxy. Members sign in with that
workspace key and operate projects on the server using its CLI credentials.
Node, container and service deployments are supported; see the
[control panel guide](https://github.com/Evolvlabsai/Exolvra-Genesis/blob/main/docs/control-panel.md).

An unattended build executes commands and therefore uses
`--permission-mode bypassPermissions` by default; the first execution refusal
names that flag and its remedy. Before a build, a bounded SDK query executes a
harmless Bash command under the same permissions, records its result and spend,
and refuses if execution cannot be demonstrated. The probe requests a provider
budget of at most $0.50 across attempts (an Opus first turn alone costs about
$0.16); actual spend counts toward the run budget. `plan` skips it and retains
its cautious default.

Repos can declare a standing bar the loop always inherits
(`exolvra-genesis standards init`) and keep reusable jobs by name
(`exolvra-genesis goals`).

## The issue runner

```
exolvra-genesis work --repo owner/name     # one unattended pass
exolvra-genesis queue --repo owner/name    # what is eligible and in flight
```

`work` claims a GitHub issue a maintainer labelled `exolvra:ready`, runs
the loop against the issue as the spec, and ends with evidence: a pull
request on a win, a draft PR carrying the open question on a block, or a
triage comment naming exactly what is missing. **Humans keep every merge
decision.** `examples/issue-runner.yml` in the repository is a
copy-one-file GitHub Actions deployment.

The safety rules are mechanisms, not promises:

- Every write requires a resolvable identity. A token GitHub will not name
  (installation and Actions tokens) needs `--runner-login` or
  `EXOLVRA_GENESIS_RUNNER_LOGIN`, or the run exits 2 before any issue is
  read.
- One module owns all GitHub traffic; one owns git. Force-push is
  structurally absent, and pushes are confined to the
  `exolvra-genesis/issue-…` branch namespace.
- Issue content is data, never instructions. Commands are derived only
  from the issue's own checkable text, hostile markup is neutralized in
  everything written back, and secrets pasted into issues render
  `[redacted]` on every surface — branch names and evasive Unicode
  encodings included.
- `--dry-run` shows the whole plan and writes nothing. `queue` and the
  fleet page are read-only.

## Decision maps and run operations

`exolvra-genesis chart "An uncertain destination"` records a map of decisions.
`chart status` lists available tickets and remaining fog; `chart "Ticket name"`
works one question. Local markdown works offline. `--tracker github --repo
owner/name` uses native GitHub child issues, dependencies and assignees; the
runner's configured repository becomes the default tracker. Human decisions
and spec, goal or ready-issue handoffs require terminal approval. Research
tickets may run unattended and fan out in parallel when a map is created.

`trace` reads run events and exact reported session spend. Local nested
piece/round dollar splits are unavailable; distributed round costs have exact
provider receipts. `status` shows active runs, `stop` requests
a graceful stop, and `doctor --read-only` checks local prerequisites. Distributed
builder rounds are opt-in with `run --coordinator <shared-directory>`. See command help for the
available flags and the repository's
[charting guide](https://github.com/Evolvlabsai/Exolvra-Genesis/blob/main/docs/charting.md)
for storage, claims and handoffs. The
[run-operations guide](https://github.com/Evolvlabsai/Exolvra-Genesis/blob/main/docs/run-operations.md)
explains status evidence, per-phase inactivity thresholds and stopping runs.

## Exit codes

`0` the run met its win condition · `1` it lost, was blocked, or a budget
guard stopped it · `2` the invocation itself has to change. A win outranks
every later fault. `exolvra-genesis help exit-codes` and
`help environment` cover the rest — there is no flag table here because
`--help` makes one unnecessary.

## What it is not

No state database, no required MCP servers, no framework. Runtime
dependencies are the Claude Agent SDK and `@clack/prompts`, nothing else.
The loop's behavior lives in plain Markdown that ships inside this package
(`dist/plugin/`) — reading it is reading the product.

[Repository](https://github.com/Evolvlabsai/Exolvra-Genesis) ·
[Changelog](https://github.com/Evolvlabsai/Exolvra-Genesis/blob/main/CHANGELOG.md) ·
MIT
