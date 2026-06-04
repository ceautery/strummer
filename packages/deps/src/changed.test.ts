import { describe, expect, it } from 'vitest'
import { changedDependencies } from './changed.js'

describe('changedDependencies — dependency names whose declaration changed in a manifest diff', () => {
  it('captures a version bump inside the dependencies block', () => {
    const diff = `diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -10,7 +10,7 @@
   "dependencies": {
     "left-pad": "^1.3.0",
-    "react": "^19.1.0",
+    "react": "^19.2.0",
     "semver": "^7.8.1"
   },
`
    expect(changedDependencies(diff, 'npm')).toEqual(['react'])
  })

  it('captures an added devDependency and a removed dependency', () => {
    const diff = `diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -10,6 +10,6 @@
   "dependencies": {
-    "lodash": "^4.17.21",
     "react": "^19.2.0"
   },
   "devDependencies": {
+    "vitest": "^4.1.7",
     "typescript": "^6.0.3"
   }
`
    expect(changedDependencies(diff, 'npm')).toEqual(['lodash', 'vitest'])
  })

  it('ignores changes outside dependency blocks (scripts, version, engines, packageManager)', () => {
    const diff = `diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -1,12 +1,12 @@
 {
   "name": "app",
-  "version": "1.2.3",
+  "version": "1.2.4",
-  "packageManager": "pnpm@11.4.0",
+  "packageManager": "pnpm@11.5.0",
   "scripts": {
-    "build": "tsdown src/index.ts",
+    "build": "tsdown src/index.ts --dts",
     "test": "vitest run"
   },
   "engines": {
-    "node": ">=22",
+    "node": ">=24",
   }
 }
`
    expect(changedDependencies(diff, 'npm')).toEqual([])
  })

  it('unions across dependency blocks, deduped and sorted', () => {
    const diff = `diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -8,9 +8,10 @@
   "dependencies": {
+    "axios": "^1.7.0",
     "react": "^19.2.0"
   },
   "optionalDependencies": {
-    "fsevents": "^2.3.0"
+    "fsevents": "^2.4.0"
   },
   "peerDependencies": {
-    "react-dom": "^18.0.0"
+    "react-dom": "^19.0.0"
   }
 }
`
    expect(changedDependencies(diff, 'npm')).toEqual(['axios', 'fsevents', 'react-dom'])
  })

  it('captures a brand-new dependency block added wholesale', () => {
    const diff = `diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -5,6 +5,9 @@
   "type": "module",
+  "dependencies": {
+    "zod": "^3.23.0"
+  },
   "scripts": {
     "build": "tsdown"
   }
`
    expect(changedDependencies(diff, 'npm')).toEqual(['zod'])
  })

  it('ignores a non-manifest file and returns [] when no package.json changed', () => {
    const diff = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,2 +1,2 @@
-import { old } from 'react'
+import { neu } from 'react'
`
    expect(changedDependencies(diff, 'npm')).toEqual([])
    expect(changedDependencies('', 'npm')).toEqual([])
  })

  it('does not mistake one dependency block for the next hunk (block state resets per hunk)', () => {
    const diff = `diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -10,3 +10,3 @@
   "dependencies": {
-    "react": "^19.1.0"
+    "react": "^19.2.0"
   },
@@ -30,3 +30,3 @@
   "scripts": {
-    "build": "old"
+    "build": "new"
   },
`
    // The second hunk is a scripts change with no dep-block header in its context → ignored.
    expect(changedDependencies(diff, 'npm')).toEqual(['react'])
  })

  it('returns [] for ecosystems whose manifest diff is staged (PyPI / RubyGems)', () => {
    const diff = `diff --git a/pyproject.toml b/pyproject.toml
--- a/pyproject.toml
+++ b/pyproject.toml
@@ -1,3 +1,3 @@
 dependencies = [
-  "requests==2.31.0",
+  "requests==2.32.0",
 ]
`
    expect(changedDependencies(diff, 'PyPI')).toEqual([])
    expect(changedDependencies(diff, 'RubyGems')).toEqual([])
  })
})
