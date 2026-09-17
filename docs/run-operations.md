# Watching and stopping runs

Run records and artifacts live in `.exolvra-genesis/runs/<run-id>/`. Use
`exolvra-genesis runs` to find a run, `status` to inspect active or blocked
runs, and `trace <run-id>` to inspect its recorded events.

```sh
exolvra-genesis status --watch
exolvra-genesis status --json
exolvra-genesis trace <run-id> --follow --json
exolvra-genesis stop <run-id>
exolvra-genesis doctor --read-only --json
```

All these commands accept `--directory <project>` (`-C`). `status --watch`
prints when observed state changes. `status --json` produces a snapshot;
`trace --json` produces one event per line. Ctrl+C ends a watch or trace
without stopping the build.

The status view reports phase, round and cost caps, last activity age,
process liveness, piece verdicts and agent activity. The progress page in
the run directory shows current activity, observed spend and tokens, active
agents, and budget warnings. Cost or round consumption reaching 80% of its
cap triggers a warning; normal run budget guards still enforce the cap.
Provider spend is recorded when reported, so it can lag work in progress.
Local session totals are exact at the provider-reported scope. Claude Agent
SDK 0.1.77 does not reliably attribute those dollars to nested piece/round
queries, so their dollar splits are unavailable. Distributed round queries
report exact piece/round spend. Retries retain each attempt's receipt;
unattributed costs are never displayed as zero or estimated splits.

Missing or damaged trace data falls back to the last written run record and
is labeled accordingly. An open process record alone does not prove a
process is alive. Stale activity is evidence to inspect, not proof of a
failed command or a reason for the watchdog to kill it.

## Inactivity thresholds

The watchdog observes each phase separately. Set these environment variables
in seconds before starting the run and in the environment used by `status`:

| Variable | Default |
| --- | ---: |
| `EXOLVRA_GENESIS_STALL_LEAD_SECONDS` | 180 |
| `EXOLVRA_GENESIS_STALL_BUILDER_SECONDS` | 300 |
| `EXOLVRA_GENESIS_STALL_CRITIC_SECONDS` | 180 |
| `EXOLVRA_GENESIS_STALL_VERIFICATION_SECONDS` | 60 |

Values must be positive numbers; invalid values use the phase default.
`status --verification-stall-seconds 120` changes verification for that
status view. `status --stall-seconds 600` overrides all phases for that
view, including any verification override. These flags do not change the
running process's watchdog. A stall emits evidence and leaves the run
running so an operator can inspect it or request a stop.

## Stopping and checking the environment

`stop <run-id>` requests a graceful stop and waits up to 15 seconds for the
state and run ledger to settle. `--grace-seconds` changes that wait. For an
issue-owned run, the command also waits for the owner to finish settling its
GitHub claim. Name the run when more than one is active.

If grace expires, `stop <run-id> --force` can terminate the identified owner
and its process tree. The command refuses to kill when it cannot safely
identify that owner. A forced stop records `blocked`, exits 1 and reports
that remote claims may still need recovery. Inspect the trace and tracker
before resuming such a run.

`doctor --read-only` checks locally observable prerequisites, configuration,
plugin files, standards and run records without writing files or executing
a command. It reports authentication and execution permission as unverified:
those require the bounded SDK preflight performed by build commands. Doctor
exits 2 for configuration errors and 0 when its local checks pass; unknown
runtime facts remain explicitly unknown.
