---
project: exolvra-genesis
updated: 2026-09-18
updated_by: Claude Code (Opus 5)
health: red
version: v0.13.0
default_branch: main
ci: failing
---

# Exolvra Genesis status

## Latest
- 2026-09-18: 0.13.0 released, the split: this repo keeps the loop, the plane is Evolvlabsai/Exolvra-Plane — cc7e95f, v0.13.0, npm

## Blocked
- None.

## Needs founder
- Cut GitHub Releases for v0.12.0 and v0.13.0 (none cut since v0.8.1)? — on yes: create both from CHANGELOG.md; on no: leave tags only

## In progress
- None.

## Next
- Fix Ubuntu CI: chart.test.js research fan-out test hangs on Linux and cancels the rest; red since 2026-09-17
- Fix Ubuntu flake: trace-liveness "process start time is stable" failed once on 2026-09-18 (fb4e298); passes on Windows
- No new public features planned; loop fixes land here first and merge into the plane (git merge public/main)

## Done
- 2026-09-18: 0.13.0 the split: plane code, specs, models, examples, Dockerfile removed; no network in src/ — cc7e95f — released, npm
- 2026-09-18: READMEs caught up with 0.12.0 — 25d9aab — merged
- 2026-09-18: 0.12.0 durable panel execution: detached commands, persistent queue, --concurrency — fb4e298 — released, npm
- 2026-09-18: preflight probe budget $0.10 → $0.50; verified marker passes on SDK turn limit — fb4e298 — released
- 2026-09-18: first real browser-driven run (wordstats): WIN in 2 rounds, $2.37, survived a panel kill — run r-20260918-1441-7b7de2
- 2026-09-17: 0.11.0 run detail leads with outcome/activity/blocker/next; source-linked evidence — 6f0b7a0 — merged
- 2026-09-17: 0.10.0 ten specs complete and the shared control panel — 13f5c76 — merged

## Risks
- 0.13.0 breaks users of `work`, `queue`, `dashboard` from this package — CHANGELOG states it; ≤0.12.0 on npm still carry them
- Ubuntu CI red means Linux regressions go unseen; only Windows is verified — fix listed under Next
- npm publish needs a browser one-time password; agents cannot release alone — founder runs `npm publish`
- Builders on Windows report absolute paths and inexact commands; the loop corrects it but it costs a round — guard message now says why

## History
- 2026-08: CLI built by its own loop (24 judged rounds); 0.6 bar-integrity hook; 0.7 standards and goals; 0.8.x issue runner, recovery
- 2026-09: ten specs, control panel, run evidence, durable execution, first real run, then the public/private split at 0.13.0
