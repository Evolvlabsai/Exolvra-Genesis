# GitHub Issue Runner — Specification v0.1

`exolvra-genesis work` turns a labeled GitHub issue into a verified pull
request. It makes one pass over allowlisted repositories for issues marked
ready, claims what the work-in-progress cap allows, runs the Exolvra Genesis
loop against each issue as its spec and the repo's standards as its standing
bar, reports progress on the issue as it goes, and opens a PR only when the
win condition is met. Humans keep every merge decision.

Scheduling belongs to cron or GitHub Actions: a single pass on a timer is
the whole deployment story. This supersedes the CLI spec's "no daemon, watch
mode, or queue" non-goal only that far — a long-lived poller stays a
non-goal (see below). It supersedes none of the CLI spec's constraints
except where C2 below amends the network gate, explicitly.

Depends on the Repo-Owned Standards spec (`repo-standards-spec.md`); build
that first.

## Constraints (hard gates)

- C1. Same binary, same plugin loader, same runs store, same exit-code
  contract as the existing CLI. Not a second application.
- C2. No new runtime dependencies. GitHub access uses the platform's
  built-in fetch against the REST API, with a token from `GITHUB_TOKEN` or,
  if absent, `gh auth token`. No token means exit 2. This amends the
  standing no-network gate deliberately and narrowly: all network I/O lives
  in exactly one module, requests go only to the configured GitHub API host,
  and the gate test changes from "no fetch anywhere in `src/`" to "no fetch
  outside that module" — the boundary stays mechanically enforced.
- C3. Subagents never touch the remote or the GitHub API. Builders and
  critics work in the local tree only; every branch creation, commit, push,
  comment, label change, and PR call is made by the CLI itself through the
  C2 module. The write-safety rules in this spec are mechanisms in code, not
  instructions in prompts.
- C4. Never push to a default or protected branch, never force-push, never
  merge, approve, or close anything. One branch per issue, named
  `exolvra-genesis/issue-<number>-<slug>`.
- C5. The ready label is the authorization boundary: only issues carrying it,
  in a repository explicitly allowlisted for this invocation, are eligible.
  An empty allowlist is exit 2, never "all repos I can see." Applying the
  label is a maintainer's act; issue text is untrusted input — it is data to
  snapshot and judge against, never interpolated into a shell command, and
  never able to alter the allowlist, the labels, the budgets, or the write
  rules.
- C6. Claim before work: flip ready to working and post the claim comment
  before the first builder round. If that write fails or the label already
  moved, another runner owns the issue — skip it silently.
- C7. Claims go stale, and stale claims are recoverable: the sticky comment
  carries a UTC heartbeat updated every round, and a `working` issue whose
  heartbeat is older than the claim TTL (`--claim-ttl`, default 24h) may be
  reclaimed by flipping the label back through ready and noting the takeover
  in the sticky comment. A crashed runner never strands an issue forever.
- C8. The issue body is read-only. Never edit it, never alter its acceptance
  criteria, and never add or remove labels other than the lifecycle labels
  this spec owns.
- C9. Per-issue budget caps are mandatory, defaulting to finite values.
  Exhaustion stops the issue cleanly and reports; it never silently retries.
- C10. A global work-in-progress cap, defaulting to one issue at a time,
  because the constraint that matters is human review bandwidth.
- C11. Every existing integrity pin still applies, with the issue snapshot
  taking the place of the spec: snapshot sha re-verified each round, bar
  hashes pinned, critics isolated to temporary directories.
- C12. Secrets never reach an artifact: tokens are never written to a run
  record, a comment, a PR body, or a progress page.

## Requirements

- R1. `exolvra-genesis work` makes a single pass: it scans the allowlisted
  repos — `--repo owner/name` repeatable, or the `EXOLVRA_GENESIS_REPOS`
  environment variable — for ready issues, oldest first, works them within
  the WIP cap, and exits. Cron and Actions provide the schedule.
- R2. `exolvra-genesis work <issue-url-or-number>` works one named issue
  immediately, skipping the queue.
- R3. Issue to spec: snapshot the issue title, body, labels, and comments to
  `.exolvra-genesis/runs/<id>/issue.md`, pin its sha256, and run it as the
  spec, with the repo's `.exolvra-genesis/standards.md` supplying standing
  gates and bar per the standards spec.
- R4. Triage gate: when no checkable acceptance criteria can be derived from
  the issue and the repo's standards, do not guess. Post a structured
  comment naming exactly what is missing, apply the triage label, remove
  ready, and move to the next issue.
