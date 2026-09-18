# Genesis control panel

This addendum implements the owner's September 17, 2026 request for a control
panel similar to the supplied Warren screenshots, able to view, monitor and
execute Genesis. It extends the earlier live-status web-server non-goal with
one explicit HTTP listener. The owner clarified shared team/server access and
portable deployment styles for this public open-source project. Existing orchestration contracts stay in
their Markdown sources.

## Requirements

1. `dashboard [-C dir] [--port port] [--host address] [--public-url origin] [--open]`
   serves an installed-package UI, prints its address and shuts down on interrupt. Help and bad
   flags must not start a listener. The frontend ships in the npm package.
2. Match the reference's near-black surfaces, persistent navigation, health
   strip, compact tables, muted metadata and restrained status colors. Provide
   responsive layouts, keyboard navigation, labeled inputs, focus indication,
   useful empty states and visible connection or command errors.
3. Read real project registries, ledgers, state, traces and plugin definitions.
   Offer operations, runs and run detail, planning output, projects, agents,
   measured usage, cross-project events and local diagnostics. No fabricated
   work, success state, cost or event data.
4. Refresh live records without resetting filters, forms or event pagination.
   Events support stable sequence cursors, earlier pages and tail updates.
   Show missing/degraded records explicitly. Dollar totals use exact available
   provider receipts; unavailable nested splits remain labeled unavailable.
5. Launch run, plan, resume, stop, read-only doctor and local AFK chart commands
   through the real CLI, with validated arguments and no shell interpolation.
   Persist bounded, scrubbed command output and status. Prevent duplicate work
   in a project, including the interval before a run ID is assigned. Shutdown
   requests settling only for commands owned by the panel.
6. Register existing local directories, persist the selection, and remove only
   the registration. Preserve all existing project artifacts. Never remove a
   registration while its work is active.
7. Validate Host/Origin and require a browser session's CSRF token on mutations.
   Keep secrets scrubbed, payloads bounded, artifact names allowlisted and paths
   confined to the project. Model-authored HTML must never run in the panel's
   privileged origin. No provider calls or arbitrary shell commands on page load.
8. Add no runtime dependencies. Permit Node's inbound HTTP server import only
   in `panel-server.ts`; the existing outbound GitHub boundary stays unchanged.
   Tests exercise actual HTTP, files, subprocesses and packaged assets, with
   only the external SDK substituted for model-backed execution scenarios.
   The owned child launcher may bridge its own display pipes when a panel exits;
   parent commands continue to write through the CLI context streams.
9. Keep loopback use available without a separate login. Shared access requires
   a configured access key and HTTPS public origin. Exchange the access key for
   an expiring HttpOnly, SameSite browser cookie; set Secure behind HTTPS, bind
   CSRF to each session, and revoke only the signing-out member's session.
   Reject unauthenticated evidence and command requests. Never persist the key
   in the browser or pass it into child agent environments. Rate-limit failed
   login attempts without locking valid members out behind a shared proxy.
10. Keep deployment configurable. Provide direct Node instructions and portable
    container, reverse-proxy and service examples without coupling the app to
    a particular hostname, cloud provider or production machine.
11. Run detail leads with the recorded outcome, current or last observed
    activity, blocking context when available, and a next action permitted by
    existing run controls. Earlier recovered errors must not become the reason
    for a later stop or block, and a complete run must not display an old blocker.
12. Present recorded changed files, verification output, guard checks and critic
    findings with their exact trace sources. Distinguish observed filesystem
    changes, builder claims and actual command results. Missing or unattributed
    evidence stays explicit; a generic shell command is not automatically a
    verification pass. Reading the page never executes commands or derives
    historical changes from the current working tree.
13. Compare rounds within the same piece using recorded candidate identities,
    file lists and findings. File-list differences do not mean files were
    created or deleted. A finding absent from a later report is not proof of a
    fix. Event pagination must not hide older evidence from these comparisons;
    bounded or degraded projections explain any missing coverage.
14. Keep evidence, round history and raw events easy to navigate on desktop and
    mobile in either theme. Preserve the selected view and expanded evidence
    through polling. Source links open the specific recorded event even when
    that event is outside the currently loaded event page.

## Scope

Authenticated members share operator authority over registered server projects.
Per-person accounts, role-based permissions, SSO, interactive interviews and
GitHub issue-runner administration are outside this control-panel increment.
Existing CLI workflows remain available from the terminal. Deployment examples
are reviewable artifacts; no particular production instance is deployed.

## Addendum A — Durable execution (0.12.0)

- A1. Commands the panel starts are detached from the dashboard process. They
  continue when the dashboard stops for any reason. Their output and exit
  receipt are written by the command's launcher into
  `.exolvra-genesis/control-panel/jobs/`, never by the dashboard.
- A2. A restarted dashboard adopts recorded commands: it folds in later
  output from the exact byte where the previous dashboard stopped, verifies
  process identity (PID plus start time) before trusting a PID, settles on the
  exit receipt's real code, and can still request a stop. A process gone
  without a matching receipt is reported as interrupted.
- A3. Paid commands wait in a persistent queue recorded with the exact
  arguments they were accepted with. One paid command runs per project at a
  time; `--concurrency` bounds paid commands across projects (default 1).
  Arrival order survives restarts. Queued commands can be cancelled; running
  commands are stopped, never cancelled. Read-only and control commands never
  queue.
- A4. The dashboard reports the commands that continue when it exits. The
  panel never kills a command it started.
