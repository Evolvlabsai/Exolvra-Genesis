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

## Decision maps and run operations

`exolvra-genesis chart "An uncertain destination"` records a map of decisions
as editable markdown under `.exolvra-genesis/map/`. `chart status` lists
available tickets and remaining fog; `chart "Ticket name"` works one question.
Human decisions and spec or goal handoffs require terminal approval. Research
tickets may run unattended and fan out in parallel when a map is created.

`trace` reads run events and exact reported session spend; nested piece/round
dollar splits are unavailable. `status` shows active runs, `stop` requests a
graceful stop, and `doctor --read-only` checks local prerequisites. See command
help for the available flags and the repository's
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

No state database, no required MCP servers, no framework, and nothing in
the package reaches the network except the Agent SDK. Runtime dependencies
are the Claude Agent SDK and `@clack/prompts`, nothing else. The loop's
behavior lives in plain Markdown that ships inside this package
(`dist/plugin/`) — reading it is reading the product.

The GitHub issue runner, the control panel and distributed rounds shipped in
this package up to 0.12.0. They are part of the Exolvra platform now and are
no longer in this package.

[Repository](https://github.com/Evolvlabsai/Exolvra-Genesis) ·
[Changelog](https://github.com/Evolvlabsai/Exolvra-Genesis/blob/main/CHANGELOG.md) ·
MIT
