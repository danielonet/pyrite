# Architecture notes

Design records for Pyrite that don't belong in the user-facing
[README](../README.md).

- [phase-1.md](phase-1.md) — the read-only mirror: what's actually
  implemented today.
- [phase-2.md](phase-2.md) — roadmap: editing the Java view and syncing
  changes back to Python. Not implemented.
- [llm-engine.md](llm-engine.md) — the `llm` translation engine: removed
  from the codebase, concept and full design preserved here for reuse
  (Phase 2 needs the same mechanism) or reinstatement.
- [tree-sitter.md](tree-sitter.md): the real Python parser now used for syntax checking and as a test oracle, and the plan to move the translator front end onto it.
- [frontend-migration.md](frontend-migration.md): the step-by-step plan for translating from the tree-sitter syntax tree instead of regular expressions. Not started.
