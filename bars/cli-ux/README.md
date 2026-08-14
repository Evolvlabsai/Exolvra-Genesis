# bars/cli-ux

Reusable bar pack for CLI surfaces: real transcripts of two shipped tools,
captured 2026-08-10 on the machine that built this repo's CLI. Every judged
round of that build compared the candidate's output against these files.
Point a run's bar at this directory whenever the deliverable is command-line
help, tables, errors, or an interactive prompt flow.

## gh/ — GitHub CLI 2.88.1

| File | Command | The bar for |
|---|---|---|
| `root-help.txt` | `gh --help` | Root help: sectioning, one aligned description column, USAGE/FLAGS/EXAMPLES/LEARN MORE |
| `subcommand-help.txt` | `gh run --help` | Command-group help |
| `leaf-help-flags.txt` | `gh run list --help` | Leaf help: a flag table complete enough to replace a README table |
| `list-output.txt` | `gh run list --repo cli/cli` (piped) | Tabular output: tab-delimited, headerless, machine-pipeable |
| `json-output.txt` | `gh run list --json …` | Machine output carrying the same facts as the human view |
| `usage-error.txt` | `gh bogus-command` (exit 1) | Unknown-command error shape |
| `exit-codes-topic.txt` | `gh help exit-codes` | Exit codes documented as a first-class contract |

## clack/ — @clack/prompts 1.7.0

`frames-plain.txt` is a real rendering of an interactive startup flow (text
prompt, radio-row selects with hints, note box, spinner, log lines, outro),
reduced from the raw capture in `frames-raw.txt`. Every glyph, rail, and
spacing decision is the library's own; only the content strings were
authored for the capture.

Regenerate with `capture.mjs`: it drives the real library through fake TTY
streams, so no terminal is needed.

```
npm install @clack/prompts@1.7.0
node capture.mjs
```

## Judging protocol

Run the candidate binary as a real process, capture its output to a
transcript, and put that transcript beside the file here that covers the
same surface. The question is never "is this good output" — it is: put next
to the shipped tool's transcript, could a user tell which one is which? A
tie is a LOSS.
