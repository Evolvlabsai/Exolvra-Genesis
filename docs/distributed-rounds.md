# Distributed rounds

Distribution is optional. Existing `run` and `work` commands need no service,
daemon, shared storage, or migration. The lead continues to execute
`commands/run.md`; distribution replaces only builder and critic transport.

The coordinator is a directory on authenticated shared storage. Mount it on
each machine using your existing operating-system facilities. The filesystem
must provide coherent atomic directory creation and rename across clients;
eventually consistent object-store mounts are unsuitable. Restrict directory
ACLs to trusted leads and workers. There is no listening port, HTTP service,
GitHub token exchange, or coordinator model login. Workers poll the directory.
The filesystem identity is the authentication boundary; users who can edit its
state are trusted coordinator administrators.

Start a worker on each machine:

```sh
exolvra-genesis daemon --coordinator /mnt/genesis --name linux-a --machine linux-a --capabilities model:inherit,platform:linux,browser
exolvra-genesis daemon --coordinator /mnt/genesis --name windows-b --machine windows-b --capabilities model:inherit,platform:win32,browser
```

Declare only models actually signed in and perception tools actually available
locally. `--machine` identifies the physical machine, not the daemon process.
Multiple daemon identities on the same machine do not provide independence.
The default is the hostname; set an explicit identity when hostnames collide.
Each worker uses its own model authentication. Runner GitHub token environment
variables are removed case-insensitively before its session starts. Existing
OS credential helpers remain an operator-controlled trust boundary, as for
the issue runner.

The default TTL is the issue runner's 24 hours, shared by all clients of the
coordinator. Configure a shorter TTL when starting its first daemon with
`--ttl-seconds` (minimum 60). Workers heartbeat at most every ten seconds,
including during sessions. Polling defaults to five seconds. Expired claims
are fenced by unique claim tokens and attempted at most twice; a late result
cannot settle a replacement attempt. `--once` executes one available round
and deregisters. SIGINT and SIGTERM interrupt the current session and
deregister after settling. Lead cancellation waits up to fifteen seconds for
worker acknowledgments and final spend receipts before deleting artifacts.
If a worker cannot acknowledge, the run is BLOCKED and coordinator evidence
is retained for recovery. Expired and capability-revoked attempts retain only
permission to settle their final bill; they cannot publish work or release a
replacement claim. The fleet page is
`<coordinator>/.exolvra-genesis/fleet.html`, using the existing fleet template.

The lead writes a request file with its existing Task Spec:

```json
{
  "run": "20260917-120000-demo",
  "piece": "parser",
  "round": 1,
  "task": "The full existing Task Spec, including ownership and hard gates",
  "files": ["src/parser.ts", "test/parser.test.js"],
  "verify": "npm test",
  "bar": "The full captured bar and measurable acceptance criteria",
  "barDirectory": ".exolvra-genesis/runs/20260917-120000-demo/bar",
  "requirements": ["platform:linux"],
  "criticRequirements": ["browser"],
  "model": "inherit",
  "criticModel": "inherit"
}
```

`barDirectory` is optional for wholly textual or numerical bars. For bars
containing assets, it captures actual bytes, not paths that refer to the lead's
machine. Assets are hash checked, capped at 64 MiB, and unpacked under the
worker checkout's `.exolvra-genesis/bar`. Symlinks are refused. The Task Spec,
bar, and base bundle metadata are hash sealed before a worker receives them.

```sh
exolvra-genesis round --coordinator /mnt/genesis --action build --request request.json
exolvra-genesis round --coordinator /mnt/genesis --action judge --job BUILDER_JOB_ID
exolvra-genesis round --coordinator /mnt/genesis --action status --job JOB_ID
exolvra-genesis round --coordinator /mnt/genesis --action cleanup --run RUN_ID
```

`build` publishes a base snapshot, awaits the worker, imports the reported
commit, and reruns the exact verification command before recording a verified
receipt. The JSON result names the sha, changed files, report, verbatim lead
verification output, and temporary checkout containing that exact tree. The
lead integrates those owned files and continues its usual judging and win
discipline. The checkout is retained for integration and cleaned when its lead
settles. Direct users of the round command should remove it after use.
`verify` with `--job` repeats verification of a completed builder job.
`--wait-seconds` limits waiting, defaulting to one hour; a wait timeout reports
the still-pending job rather than inventing a round verdict.

