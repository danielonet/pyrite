# Front-end migration: translate from the tree-sitter syntax tree

**Status: planned, not started.** Pick this up when the regex front end starts
producing wrong *expressions* on real projects. Structure is already safe:
the corpus test translates the whole Python standard library with no crash,
balanced braces and no lost definitions.

Written for whoever picks this up later, including an AI session starting
with no context. Read [tree-sitter.md](tree-sitter.md) first for what is
already wired in.

## 1. The problem in one paragraph

The rules engine has two halves. The **back end** writes Java: the module
class, Javadoc, Lombok annotations, the source map, symbols for Go to
Definition. The **front end** decides what each piece of Python *is*. Today
the front end never builds a syntax tree. It splits the file into logical
lines (`splitLogicalLines`), hides string literals behind placeholders
(`maskStrings`), and matches statements and expressions with regular
expressions. Each bug fixed so far came from that guessing: a colon inside a
string, a comment inside a list literal, `*/` in a docstring, a one-line
`except: pass`, nested calls split at the wrong comma. The plan is to feed
the existing back end from a real syntax tree instead.

## 2. Goals and non-goals

Goals:

- Statements, signatures, expressions and types come from tree-sitter nodes.
- Output is unchanged wherever the old engine was already right. Every
  intended change is visible in a snapshot diff.
- Every step ships on its own and leaves all tests green.
- The old front end stays available as a fallback until the new one is proven.

Non-goals:

- No change to the Java style, Javadoc rules, Lombok rules or file naming.
- No compile-ready Java. The output stays a reading aid.
- No full type checker. Type inference stays best effort.
- No LLM involvement. That is a separate plan in [llm-engine.md](llm-engine.md).

## 3. Where things are today

| Concern | File | Key entry points |
| --- | --- | --- |
| Parser, WebAssembly | `src/parser/pythonParser.ts` | `pythonParser()`, `parsePython()`, `syntaxIssues()`, `definitions()` |
| Logical lines | `src/translator/rules/logicalLines.ts` | `splitLogicalLines()` |
| String masking, f-strings | `src/translator/rules/strings.ts` | `maskStrings()`, `unmaskStrings()`, `renderLiteral()`, `renderFString()` |
| Statement dispatch and emit | `src/translator/rules/ruleTranslator.ts` | `translate()`, `translateCode()`, `translateStatement()`, `translateClass()`, `translateDef()`, `translateFor()`, `translateWith()`, `translateSimple()`, `translateAssignment()`, `assemble()` |
| Lombok planning | `ruleTranslator.ts` | `buildLombokPlan()` |
| Expressions | `src/translator/rules/expressions.ts` | `translateMaskedExpression()`, `translateExpression()` |
| Builtin calls | `src/translator/rules/builtins.ts` | `rewriteBuiltinCalls()`, `rewriteOrFallback()`, `streamOf()` |
| Type hints | `src/translator/rules/typeHints.ts` | `translateType()`, `splitTopLevel()` |
| Member scan, cross-file types | `src/translator/rules/members.ts` | `scanMembers()`, `collectSelfFields()`, `knownMembersOf()`, `mergeKnownMembers()` |
| Type environment | `ruleTranslator.ts` | `typeOf()`, `returnTypeOf()`, `fieldTypeOf()`, `lookupName()` |
| Javadoc text | `src/translator/rules/javadoc.ts` | unchanged by this plan |

Tests that act as the safety net:

- `src/test/rules.test.ts`: about 60 unit and regression tests on exact output.
- `src/test/corpus.test.ts`: the sample-project snapshot under
  `src/test/snapshots/`, and the corpus run. The corpus must not throw, must
  emit balanced braces, must stay under three seconds per file, and must keep
  every class and function the parser sees.
- `src/test/backgroundMirror.test.ts` and `definitionIndex.test.ts`: the
  mirror and navigation around the translator.

## 4. Design decisions to make first

