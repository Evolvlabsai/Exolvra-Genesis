# exolvra-genesis

Builders iterate against blind, fresh-context critics comparing real output
to a concrete quality bar, until the assembled work wins twice in a row.
This package runs that loop from the command line — the same loop the
[Exolvra Genesis Claude Code plugin](https://github.com/Evolvlabsai/Exolvra-Genesis)
runs, loaded from the same files, never reimplemented.

```
npm install -g exolvra-genesis
```

Requires Node 20+, and access to Claude (an `ANTHROPIC_API_KEY`, or a
machine where Claude Code is logged in).

## Start here

```
exolvra-genesis interview          # turn an idea into a run-ready spec
exolvra-genesis run spec.md        # run the loop against it
exolvra-genesis plan spec.md       # preview the bar and pieces, run nothing
```

`run` picks a concrete bar (an artifact or a number, never an adjective),
splits the work into pieces, fans out builders, and judges the assembled
result with fresh critics who see only the bar and the real output. A tie
is a loss. The run ends on two consecutive wins, and `.exolvra-genesis/progress.html`
in your project shows every round while it happens. `runs` lists past runs;
`resume` continues one.

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
