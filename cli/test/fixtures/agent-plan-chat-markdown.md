---

## Preview Summary

### Bar
**GitHub CLI (`gh`) Markdown rendering**: styled terminal output with 80-column discipline, word-wrap at boundaries, ANSI styling for headings/emphasis/code, proper list and blockquote indentation.

### Critic Comparison Method
Render each test Markdown file at 80 columns, then:
1. Strip ANSI codes and verify no visible line exceeds 80 characters
2. Confirm words are never broken mid-word
3. Visually compare element styling (headings bold, code distinct, lists aligned, blockquotes indented) against the `gh` rendering spec

### Task Specs

| # | Task | Files Owned | Parallel Group |
|---|------|-------------|----------------|
| 1 | **Markdown Parser** — CommonMark to AST | `src/parser.ts`, `src/types.ts` | A |
| 2 | **Word Wrapper** — ANSI-aware column wrapping | `src/wrapper.ts` | A |
| 3 | **ANSI Styling** — Bold/italic/color module | `src/ansi.ts` | A |
| 4 | **AST Renderer** — AST to styled terminal output | `src/renderer.ts` | B (depends on 1,2,3) |
| 5 | **CLI Interface** — File/stdin input, width flags | `src/cli.ts`, `src/index.ts`, `package.json` | C (depends on 4) |
| 6 | **Verification Tooling** — Column checker, ANSI stripper | `src/verify-columns.js`, `src/strip-ansi.js`, `src/test-runner.js` | A |

**Hard Gates** (automatic LOSS):
- No visible line >80 chars (ANSI excluded)
- Words never split mid-word
- All ANSI styles reset properly
- CLI must not crash on any test input

---

Reply **"go"** to start the build loop.
