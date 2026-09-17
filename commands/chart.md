---
description: Chart an uncertain destination into a persistent map of decisions, then resolve one ticket per session.
argument-hint: <idea, or existing ticket name>
---

You are charting a destination, using the interview machinery supplied beside
this command. Plan the way; never build the destination. A task ticket may do
only the manual work needed to unblock its question.

$ARGUMENTS

Start by naming what done looks like: a run-ready spec, a locked decision, a
goal, or ready issues. Ask the human breadth-first questions, one at a time.
If the path is already clear, say so and point to interview or run instead
of manufacturing a map. Never simulate an answer from the human.

The local map is `.exolvra-genesis/map/MAP.md`. It has exactly these sections:
Destination, Notes, Decisions so far, Not yet specified, Out of scope.
Decision tickets live in `tickets/<safe-id>.md` under the map. Each has a
title, Type (research, prototype, grilling, task), Status (open or closed),
Blocked by (comma-separated ticket ids, or none), Claim (none or owner),
Mode (HITL or AFK), then Question and Answer sections. Questions fit one
session. Only research and explicitly AFK task tickets can proceed unattended.

Ticket a question whenever it can be phrased precisely now, even if blocked.
Leave it in the fog when it cannot. Do not pre-slice fog. Out-of-scope work
never comes back into scope. A decision lives only on its ticket; the map
indexes closed tickets with one-line gists and name links. References use the
ticket's name; its identifier rides inside the link.

When creating a map, sketch all precise questions, blocking edges, and remaining
fog. The CLI then dispatches frontier research tickets in separate read-only
sessions, up to four at a time; a plugin host may delegate them as AFK research
subagents. Each researcher handles only its question and cites the facts it
actually verified. Never manufacture research results. The first dogfood map
charts the issue-runner decisions. After that research batch, stop.

When working an existing map, re-read it and all tickets. Claim the named
frontier ticket, or the first open, unblocked, unclaimed one. Work exactly one
ticket. Grilling, prototype and HITL tasks require an actual live exchange.
Prototype using the interview's cheap mockup discipline. Record facts and the
decision in Answer, close the ticket, add its linked gist, sharpen any newly
specifiable fog, and exclude work beyond the destination. Then stop.

Inherit standards and standing conventions in Notes. On a cleared map — no
open tickets and no fog — offer the chosen handoff, validate its standing
gates, show the full artifact, and wait for explicit approval before writing
outside the map. Print the exact run command for a spec or goal. Ready issues
require the human to authorize the ready label. Never edit standards.

Tracker choice is explicit. Local mode needs no credentials. GitHub mode is
opt-in, or the default when `EXOLVRA_GENESIS_REPOS` configures the issue runner.
An existing local map stays local; never migrate it implicitly. `--tracker
local` selects it even when the runner is configured. A GitHub map is labeled
`exolvra:map`; each ticket is a native child issue with `exolvra:decide` and one
of `exolvra:research`, `exolvra:prototype`, `exolvra:grilling`, `exolvra:task`.
Native blocking relationships determine readiness, and the assignee owns the
claim. Do not simulate relationships with body checkboxes. All tracker calls
use the CLI's shared GitHub module. Do not execute `gh`, curl, or alternate
GitHub network tools from the planning session.

Never take another session's claim. Interrupted local claims identify their
host and process; the human can release a confirmed dead local process with
`chart "Ticket name" --release-claim`. GitHub sessions renew authenticated
heartbeat receipts and may recover their own account's expired claim under
`--claim-ttl` (default 24h). Receipt age, not issue age, determines expiry.
Foreign or legacy assignments need human-confirmed release. A copied marker
from another author never authorizes recovery. The CLI checks session tokens
before saving or releasing, so an old session cannot settle a takeover.
Release your own claim on success, cancellation and failure.

In CLI transport (the arguments contain a JSON context), the conversation has
read-only tools; the CLI persists proposals. Use exactly one fenced
`genesis-chart` JSON object per proposed action. For map edits, `files` maps
`MAP.md` and `tickets/<id>.md` to complete markdown strings. Omitted files stay
unchanged. Change only the selected ticket, the map index/fog, and newly
specified open tickets. Leave existing answers and out-of-scope lines intact.
Initial tickets are all open. With no fog, emit `{"clear":true}` after the live
exchange and point at interview or run instead of writing an empty map.

A prototype ticket must offer a runnable artifact before it closes. Return
`{"prototype":{"html":"complete self-contained HTML"}}` in its own
`genesis-chart` block. The CLI writes a new uniquely named `.html` file under
`.exolvra-genesis/map/artifacts/`, shows its path, and asks the human to try it.
Wait for that human's feedback before proposing closure. Revisions create new
artifacts; they never overwrite prior prototypes. In GitHub mode the artifact
remains local to the checkout, while the decision and observed feedback live
on its issue. A plugin host follows the same mockup-and-feedback discipline.
An unresolved working ticket must ask another question or report incomplete
research; saving an open ticket is never successful completion.

When context has `researchFanout: true`, return only the selected research
ticket in `files` and a separate `gist` string with one short factual line.
Do not include MAP.md, handoffs or other tickets. The CLI appends the linked
gist while merging independent answers. Leave newly surfaced uncertainty in
the answer for the next session to graduate; another researcher may be using
the same fog. A failed or inconclusive research session leaves its ticket open.

Handoffs use `handoff` with one of these shapes:

```json
{"kind":"spec","path":"specs/approved.md","content":"complete markdown"}
{"kind":"goals","goals":[{"name":"approved-goal","content":"complete markdown"}]}
{"kind":"issues","issues":[{"title":"Approved work","body":"complete build-ready input"}]}
```

Use the destination's chosen shape. Specs and goals inherit all standing gates;
if you restate G identifiers, retain every standing gate verbatim. Ready issues
require GitHub mode and a separate visible approval that explicitly authorizes
`exolvra:ready`. Show the whole artifact, then let the CLI ask for approval.
Never include a readiness label in a planning ticket. A spec must live outside
the internal `.exolvra-genesis/` state directory; goal files use the goals
machinery. Never overwrite an existing handoff or edit standards or .gitignore.

Never claim persistence until the transport confirms it. Ask unanswered
questions in prose with no proposal. HITL task tickets ask the human to do the
manual work and report observed results; AFK tasks may only perform read-only
investigation and propose artifacts inside the map. The destination itself is
always built later by run or the runner.

In a plugin host without CLI transport, re-read and edit the same local
markdown contract using host tools, or call the CLI for GitHub transport. Keep
all writes inside the map until the human has approved the complete handoff.
The human exchange, claims, one-ticket rule and standing gates still apply.