Settle these before writing code. Each has a recommended answer.

1. **Sync or async.** `Parser.init()` and `Language.load()` are async, but
   `translateWithRules()` is sync and is used by the tests and the CLI's
   `--file` mode. Recommendation: load the parser once up front, with
   `await pythonParser()`, then call `parser.parse()` synchronously. The
   translator takes the parsed `Tree` as an optional input. `RuleBasedTranslator.translate()`
   is already async and can do the loading. The worker thread loads its own
   parser, since WebAssembly instances are per thread.

2. **Switch between front ends.** Add an internal option
   `frontEnd: 'lines' | 'tree'` on `TranslateInput`, plus the environment
   variable `PYRITE_FRONTEND` for tests and the CLI. Do not expose it as a
   user setting. Default to `lines` until step 5, then to `tree`.

3. **Files with syntax errors.** tree-sitter still returns a tree, with error
   nodes (`node.isError`, `node.isMissing`). Recommendation: when
   `tree.rootNode.hasError` is true, translate that file with the old line
   front end. The existing warning header is kept. Revisit only after the
   old front end is deleted.

4. **Comments.** tree-sitter puts `comment` nodes anywhere, including inside
   argument lists and between a block's header and body. Recommendation:
   collect every comment node with its row, and flush comments whose row is
   before the statement being emitted. This reproduces today's
   "comment above the statement" behaviour, including for comments inside
   multi-line literals.

5. **Source map.** Use `node.startPosition.row + 1` wherever the old code
   used `LogicalLine.startLine`. `assemble()` already expands multi-line
   emitted text to one map entry per physical line, so it needs no change.

6. **Where expression output is built.** Recommendation: a new
   `src/translator/tree/` folder next to `rules/`, and no masking at all in
   the new path. A tree node's text is exact, so string contents never need
   hiding.

## 5. Steps

Each step lists what to build, what it replaces, and when it is done.
Estimates assume a working session like the ones that built this project:
an AI doing the edits, a human reviewing snapshot diffs.

### Step 0: differential harness (about a quarter of a session)

Build the tool that makes every later step safe.

- Add `src/test/frontEndDiff.test.ts`. For each corpus file, translate with
  `frontEnd: 'lines'` and `frontEnd: 'tree'`, then report files whose output
  differs. The first differing line of each file goes in the report.
- Run it only when `PYRITE_FRONTEND_DIFF=1` is set, so `npm test` stays fast.
- Record the number of differing files after each step in this document.

Done when: the harness runs, and with `tree` still delegating to `lines`, it
reports zero differences.

### Step 1: statements and blocks (about 1 session)

Replace the logical-line walk and the indent stack with a walk over the tree.

- New `src/translator/tree/walker.ts` visits `module` and `block` children in
  order and calls the existing emit helpers. Push and pop `Block` entries on
  entering and leaving a node, not by comparing indentation.
- Map node types to today's handlers: `if_statement` with `elif_clause` and
  `else_clause`, `for_statement`, `while_statement`, `try_statement` with
  `except_clause` and `finally_clause`, `with_statement` with `with_item`,
  `match_statement` with `case_clause`, `decorated_definition`,
  `class_definition`, `function_definition`, `expression_statement`,
  `return_statement`, `raise_statement`, `assert_statement`,
  `delete_statement`, `global_statement`, `nonlocal_statement`,
  `pass_statement`, `import_statement`, `import_from_statement`,
  `future_import_statement`. `except*` has no node type of its own in this
  grammar version, so check the clause's children for the `*` token.
- For this step, pass each statement's **text** into the existing
  `translateSimple()`, `translateAssignment()` and expression functions. Only
  the structure comes from the tree.
- Delete the workarounds this makes unnecessary: `splitOneLineCompound()`,
  `inlineBody`, `skipUntilIndentBelow()`, `bodyLines()`, `indentUnit()`,
  `closeBlocksTo()` and the one-liner handling in `docstringAfter()` and
  `inferReturnType()`.
