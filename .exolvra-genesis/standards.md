# Standards

Exolvra Genesis is an adversarial orchestration loop for Claude Code: plain
Markdown that is the loop itself, plus a TypeScript CLI in cli/ that runs
the same loop from a terminal without opening Claude Code.

## Gates

- G1. The full suite passes: `cd cli && npm test` — 682 tests, none
  skipped.
- G2. One version moves together in .claude-plugin/plugin.json,
  .claude-plugin/marketplace.json, CHANGELOG.md and cli/package.json.
- G3. Runtime dependencies are exactly @anthropic-ai/claude-agent-sdk and
  @clack/prompts.
- G4. No file under cli/src restates a sentence of the plugin markdown:
  the loop is loaded from disk at runtime, never reimplemented.
- G5. Every value-taking flag declares the value type that validates it,
  or cli/test/validation-gate.test.js fails it.
- G6. The Task Spec and Report contracts read the same in commands/run.md,
  agents/builder.md and agents/critic.md.

## Standing bar

- `bars/cli-ux/gh/root-help.txt` — the shape every help page here is
  judged against: sections, one aligned description column
- `bars/cli-ux/gh/usage-error.txt` — the shape every error carries: the
  complaint, an indented detail, then the usage line
- `bars/cli-ux/clack/frames-plain.txt` — the frames every interactive flow
  is drawn to, glyphs and rails included
- 682 tests — the suite the CLI ships green; a round that drops one has
  lost something

## Conventions

Plain-text edits on source files, never regex splices across lines — two
incidents of deleted code came from those. Commands self-register from
cli/src/commands/, so adding one is adding a file and cli.ts stays
zero-diff. Model output is untrusted renderer input: flatten it before it is
measured or drawn. The bar is an artifact or a number, never an adjective.
