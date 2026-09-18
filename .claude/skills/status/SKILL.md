---
name: status
description: Maintain the repository's STATUS.md — the fixed-shape status file an external chief-of-staff agent reads to brief the founder. Applies to every session; update it in the same commit as the work and before the final message.
---

## Maintain STATUS.md

This repo keeps a `STATUS.md` at the root. It is read by an external chief-of-staff agent that briefs the founder, so its shape is fixed and its contents must be true. You maintain it; you do not redesign it.

### When to update

Update `STATUS.md` in the same commit or PR as the work, at every one of these points:

- End of every session, before your final message, even if the session changed nothing (bump `updated` and say so under Latest).
- After any merge to the default branch.
- After a release, deploy, or version bump.
- When a blocker appears or clears.
- When a decision is made that changes scope, stack, or priority.

If you cannot write the file (read-only session, no repo access), say so explicitly in your final message with the lines that should have changed.

### Rules

1. Facts only. Every line must be verifiable from git history, CI, an issue tracker, or a file in the repo. Write what happened, not what is planned to happen, except under Next, and label plans there as plans.
2. Derive from the repo, not from memory. Before writing, run `git log --since=<previous updated date> --oneline`, check CI status, and diff the working tree. Do not carry forward a line you cannot re-verify; delete it or move it to Done with its date.
3. Dates on everything. ISO dates (`2026-09-14`). No "recently", "soon", "this week".
4. Keep headings exactly as in the template, in the same order, even when a section is empty (write `None.`). The reader parses by heading.
5. Never delete history. Done items stay under Done for 30 days, then roll into one line under History.
6. Short. Each bullet one line, under 140 characters. Whole file under 120 lines. Trim Done and History before Blocked or Next.
7. Health is computed, not felt: `green` = CI passing on default branch and nothing under Blocked; `amber` = CI passing but something under Blocked, or CI unknown; `red` = CI failing on default branch or a blocker older than 7 days.
8. Blocked means "cannot proceed without something outside this repo": a decision, a credential, a third-party, a person. Everything else is Next.
9. Needs-founder lines are questions or approvals only, phrased so a yes/no or short answer resolves them. Include what you will do on each answer.
10. Do not put secrets, tokens, customer names, or private URLs in this file. It leaves the repo.

### Template

Replace the front matter values and every bracketed item. Keep everything else verbatim.

```markdown
---
project: <slug matching the COS projects.yaml id>
updated: 2026-09-14
updated_by: <agent name or "founder">
health: green | amber | red
version: <current version or tag, or "unreleased">
default_branch: main
ci: passing | failing | unknown
---

# <Project name> status

## Latest
- 2026-09-14: <one line, what changed most recently, with PR or commit ref>

## Blocked
- <thing that cannot proceed> — needs <what, from whom> — since 2026-09-10

## Needs founder
- <question or approval> — on yes: <what you will do>; on no: <what you will do>

## In progress
- <work item> — <branch or PR> — started 2026-09-12

## Next
- <planned item, in priority order, plan not promise>

## Done
- 2026-09-13: <shipped thing> — <PR #> — merged
- 2026-09-11: <shipped thing> — <PR #> — released in v0.4.0

## Risks
- <known risk or debt that could bite> — <mitigation or none>

## History
- 2026-08: <one-line rollup of the month>
```

### Before you finish

Run this check and fix anything it flags:

- Front matter parses as YAML and every key is present.
- `updated` is today.
- Headings match the template exactly, in order, none missing.
- Every bullet under Latest, Done, and History has a date.
- Nothing under Blocked is older than 7 days without a Needs-founder line asking for help.
- `health` matches rule 7.
- File is under 120 lines.

Then commit with message `status: <one line>` alongside the work, or as its own commit if the session changed nothing else.
