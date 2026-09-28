---
paths:
  - "docs/**"
  - "AGENTS.md"
  - ".agents/**/*.md"
---

# Documentation Rule

Pointers only; the linked documents own the rules. An example of a path-scoped rule: copy its shape for each area of your repository that needs one.

- The harness sources, their adapters and their size caps: [agent harness standard](../../docs/agent-harness.md#sources-and-adapters). Edit `.agents/`, never `.claude/` or `.codex/`, then run `node .agents/sync-adapters.mjs`.
- Keep one owner per fact: link to the document that owns a rule instead of restating it.
- When a document and the code disagree about current behaviour, the code wins and the document is the defect.
