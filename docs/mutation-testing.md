# Mutation testing in Sackville

> *"Who tests the tests?"* Mutation testing does. This document explains what it
> is, where it came from, and how Sackville's `mutate` pillar drives it across
> JavaScript/TypeScript and Python.

---

## The idea in one paragraph

A passing test suite tells you your tests *ran* and *didn't fail*. It does **not**
tell you they would have *caught a bug* — a test can execute a line and assert
nothing meaningful about it. Mutation testing closes that gap directly: it makes
many small, deliberate edits to your source — each a **mutant** — and re-runs your
suite against each one. If some test fails, the mutant is **killed** (good — your
tests noticed the change). If every test still passes, the mutant **survived** —
proof that *no test pins down the behavior that mutant changed*. The fraction of
mutants your suite kills is the **mutation score**.

Coverage and mutation testing are complementary:

| | Question it answers | Blind spot |
| --- | --- | --- |
| **Coverage** | Did a test *execute* this line? | A line can run without being asserted. |
| **Mutation** | Would a test *notice* if this line's behavior changed? | Slower; some mutants are equivalent (see below). |

A line can be 100% covered and still have zero of its behaviors actually checked.
Mutation testing is the instrument that catches that.

---

## A worked example (from the tutorial)

Sackville's [level-2 tutorial](../examples/tutorial/scheduler/) ships a meeting-room
scheduler with one intentional bug. Its interval-overlap check uses `<` where it
needs `<=`:

```ts
export function overlaps(a: Interval, b: Interval): boolean {
  if (a.end < b.start || b.end < a.start) {   // bug: should be <=
    return false
  }
  return true
}
```

The shipped test suite is **green**, and `src/interval.ts` reads as **fully
covered** — the buggy line runs in several tests. Coverage sees nothing wrong.
But `sackville-cli mutate run` reports survivors:

```
mutation score: 80.0%  (detected 12 / valid 15)
survivors (3):
  src/interval.ts:24  EqualityOperator  [Survived]      a.end <= b.start
  src/interval.ts:24  EqualityOperator  [Survived]      b.end <= a.start
  src/interval.ts:24  ConditionalExpression [Survived]  (drops the 2nd clause)
```

The two `EqualityOperator` survivors flip the boundary comparison `<` ↔ `<=` and
*nothing changes* — the suite never tests two intervals that merely *touch* (one
ends exactly when the next begins). That is the bug **and** the missing test, found
in one shot. Adding a boundary test in both orderings kills all three survivors and
the score goes to 100%. (The third survivor is also legitimate — it reveals the
suite only ever tested one ordering of the two intervals.)

---

## A short history

Mutation testing is one of software engineering's older ideas, dormant for decades
because it was too expensive to run, and revived by cheap compute and better
tooling.

- **1971 — origin.** Richard Lipton, then an undergraduate, proposed the idea in a
  paper titled *"Fault Diagnosis of Computer Programs."* It is the commonly cited
  starting point.
- **1978 — the foundational paper.** DeMillo, Lipton, and Sayward, *"Hints on Test
  Data Selection: Help for the Practicing Programmer"* (IEEE *Computer*), laid the
  theory. It introduced the two assumptions mutation testing still rests on:
  - **The competent programmer hypothesis** — programmers write code that is
    *nearly* correct, so real faults are small deviations from a correct program.
    Mutants (small edits) therefore resemble realistic bugs.
  - **The coupling effect** — test data that distinguishes a program from its
    simple (first-order) mutants also tends to catch more complex, compound faults.
    So killing small mutants buys disproportionate fault-detection.
- **~1980 — early implementations.** Timothy Budd's Yale PhD work formalized and
  implemented the technique; through the 1980s the **Mothra** system (Georgia
  Tech / Purdue; DeMillo, Offutt, King and others) made it a research workbench.
  Jeff Offutt's work over the following decades defined much of the operator theory
  and cost-reduction strategies (selective mutation, mutant sampling).
- **The long winter.** The method is intrinsically costly: *N* mutants each require
  (in the naïve form) a full test run, so a project with thousands of mutants and a
  slow suite faces thousands of suite executions. For most of the 1980s–2000s that
  put it out of reach for everyday use.
