# Contributing

Exolvra Genesis is deliberately small. Before adding anything, read "What it
is not" in the README — changes that turn it into a framework will be
declined, however good they are.

Three things to know:

1. **The Markdown is load-bearing.** `commands/*.md` and `agents/*.md` are the
   loop's implementation, not its documentation — a wording change is a
   behavior change. The CLI loads these files verbatim at runtime and must
   never restate them (constraint C3 in `cli/cli-spec.md`).
2. **The suite is the gate.** For any CLI change: `cd cli && npm install &&
   npm run build && npm run typecheck && npm test` must end green. Tests may
   fake exactly one thing — the Claude Agent SDK behind `src/session.ts`.
   Everything else runs for real.
3. **Substantial changes go through the loop.** The CLI in this repo was built
   by the loop it implements, judged blind against `gh` and `@clack/prompts`
   transcripts until it won twice in a row. If you're proposing a significant
   feature, expect it to be held to the same kind of bar: real output, real
   verification, evidence over claims.

Bugs and ideas: [open an issue](https://github.com/Evolvlabsai/Exolvra-Genesis/issues)
with what you observed, the exact command, and what the bar (gh, clack, or the
spec) does differently.