Snapshots are parentless commits: no builder history or prior rounds travel
to the critic. Bundles advertise only
`refs/exolvra/rounds/<run>/<piece>/<round>`, never a branch or PR. References
are created with a compare-and-create operation and removed with
compare-and-delete immediately after bundling. No remote push is involved.
The bundle digest and advertised commit sha are checked on every import.
`judge` refuses an unverified builder and supplies only the pinned tree, bar,
and existing critic prompt. It chooses another physical machine. Same-machine
fallback exists only for a coordinator that has registered one physical
machine; an offline second machine does not silently weaken independence.
Settling a run removes its bundle objects when no other job references them.
Cleanup refuses active claims.

The same `createSession` machinery loads the same builder/critic markdown on
workers. Builders retain a local session per run/piece/model; an unavailable
context or ownership breach starts cold. Critics always start fresh. The
ownership gate runs on the worker, its verdict travels with the Report, and
`BUILT SHA` identifies the exact tree. Operational events, spend, and final
reports flow into the lead trace while it awaits each round. Distributed
transport does not decide wins, merge PRs, or reproduce the lead loop.

The `run` and `resume` commands accept `--coordinator`; alternatively set
`EXOLVRA_GENESIS_COORDINATOR`, which also passes through the issue runner.
Resuming remembers the coordinator for its run and refuses replacing it, so
outstanding claims and bills remain attached to their original queue. The same full
`ownership-plan.json` gates local and remote dispatch. Finding fingerprints,
duplicate suppression, and see-saw signals use the same comparison functions
and persisted history. A capable live prior builder worker is preferred for
continuity; resumed sessions receive Task Spec changes and batched `feedback`.
Model changes, unavailable sessions, and poisoned contexts start cold. Model
spend includes remote attempts and failed retries; active worker budgets are
reserved and passed to the SDK's own cap.
The run ledger saves its accounted coordinator spend together with the total
cost. Cleanup keeps a numeric receipt, so resuming a blocked cancellation
charges only new receipts, including late final worker costs.

## Fault matrix

| Fault | Observable result | Recovery |
| --- | --- | --- |
| Worker dies during a round | Trace `worker-died`; expired claim redispatched once | Second expiry is failed, exit 1 |
| Old worker returns after takeover | Stale claim token refused | Current claim remains authoritative |
| Missing model/platform/browser | BLOCKED with missing capability named, exit 1 | Register a capable worker and dispatch a new round |
| Capability disappears during a claim | BLOCKED, result rejected | Restore capability and dispatch again |
| Two machines registered, only builder available | BLOCKED for independent machine, exit 1 | Restore an independent critic |
| Bundle unavailable or corrupt | Failed import; no verified receipt, exit 1 | Restore the artifact and reverify |
| Report sha differs from bundle | Automatic failed verification, no critic | Correct the builder round |
| Task/bar payload changes in transit | Failed hash check; no session | Republish from the pinned source |
| Builder touches unowned file | Ownership breach; no successful Report or bundle | Correct Task Spec/work and start cold |
| Verification exits nonzero or changes pinned files | No verified receipt; no critic, exit 1 | Correct build or verification command |
| Wait timeout | Exit 1 naming the actual queued/claimed job | Inspect status or wait again |
| Shutdown | Session interrupted, claim failed, daemon deregistered | Redispatch as a new round |
| Worker cannot acknowledge lead cancellation | Run BLOCKED; final spend remains unsettled | Keep coordinator evidence until the worker reconnects and settles |

The design was modeled and exhaustively explored before worker implementation:
`docs/models/DistributedRounds.tla` and
`cli/test/distributed-rounds.test.js`. The original explored bounds are two
machines, one round, and two claim generations (248 reachable states).
`cli/test/distributed-runtime.test.js` exercises the real filesystem/Git
transport and substitutes only the existing SDK session boundary.