- **~2010s — the revival.** Faster machines, parallelism, and—critically—tools that
  prune the work (run only the tests that *cover* a mutant; mutate only *changed*
  code) made it practical:
  - **PIT / pitest** (Henry Coles) brought fast, coverage-guided bytecode mutation
    to the Java world and is largely responsible for the modern resurgence.
  - **Stryker** (JavaScript/TypeScript, also C# and Scala) brought it to the JS
    ecosystem; **mutmut** and **cosmic-ray** brought it to Python; **mull** targets
    LLVM/C/C++.
- **Industrial scale.** Google reported integrating mutation testing into everyday
  code review (Petrović & Ivanković, *"State of Mutation Testing at Google,"*
  ICSE-SEIP 2018) by mutating only the lines in a diff and suppressing unproductive
  mutants — the same **diff-scoping** strategy Sackville uses (see below).

The throughline: the *theory* was settled by 1978; everything since has been about
making it cheap enough to run on every change.

---

## Concepts and caveats worth knowing

- **Mutation operators** are the rules that generate mutants — replace a relational
  operator (`<`→`<=`), an arithmetic operator (`+`→`-`), a boolean literal
  (`true`→`false`), remove a statement, etc. Each tool ships its own operator set.
- **Mutation score** = killed (detected) / valid mutants. It is a *test-quality*
  metric, not a code-quality one: a low score means your tests are weak, regardless
  of whether the code is correct.
- **The equivalent-mutant problem.** Some mutants change the syntax but not the
  behavior (e.g. `x < 10` → `x != 10` inside a loop bounded above by 10). Such a
  mutant can *never* be killed because it is semantically identical to the original,
  yet it drags the score down. Detecting equivalence in general is **undecidable**,
  so every tool produces some unkillable mutants you must judge by hand. Treat the
  score as a signal, not a target to maximize blindly.
- **Cost control is the whole game.** Practical mutation testing leans on
  coverage-guided test selection (only run tests that touch a mutant) and on
  **scoping to the diff** rather than the whole tree.

---

## Mutation testing in Sackville

Sackville's `mutate` pillar lives in **`@sackville-mcp/mutate`**. It is designed
around the same boundaries as the other verification pillars (see
[ADR 0010](./decisions/0010-phase4-cross-cutting-verification.md)): a **pure**
analysis core with no heavyweight dependency, and a **gated, injected** runner for
the part that actually spawns a tool.

### The pure core — `summarizeMutation`

The analysis half reads the **mutation-testing-elements report schema** — the
standard JSON report format (`schemaVersion`, `files[path].mutants[].status`) that
Stryker emits and that the wider ecosystem has adopted. Because the schema is
stable and decoupled from any tool version, `@sackville-mcp/mutate` carries **no
`@stryker-mutator/*` dependency**; `summarizeMutation` is a pure function,
unit-tested against a committed golden report. It computes, exactly per the
schema's definitions:

```
detected   = killed + timeout
undetected = survived + noCoverage
valid      = detected + undetected
mutationScore = detected / valid        (null when there are no valid mutants)
```

…and extracts the **survivor list** (`Survived` + `NoCoverage` mutants, by file and
line) — the actionable "go fix your tests here" output. Mutant statuses follow the
schema: `Killed`, `Survived`, `NoCoverage`, `Timeout`, `CompileError`,
`RuntimeError`, `Ignored`, `Pending`.

### The engines — three, gated and injected

Sackville does not bundle a mutation engine; it drives the **operator's local**
tool through an injected runner, so the green gate never spawns one (the runs are
slow and non-deterministic). Three engines are wired:

| Engine | Language | Sackville runner |
| --- | --- | --- |
| **Stryker** | JavaScript / TypeScript | `runMutation` |
| **mutmut** | Python | `runMutmut` |
| **cosmic-ray** | Python | `runCosmicRay` |

All three are **diff-scoped**: given the changed source files, `runMutation` passes
Stryker `--mutate`, and the Python runners synthesize a scoped config — so a change
mutates only what it touched, mirroring Google's diff-based approach. A mutation run
is **deny-by-default**: it runs only behind an explicit operator gate (`--allow-run`
on the CLI; `SACKVILLE_MUTATE_ALLOW_RUN` + an allowlisted project root for the
server), because it executes your code repeatedly.

### How it surfaces

- **CLI:**
  - `sackville-cli mutate summarize <report.json>` — a pure report viewer (no run).
  - `sackville-cli mutate run <project-root> --allow-run [--file <f>…] [--tool stryker|mutmut|cosmic-ray]`
    — drive the engine, scope to files, print score + survivors.
- **MCP tools:** `mutate_summarize` and `mutate_run` (with `tool: stryker | mutmut |
  cosmic-ray`), for an agent to drive directly.
- **In the verdict:** the `verify` pillar folds a mutation summary via
  `fromMutationSummary` — **surviving mutants ⇒ `warn`** (a real test gap), a run
  with **no valid mutants ⇒ `no-signal` ⇒ inconclusive** (absence is never a pass),
  and **all mutants killed ⇒ `pass`**. Note that, as with every pillar, a single
  pillar's `pass` does not by itself make the composite verdict green — see the
  [tutorial's verify step](../examples/tutorial/scheduler/README.md#6-prove-the-change--one-verdict).

### Try it

The fastest way to see a surviving mutant and kill it is the
[level-2 tutorial](../examples/tutorial/scheduler/) — it walks find → fix → prove
on the `overlaps` bug above, first with the CLI and then through the MCP server.

---

## References

- R. J. Lipton, *Fault Diagnosis of Computer Programs* (1971) — the originating idea.
- R. A. DeMillo, R. J. Lipton, F. G. Sayward, *Hints on Test Data Selection: Help
  for the Practicing Programmer*, IEEE *Computer* 11(4), 1978 — competent-programmer
  hypothesis + coupling effect.
- G. Petrović, M. Ivanković, *State of Mutation Testing at Google*, ICSE-SEIP 2018 —
  diff-scoped mutation testing at industrial scale.
- [Stryker](https://stryker-mutator.io/) · [mutmut](https://mutmut.readthedocs.io/) ·
  [cosmic-ray](https://cosmic-ray.readthedocs.io/) · [PIT/pitest](https://pitest.org/)
- Sackville internals: [ADR 0010 — cross-cutting verification](./decisions/0010-phase4-cross-cutting-verification.md);
  the `@sackville-mcp/mutate` package; `summarizeMutation` (the pure core).