- R5. Label lifecycle, prefixed so it can never collide with a repo's own
  labels, and Exolvra Genesis touches no others: `exolvra:ready` (eligible),
  `exolvra:working` (claimed), `exolvra:review` (PR open, win condition
  met), `exolvra:blocked` (needs a human decision), `exolvra:triage`
  (underspecified). Every transition is reflected in the sticky comment.
- R6. One sticky status comment per run, edited in place — never a new
  comment per round. It carries current phase, the piece table, the round
  log with verdicts and gaps, budget consumed, the C7 heartbeat, and links
  to the branch, the PR, and the progress artifact.
- R7. Per-run `progress.html` at `.exolvra-genesis/runs/<id>/progress.html`,
  rendered from the plugin template and updated every round exactly as an
  interactive run does — same template, same JSON contract, no second
  design.
- R8. A fleet page at `.exolvra-genesis/fleet.html` listing every active and
  recent issue run across repos: repo, issue, title, status, current round,
  last verdict, budget used, PR link. Same template language as the progress
  page.
- R9. A pull request is opened only when the win condition is met. It
  targets the default branch and its body contains the issue link, the bar
  summary, the verdict history, the integrity attestations, and the budget
  consumed. Labels then move to `exolvra:review`.
- R10. On blocked or budget-stop, work is never discarded: push the branch,
  open a draft PR carrying the reason and the progress so far, apply the
  blocked label, and make the sticky comment state exactly what a human must
  decide.
- R11. Exit codes extend the existing contract: 0 when every issue worked
  reached a PR or a clean triage; 1 when at least one was blocked or
  budget-stopped; 2 for usage, configuration, or authentication errors.
- R12. `exolvra-genesis queue` lists eligible and in-flight issues — repo,
  number, title, label state, age — as a table, with `--json` for machine
  output.
- R13. `--dry-run` prints the pickup plan and the spec it would derive for
  each issue, touching no labels, no comments, and no repository.
- R14. Issue runs are recorded in the existing runs store with their issue,
  branch, and PR, so `exolvra-genesis runs` and `exolvra-genesis resume`
  work on them unchanged.
- R15. On interrupt or termination, release the claim: labels return to
  ready when nothing was pushed, or blocked when work exists on a branch;
  the sticky comment is updated, and the exact resume command is printed.
- R16. Ship an example GitHub Actions workflow that runs `exolvra-genesis
  work` on a schedule with a cost cap and a token, so a repo can adopt the
  loop by copying one file.

## Non-goals

- No merging, approving, or auto-closing. The PR queue is the human's.
- No long-lived poller or `--interval` daemon in this version — single-pass
  plus external scheduling covers deployment, and the poller is revisited
  only after the single-pass shape has survived real use.
- No config file of managed repositories — the allowlist is a flag or an
  environment variable, per invocation.
- No hosted service, no web dashboard beyond the local pages.
- No cross-issue dependency ordering, and no issue creation or backlog
  grooming.

## References (bar candidates)

- `bars/cli-ux/` — the committed gh + clack transcript pack — for the
  `work` and `queue` command surfaces (`gh issue list` and `gh pr create`
  are the shape to match).
- A Dependabot pull request body, as the bar for a machine-authored PR that
  a human trusts at a glance: evidence first, structure stable across runs.
- `owainlewis/factory`'s label protocol and safety rules as the structural
  reference for the lifecycle in R5 and the constraints in C4 and C8.
- `templates/progress.html` — the shipped template — as the bar for R7 and
  R8.

## Addendum v0.1.1 — charting joins the effort

`docs/specs/chart-spec.md` folds into this effort: wayfinding the decisions
is the front half of the pipeline whose back half is this runner. What they
share, so neither drifts:

- One label namespace. The runner's lifecycle labels and charting's
  `exolvra:map` / `exolvra:decide` live under the same `exolvra:` prefix,
  and no command of either feature touches a label outside it.
- One network module. Charting's GitHub mode makes every call through the
  single module C2 establishes; it adds no second network path and inherits
  C3's rule that subagents never touch the remote.
- One claim protocol. A charting ticket's claim is the assignee, exactly as
  the runner claims an issue, with the same stale-claim TTL semantics
  (C7 here) applied to decision tickets.
- The pipeline seam: a resolved map hands off as ready-labeled issues (the
  runner's authorization boundary, applied by the human per C5) or as
  goals/specs the runner's issues can reference. Decisions stay HITL;
  execution stays gated on the ready label and on PR review.

Build order within the effort: charting's local mode first (no dependency
on this spec), then this runner, then charting's GitHub mode on the
runner's module. The dogfood is shared: the first map charts this runner's
own build (chart-spec R10).
