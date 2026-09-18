# Chart a destination

`exolvra-genesis chart "An uncertain destination"` conducts a live interview
and records precise decision questions under `.exolvra-genesis/map/`. The map
indexes decisions, links to the tickets containing their answers, and keeps
questions that are not yet precise in “Not yet specified.” If there is no fog,
continue with `interview` or `run` directly.

Prototype tickets save self-contained HTML mockups under
`.exolvra-genesis/map/artifacts/` and print the path to open. The human must try
the artifact and give feedback before the ticket can close. Each revision has
a new filename.

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

## Approved handoff

When every ticket is closed and the fog is empty, run `chart` to review the
chosen destination: a complete spec or named goal files. Each artifact is
checked against repository standards and displayed in full. Nothing outside
the map is written before terminal approval. Existing files are never
overwritten. A spec or goal handoff prints the exact run command.

GitHub-backed maps (native child issues, dependencies and assignees) and the
ready-issue handoff belong to the Exolvra control plane, which is not part of
this repository.

The conversation is maintained in `commands/chart.md`; the CLI provides
transport, validation, claims and approval. Charting is adapted from Matt
Pocock's MIT-licensed `wayfinder` decision-map workflow.
