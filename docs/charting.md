# Chart a destination

`exolvra-genesis chart "An uncertain destination"` conducts a live interview
and records precise decision questions under `.exolvra-genesis/map/`. The map
indexes decisions, links to the tickets containing their answers, and keeps
questions that are not yet precise in “Not yet specified.” If there is no fog,
continue with `interview` or `run` directly.

Prototype tickets save self-contained HTML mockups under
`.exolvra-genesis/map/artifacts/` and print the path to open. The human must try
the artifact and give feedback before the ticket can close. Each revision has
a new filename, including when the decision ticket itself lives in GitHub.

`chart status` reads the files fresh and prints the destination, frontier,
blocked or claimed tickets, and fog. Tables are aligned on a terminal and TSV
in a pipe; `chart status --json` is available for scripts. Malformed markdown
names the file and line and exits 2. Local mode works offline.

`chart "Ticket name"` claims that frontier ticket, or bare `chart` selects the
first available one. Grilling, prototype, and human task tickets require an
actual terminal conversation. `chart "Research question" --afk` works an
unattended research or AFK task ticket. Each working session resolves at most
one ticket. Creating a new map dispatches its frontier research in independent
read-only sessions, at most four concurrently. Their ticket answers and short
index entries are merged serially; inconclusive research stays open.

AFK tasks use read-only tools for gathering facts that unblock a decision.
When a task requires a shell command, account change or other manual action,
make it HITL: the human performs that action and reports the evidence. Charting
does not execute the destination or grant an unattended task general write
access. Prototype HTML and approved handoffs use the explicit transports below.

Local tickets are plain markdown:

```markdown
# Find repository limits

Type: research
Status: open
Mode: AFK
Blocked by: none
Claim: none

## Question
Which documented limits apply to our supported repositories?

## Answer
none
```

Keep these five map headings: Destination, Notes, Decisions so far, Not yet
specified, Out of scope. Ticket ids are their filenames under `tickets/`;
`Blocked by` contains comma-separated ids. Human-facing references use names,
for example `[Find repository limits](tickets/repository-limits.md)`. Claims
are managed by the CLI. Out-of-scope work stays out of scope.

Map writes use an exclusive cross-process lock and reject edits made after a
session read its input. Individual files are replaced atomically; a filesystem
failure during a multi-file update can leave a partial update, so inspect and
repair the map before retrying. A crash can leave `map/.write-lock`; remove
that empty directory only after confirming no writer remains. A dead local
process's ticket can be released with `chart "Ticket name" --release-claim`
and human confirmation. Claims on another host require verification there.
Charting does not modify `.gitignore`: if your repository ignores the whole
state directory, update its ignore rule deliberately so the map is versioned.

## GitHub maps

Use `chart --tracker github --repo owner/repository`. When the issue runner's
`EXOLVRA_GENESIS_REPOS` names one repository, GitHub becomes the default;
multiple configured repositories require `--repo`. `--tracker local` still
selects the local map, and no mode migrates existing decisions automatically.
Use `--map <issue-number>` when the repository has multiple map issues.

Authentication and `GITHUB_API_URL` are shared with the runner. The token needs
issue read/write permission; the GitHub installation must support native child
issues and blocking relationships. If GitHub cannot identify an installation
token, `--runner-login` or `EXOLVRA_GENESIS_RUNNER_LOGIN` names its account using
the runner's identity checks; GitHub must actually accept that account as the
assignee before research starts. A map carries `exolvra:map`. Its child
issues carry `exolvra:decide` and one decision type label. Their native state,
dependencies and assignees override any stale body metadata each time they are
read. Planning issues never receive the runner's ready label.

The implementation uses GitHub's [sub-issue API](https://docs.github.com/en/rest/issues/sub-issues)
and [dependency API](https://docs.github.com/en/rest/issues/issue-dependencies),
through the same network module as the runner. A GitHub claim is checked before
assignment and read back afterwards. GitHub offers no atomic compare-and-set
for this assignment: use distinct accounts for independent workers and avoid
starting simultaneous sessions for one ticket. An authenticated sticky comment
records each session's token and UTC heartbeat, renewed at least once a minute
while the session runs or waits for human input. `--claim-ttl` uses the runner's
duration format and default of 24 hours (minimum one minute, maximum 30 days).
A later session under the same resolved runner account can reclaim that
account's expired claim and records the takeover. A new token prevents the old
session from saving or releasing the replacement claim. Heartbeat failures
prevent a later save. Only comments authored by that account attest its claim;
another user's copied marker never authorizes recovery.

Assignments without authenticated heartbeat evidence, including legacy claims
and claims belonging to another account, need human recovery.
`--release-claim` asks the human to verify abandonment and approve release.

Remote edits are re-read before saving. Network failures report already-created
issues and partial state; there are no automatic retries or deletion of the
human's work. Inspect the map and repair relationships before continuing.

## Approved handoff

When every ticket is closed and the fog is empty, run `chart` to review the
chosen destination: a complete spec, named goal files, or runner issues. Each
artifact is checked against repository standards and displayed in full.
Nothing outside the map is written before terminal approval. Existing files
are never overwritten. A spec or goal handoff prints the exact run command;
the issue handoff explicitly asks permission to apply `exolvra:ready`, creates
each issue first without the label, then labels it. A partial failure cannot
make an uncreated issue ready.

The conversation is maintained in `commands/chart.md`; the CLI provides
transport, validation, claims and approval. Charting is adapted from Matt
Pocock's MIT-licensed `wayfinder` decision-map workflow.