- A docstring is the first `expression_statement` in a `block` whose only
  child is a `string`.
- A loop or `try` with an `else` is now explicit in the tree, so
  `lastClosedKind` goes away.

Done when: all unit tests pass under `PYRITE_FRONTEND=tree`, the snapshot is
unchanged, and the differential harness reports no structural differences.
Differences in comment placement are acceptable if they look better, and each
is noted in the snapshot update.

### Step 2: signatures (about 1 session)

Read classes and functions from their fields instead of re-parsing header
text.

- `class_definition` fields: `name`, `superclasses` (an `argument_list`, where
  `metaclass=` is a `keyword_argument`), `type_parameters`, `body`.
- `function_definition` fields: `name`, `parameters`, `return_type`,
  `type_parameters`, `body`. `async` is a child token.
- Parameter nodes: `identifier`, `typed_parameter`, `default_parameter`,
  `typed_default_parameter`, `list_splat_pattern` for `*args`,
  `dictionary_splat_pattern` for `**kwargs`, `keyword_separator` for a bare
  `*`, `positional_separator` for `/`.
- Decorators come from the `decorator` children of `decorated_definition`,
  so `pendingDecorators` goes away.
- Rewrite `buildLombokPlan()` and `members.ts` so they take class nodes.
  `collectSelfFields()` finds `assignment` nodes whose left side is an
  `attribute` on `self`, anywhere under the class body.
- Delete `typeParamsOf()`, the `def` and `class` regexes in
  `translateStatement()`, and the parameter regexes in `translateDef()` and
  `paramTypesOf()`.

Done when: the Lombok tests and the property, type and cross-file tests pass
on `tree`, and the snapshot is unchanged.

### Step 3: expressions (2 to 3 sessions, the main value)

Replace string rewriting with a recursive emitter over expression nodes.
This is where operator precedence, nesting and string edge cases become
correct by construction.

- New `src/translator/tree/expressions.ts` with
  `emitExpression(node, ctx): string`, one case per node type:
  - Atoms: `identifier`, `integer`, `float`, `true`, `false`, `none`,
    `string` (including its `interpolation` and `format_specifier`
    children), `concatenated_string`.
  - Operators: `binary_operator` (`**` to `Math.pow`, `//` to
    `Math.floorDiv`), `unary_operator`, `boolean_operator`, `not_operator`,
    `comparison_operator` (chained `a < b < c` becomes `a < b && b < c`; `in`
    and `not in` become `contains`; `is` and `is not` become `==` and `!=`),
    `conditional_expression`, `named_expression`.
  - Access: `attribute` (property accessors and field renames happen here,
    not as a regex over output), `subscript` with `slice`, `call` with
    `argument_list` and `keyword_argument`.
  - Collections: `list`, `tuple`, `set`, `dictionary`, `list_comprehension`,
    `set_comprehension`, `dictionary_comprehension`, `generator_expression`,
    each with `for_in_clause` and `if_clause`. Nested `for` clauses become
    `flatMap`.
  - Other: `lambda`, `await`, `yield`, `parenthesized_expression`, `splat`.
- Wrap in parentheses based on the **node's context**, not on whether the
  text looks simple. For example, wrap a `binary_operator` operand when the
  parent's precedence is higher.
- Port `builtins.ts` to a table keyed by the callee identifier, taking
  already-emitted argument strings plus the argument nodes, so keyword
  arguments and literal checks are exact. Keep the rule outputs unchanged.
- `a or b` in value position becomes a check on the `boolean_operator`
  node's parent: `assignment`, `return_statement`, `keyword_argument`.
- Assignment targets come from the tree: `pattern_list` and `tuple_pattern`
  for unpacking, `subscript` for `put`, `attribute` for setters.
