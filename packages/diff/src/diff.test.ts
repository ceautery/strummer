import { describe, expect, it } from 'vitest'
import { changedFiles, parseUnifiedDiff } from './diff.js'

/** Find the entry for a path (paths are returned sorted). */
const lines = (out: { path: string; addedLines: number[] }[], path: string) =>
  out.find((f) => f.path === path)?.addedLines

describe('parseUnifiedDiff — extract added (new-side) line numbers from a unified diff', () => {
  it('tracks new-side line numbers across context, additions, and removals', () => {
    const diff = `diff --git a/src/math.ts b/src/math.ts
index 1111111..2222222 100644
--- a/src/math.ts
+++ b/src/math.ts
@@ -1,4 +1,5 @@
 export function add(a: number, b: number) {
-  return a + b
+  return a + b // fixed
+  // a new comment line
 }
 export const PI = 3.14
`
    // hunk new-start = 1: line1 context (1), removed (no new line), +line2, +line3, context (4)...
    expect(lines(parseUnifiedDiff(diff), 'src/math.ts')).toEqual([2, 3])
  })

  it('handles multiple hunks in one file, each starting at its own new-start', () => {
    const diff = `--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 const x = 1
+const y = 2
 const z = 3
@@ -10,2 +11,3 @@
 const p = 1
+const q = 2
 const r = 3
`
    // first hunk: +y at line 2; second hunk new-start 11: context(11), +q at 12
    expect(lines(parseUnifiedDiff(diff), 'src/a.ts')).toEqual([2, 12])
  })

  it('handles multiple files in one diff', () => {
    const diff = `diff --git a/one.ts b/one.ts
--- a/one.ts
+++ b/one.ts
@@ -1 +1,2 @@
 a
+b
diff --git a/two.ts b/two.ts
--- a/two.ts
+++ b/two.ts
@@ -5,2 +5,2 @@
 c
+d
-e
`
    const out = parseUnifiedDiff(diff)
    expect(out.map((f) => f.path)).toEqual(['one.ts', 'two.ts'])
    expect(lines(out, 'one.ts')).toEqual([2])
    expect(lines(out, 'two.ts')).toEqual([6])
  })

  it('treats a brand-new file (--- /dev/null) as all-added', () => {
    const diff = `diff --git a/new.ts b/new.ts
new file mode 100644
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,3 @@
+line one
+line two
+line three
`
    expect(lines(parseUnifiedDiff(diff), 'new.ts')).toEqual([1, 2, 3])
  })

  it('omits a deleted file (+++ /dev/null) — it has no new-side lines', () => {
    const diff = `diff --git a/gone.ts b/gone.ts
deleted file mode 100644
--- a/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-was one
-was two
`
    expect(parseUnifiedDiff(diff)).toEqual([])
  })

  it('ignores the "\\ No newline at end of file" marker', () => {
    const diff = `--- a/f.ts
+++ b/f.ts
@@ -1 +1 @@
-old
\\ No newline at end of file
+new
\\ No newline at end of file
`
    expect(lines(parseUnifiedDiff(diff), 'f.ts')).toEqual([1])
  })

  it('classifies hunk-body lines by their first char (an added line may itself start with +)', () => {
    const diff = `--- a/f.ts
+++ b/f.ts
@@ -1,1 +1,2 @@
 const ops = []
+const inc = a => ++a
`
    // The added line's content begins with "++a"; inside a hunk it is still one added line.
    expect(lines(parseUnifiedDiff(diff), 'f.ts')).toEqual([2])
  })

  it('strips the b/ prefix and dedupes/sorts; returns [] for an empty diff', () => {
    expect(parseUnifiedDiff('')).toEqual([])
    const diff = `--- a/z.ts
+++ b/z.ts
@@ -1,0 +1,2 @@
+a
+b
`
    expect(parseUnifiedDiff(diff)).toEqual([{ path: 'z.ts', addedLines: [1, 2] }])
  })
})

describe('changedFiles — the new-side paths a change touched (the scope primitive)', () => {
  it('returns every touched file across a multi-file diff, deduped and sorted', () => {
    const diff = `diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1 +1,2 @@
 a
+b
diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -5,2 +5,2 @@
 c
+d
-e
`
    expect(changedFiles(diff)).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('includes a file modified by removals only (unlike parseUnifiedDiff)', () => {
    const diff = `diff --git a/src/trim.ts b/src/trim.ts
--- a/src/trim.ts
+++ b/src/trim.ts
@@ -1,3 +1,2 @@
 keep
-drop
 stay
`
    // No new-side lines gained, so parseUnifiedDiff omits it...
    expect(parseUnifiedDiff(diff)).toEqual([])
    // ...but it is still a changed file whose tests should re-run.
    expect(changedFiles(diff)).toEqual(['src/trim.ts'])
  })

  it('includes a brand-new file and excludes a deleted file', () => {
    const diff = `diff --git a/new.ts b/new.ts
new file mode 100644
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+one
+two
diff --git a/gone.ts b/gone.ts
deleted file mode 100644
--- a/gone.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-bye
`
    expect(changedFiles(diff)).toEqual(['new.ts'])
  })

  it('is not fooled by a hunk-body line beginning with "+++ "', () => {
    const diff = `--- a/doc.md
+++ b/doc.md
@@ -1,1 +1,2 @@
 title
+++ not a header, just markdown
`
    expect(changedFiles(diff)).toEqual(['doc.md'])
  })

  it('returns [] for an empty diff', () => {
    expect(changedFiles('')).toEqual([])
  })
})
