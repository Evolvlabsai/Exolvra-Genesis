# Charting — Specification v0.1

An idea can arrive too big and too foggy for one interview: the way to a
run-ready spec is not visible yet. Charting finds the way before anything is
built. It keeps a persistent **map** of **decision tickets** — questions
whose resolution is a decision, not a slice of a build — and works them one
session at a time until nothing is left to decide, then hands off to the
loop Exolvra Genesis already has: a spec for `run`, goals for `goals/`, or
issues labeled ready for the issue runner.

Adapted from Matt Pocock's `wayfinder` skill (MIT), reshaped to Exolvra
Genesis: self-contained, tracker-light by default, and wired to the
interview machinery instead of a foreign skill suite. Credit lands in the
README alongside the existing credits.

Part of the issue-runner effort: the two share the tracker substrate, the
label namespace, and the network module (see the addendum in
`issue-runner-spec.md`). Charting's local mode has no dependency on the
runner and may ship first.

## Constraints (hard gates)

- C1. No new runtime dependencies, plugin or CLI.
- C2. The charting conversation lives in plugin markdown
  (`commands/chart.md`); the CLI (`exolvra-genesis chart`) is transport and
  ergonomics only and loads it at runtime — the loop is never reimplemented
  (CLI spec C3 applies). The file joins `PLUGIN_FILES` and ships in the
  package.
- C3. Plan, don't do: a charting session resolves decisions and charts the
  map; it never builds the destination. The one exception is a task ticket,
  which does exactly the manual work that unblocks a decision, and nothing
  more.
- C4. Human-in-the-loop tickets (grilling, prototype, and HITL tasks) only
  resolve through a live exchange with the human. An agent that answers its
  own questions has broken the ticket; that is the anti-simulation rule
  applied to planning, and it is a hard gate.
- C5. One ticket per session, except research tickets, which may fan out in
  parallel as AFK subagents.
- C6. Two tracker modes, one contract. **Local mode** (default, zero
  configuration, works offline): the map and tickets are committed markdown
  under `.exolvra-genesis/map/`, which joins the C7 ignore-pattern
  exceptions beside `standards.md` and `goals/` — decisions are repo
  intent, and they version with the code. **GitHub mode** (opt-in, and the
  default once the issue runner is configured): the map is an issue labeled
  `exolvra:map`, tickets are its child issues labeled `exolvra:decide` plus
  a type label, blocking uses the tracker's native relationships, and a
  claim is the assignee. All GitHub traffic goes through the issue runner's
  single network module.
- C7. A decision lives in exactly one place — its ticket. The map is an
  index: it gists and links, never restates. Every reference the human
  reads uses the ticket's name, with the id riding inside the link.
- C8. Charting never writes to `standards.md`, `goals/`, or any file
  outside the map without the explicit handoff step, and handoff artifacts
  (a spec, a goal, ready-labeled issues) are written only after the user
  approves them — same approval discipline as the authoring commands.

## Requirements

- R1. The map holds: **Destination** (one or two lines naming what done
  looks like — a spec, a locked decision, or a change), **Notes** (domain
  context and standing preferences every session loads), **Decisions so
  far** (the index: one line per closed ticket, name-linked, gist only),
  **Not yet specified** (the fog: in-scope questions not yet sharp enough
  to ticket), and **Out of scope** (work consciously ruled past the
  destination; it never graduates back).
- R2. Tickets carry one question sized to one session, a type, blocking
  edges, and a claim. Types: **research** (AFK — surface a fact a decision
  waits on), **prototype** (HITL — raise fidelity with a cheap concrete
  artifact, reusing the interview's mockup discipline), **grilling** (HITL
  — the default: a conversation run with the interview machinery, scoped to
  the ticket's question), **task** (HITL or AFK — manual work that unblocks
  a decision; the answer records what was done and the facts later tickets
  depend on).
- R3. The fog test is stated and enforced in the markdown: ticket it when
  the question can be phrased precisely now, even if blocked; leave it in
  the fog when it cannot. Fog is never pre-sliced into ticket-sized pieces.
- R4. Charting mode (`/exolvra-genesis:chart <idea>`, `exolvra-genesis
  chart <idea>`): name the destination first, grill breadth-first across
  the space, create the map and the tickets that can be specified now, wire
  blocking, sketch the rest into the fog, fire research subagents, stop. If
  no fog surfaces — the way is already clear — say so and point at the
  interview or `run` instead of creating a map.
- R5. Working mode (`chart` with an existing map, optionally a ticket
  name): load the map, claim a ticket (the named one, else the first
  frontier ticket), resolve it by its type, record the answer on the
  ticket, close it, append the one-line gist to Decisions so far, graduate
  any fog the answer sharpened, and rule out of scope anything the answer
  exposed as past the destination. Then stop.
- R6. The frontier — open, unblocked, unclaimed tickets — is queryable:
  `exolvra-genesis chart status` prints the destination, the frontier, the
  blocked set, and the fog, in the house table discipline (TSV piped,
  aligned on TTY, `--json`).
- R7. Handoff: when no tickets remain and the fog is empty, the session
  offers the destination in the shape the user chose at charting time — a
  run-ready spec (printing the exact `exolvra-genesis run` line), goal
  files via the goals machinery, or ready-labeled issues for the runner —
  written only on approval (C8).
- R8. Standards inheritance applies to the handoff: a spec or goal produced
  by charting is validated against `.exolvra-genesis/standards.md` exactly
  as any hand-written input would be, and the map's Notes carry the
  standing conventions so grilling sessions honor them.
- R9. Local-mode files are plain markdown a human can edit; `chart status`
  and the working mode re-read them fresh each session and tolerate hand
  edits. A malformed map or ticket is reported per line in the
  `standards check` style, exit 2.
- R10. Dogfood: the first real map charts the issue-runner build itself —
  its open design decisions become the tickets, and the cleared way hands
  off as the runner's build-ready inputs. Livability findings are findings.

## Non-goals

- No tracker abstraction layer and no third tracker. Local markdown and
  GitHub Issues, nothing else.
- No execution of the destination from inside charting — the runner, the
  loop, and the human do that.
- No automatic migration of a local map to GitHub mode; redrawing the map
  where it lives is a fresh charting act.
- No vendored skills: grilling and prototyping are the interview machinery
  under a scope brief, not imported commands.

## References (bar candidates)

- Matt Pocock's `wayfinder` SKILL.md (MIT) — the structural reference: the
  map shape, ticket types, fog of war, out-of-scope discipline, and the
  one-ticket-per-session rule.
- `bars/cli-ux/` for every new CLI surface (`chart`, `chart status`), and
  the interview frames for the grilling sessions.
- `docs/specs/issue-runner-spec.md` — the shared label namespace, claim
  protocol, and network module the GitHub mode rides on.
- The dogfooded map from R10, as the livability proof.
