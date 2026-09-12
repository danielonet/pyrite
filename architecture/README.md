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
