# Phase 2 — edit the Java view, sync back (not implemented)

Roadmap only. No code exists for this yet; [phase-1.md](phase-1.md) covers
what is actually shipped today.

## Goal

Let a Java developer edit the generated Java-flavored view directly, and
turn those edits back into the real Python source — so "reading as Java"
can grow into "steering the Python project from a Java-shaped view" without
ever hand-writing Python.

## Intended design

- **Function-level, not whole-file.** A whole-file round trip (Java view →
  Python) is lossy and would produce noisy, hard-to-review diffs. Instead,
  detect which methods/functions changed in the Java view (using the same
  source map from [phase-1.md](phase-1.md) to know which Python
  function each edited region maps to).
- **LLM-translated, with the original as context.** For each changed
  method, ask an LLM to translate just that method back to Python, giving it
  the original Python function as context so it preserves everything it
  isn't asked to change. This reuses the "pull the plug" LLM engine
  described in [llm-engine.md](llm-engine.md) — Phase 2 is the reason that
  engine existed at all; the Java-flavored *reading* view was a stepping
  stone toward this.
- **Approval-gated.** Never write to the Python source directly. Show the
  resulting Python diff (per function) for review, same as any AI-authored
  change, before it's applied. This is the same "Supervised Development, not
  vibe coding" principle the whole project is built around (see the
  top-level README): the developer reads and approves every change at the
  Python level, even though they authored it by editing Java.

## Open questions (unresolved, for whoever picks this up)

- How to detect "this method changed" robustly across re-generations of the
  Java view (diffing against the last-generated `.java-view` copy vs. a
  stored snapshot).
- What happens when an edit doesn't map cleanly to one Python function
  (renamed method, split/merged methods, edits that span a class boundary).
- Whether partial acceptance (approve some changed methods, reject others)
  is needed for the first version, or whether it can start all-or-nothing
  per file.
- Conflict handling when the Python source changed (e.g. someone else's
  commit) since the Java view was last generated.
