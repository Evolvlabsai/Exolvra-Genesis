# Changelog

## 0.1.0 — 2026-08-10

- Initial release: `/gauntlet:run` command (runs from a one-line goal or an
  existing spec file, with requirement coverage as a hard gate; prefix the
  arguments with `auto` to skip the bar-approval pause for headless runs),
  `gauntlet-builder` and `gauntlet-critic` subagents (`model: inherit`),
  optional Stop verification gate, README.
- `/gauntlet:interview` — one-question-at-a-time interview that produces a
  run-ready spec plus a single-file interactive mockup (or modifies an
  existing pair); the approved mockup becomes a visual bar candidate.
- Shared progress-page template (`templates/progress.html`): the lead copies
  it at run start and updates only its embedded JSON block, so the live card
  is identical across runs and users.
- Integrity pins, required every round: the spec's sha256 re-verified, bar
  artifacts hash-pinned in `.gauntlet/bar/BAR.md`, and critics isolated to
  temp-directory copies with the repo verified untouched after each session —
  all attested in the progress page's `integrity` footer; any failed check is
  an automatic BLOCKED.