- Delete when done: `maskStrings()` and `unmaskStrings()` from the
  translation path, keeping `renderLiteral()` logic for Java string escaping;
  `translateMaskedExpression()`; the regex tables in `expressions.ts`;
  `splitTopLevel()` except inside `translateType()`; and
  `setFStringExpressionContext()`.

Done when: every expression unit test passes on `tree`, the snapshot diff
contains only intended improvements, and the differential harness shows no
file where `tree` output is worse. Add a unit test for each improvement found.

Suggested order inside the step, one commit each: atoms and operators, then
calls and attributes, then collections and comprehensions, then f-strings,
then assignments.

### Step 4: types on real scopes (about 1 session)

- `translateType()` takes a type node, meaning the `type` field of
  parameters, `return_type` and annotations, instead of hint text.
- The member scan becomes a tree query in `members.ts`, keeping the same
  `KnownMembers` output so `members.json` and cross-file behaviour do not
  change.
- `typeOf()` takes an expression node. Scopes come from the walk: function,
  class, and comprehension, where a comprehension variable no longer leaks
  into the function scope.
- Delete `inferTypeFromMaskedValue()` in favour of a node-based version.

Done when: all type tests pass on `tree` and the snapshot is unchanged or
improved.

### Step 5: switch over and remove the old front end (about half a session)

- Make `tree` the default and run the full corpus with
  `PYRITE_CORPUS_ALL=1`.
- Keep the `lines` front end for one release, used only for files whose tree
  has errors (decision 3).
- Then delete `logicalLines.ts`, the masking in `strings.ts`, the regex
  expression code, and the `frontEnd` option. Keep the `hasError` fallback
  only if the error-tolerant tree emission is not good enough by then.
- Update [tree-sitter.md](tree-sitter.md) and [phase-1.md](phase-1.md).

Done when: the old front end is gone, all tests pass, and the full corpus is
green.

## 6. Total effort

| Step | Sessions |
| --- | --- |
| 0. Differential harness | 0.25 |
| 1. Statements and blocks | 1 |
| 2. Signatures | 1 |
| 3. Expressions | 2 to 3 |
| 4. Types on real scopes | 1 |
| 5. Switch over and clean up | 0.5 |
| **Total** | **about 6** |

A developer without AI help should plan for two to four weeks.

## 7. Risks and how to handle them

- **Snapshot churn hides regressions.** Update snapshots in small commits,
  one step or sub-step at a time, and read every diff. Never refresh
  snapshots in the same commit as unrelated changes.
- **Worse output on some files.** The differential harness is the guard.
  A file that gets worse either gets a fix or stays on `lines` until it does.
- **Performance.** Parsing is fast, but a naive recursive emitter on a huge
  literal can still be slow. The corpus test's three-second limit catches
  this. `locale.py` in the standard library, with a 33 KB dict literal, is
  the known stress case.
- **Packaging.** The two `.wasm` files must ship in the VSIX. Check with
  `npx @vscode/vsce ls | grep wasm` after dependency changes. If the
  extension is ever bundled, see the packaging notes in
  [tree-sitter.md](tree-sitter.md).
- **Grammar upgrades.** Pin `tree-sitter-python` and `web-tree-sitter` to
  exact versions during the migration, since `package.json` currently allows
  minor updates. Node type names can change between grammar releases. Before
  relying on a node type, check it in
  `node_modules/tree-sitter-python/src/node-types.json`.

## 8. Checklist for starting a session on this

1. Read this file and [tree-sitter.md](tree-sitter.md).
2. Run `npm test` and confirm it is green before changing anything.
3. Find the first unfinished step below and continue from there.
4. Before ending the session, run `npm test`, run
   `PYRITE_CORPUS_ALL=1 node --test out/test/corpus.test.js`, update the
   progress log, and commit.

## 9. Progress log

| Date | Step | Differing corpus files | Notes |
| --- | --- | --- | --- |
| | not started | | |
