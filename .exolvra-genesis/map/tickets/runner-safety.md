# Locate the runner's safety boundaries

Type: research
Status: closed
Mode: AFK
Blocked by: none
Claim: none

## Question

Which existing requirements and modules constrain the issue-runner build so
charting can hand it consistent inputs?

## Answer

Source inspection on 2026-09-17 found the runner already implemented and its
build contract defined in [the issue-runner spec](../../../docs/specs/issue-runner-spec.md).
The ready label and repository allowlist are defined in
[allowlist.ts](../../../cli/src/allowlist.ts). GitHub requests, host validation,
token resolution and redaction live in [github.ts](../../../cli/src/github.ts).
Branch naming and default/protected branch checks live in
[git.ts](../../../cli/src/git.ts). The work command and
[issue-run.ts](../../../cli/src/issue-run.ts) provide the issue lifecycle.

The build-ready input is therefore the existing spec plus repository standards;
charting should not invent alternate ownership, lifecycle labels or a second
network stack. This records verified implementation facts, not authorization
to run against any real repository. Live adoption remains a human decision in
[Choose the first live runner scope](first-live-scope.md).
