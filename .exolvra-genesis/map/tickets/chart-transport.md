# Verify chart transport and approvals

Type: research
Status: closed
Mode: AFK
Blocked by: runner-safety
Claim: none

## Question

Can the chart implementation persist editable local decisions and GitHub-native
relationships while requiring actual human exchanges and approved handoffs?

## Answer

On 2026-09-17, `node --test test/chart.test.js` in `cli/` passed all 20 tests.
[The suite](../../../cli/test/chart.test.js) exercises real local files and
competing Node processes, real terminal keystrokes through the prompt library,
and a real local HTTP GitHub stand-in. Only the external Claude SDK responses
and GitHub service are simulated; no live GitHub writes were performed.

The tests cover malformed input, editable markdown, cross-process exclusion,
stale claims, one-ticket ownership, human exchange before closure, read-only
parallel research, partial remote failure, native child/blocking/assignee
relationships, goal writing, cancellation, and ready-label approval. The
transport limitations are documented in [charting.md](../../../docs/charting.md):
GitHub has no atomic assignment compare-and-set, and multi-file local or remote
writes can be partial after a filesystem or network failure.

Livability findings: auto-editing .gitignore from chart persistence violated
the map-only write boundary and was removed. Importing terminal prompts at
command registration broke headless plan sandboxes and was made lazy. Parallel
research must return only its ticket and a gist, so one researcher cannot
overwrite another's fog or answer. These findings were implemented and tested.
