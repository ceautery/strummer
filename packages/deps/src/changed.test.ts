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

  it('ignores a file with no matching manifest profile for the ecosystem', () => {
    const diff = `diff --git a/src/app.py b/src/app.py
--- a/src/app.py
+++ b/src/app.py
@@ -1,2 +1,2 @@
-import old
+import neu
`
    expect(changedDependencies(diff, 'PyPI')).toEqual([])
    expect(changedDependencies(diff, 'RubyGems')).toEqual([])
  })
})

describe('changedDependencies — PyPI manifests + lockfiles', () => {
  it('captures a version bump in a PEP 621 dependencies array', () => {
    const diff = `diff --git a/pyproject.toml b/pyproject.toml
--- a/pyproject.toml
+++ b/pyproject.toml
@@ -8,7 +8,7 @@
 [project]
 dependencies = [
   "flask>=2.0",
-  "requests==2.31.0",
+  "requests==2.32.0",
   "click",
 ]
`
    expect(changedDependencies(diff, 'PyPI')).toEqual(['requests'])
  })

  it('captures an added optional-dependency (PEP 621 extras table)', () => {
    const diff = `diff --git a/pyproject.toml b/pyproject.toml
--- a/pyproject.toml
+++ b/pyproject.toml
@@ -14,6 +14,7 @@
 [project.optional-dependencies]
 test = [
   "pytest>=7",
+  "coverage[toml]>=7.0",
   "ruff",
 ]
`
    expect(changedDependencies(diff, 'PyPI')).toEqual(['coverage'])
  })

  it('captures a Poetry dependency table change and skips python', () => {
    const diff = `diff --git a/pyproject.toml b/pyproject.toml
--- a/pyproject.toml
+++ b/pyproject.toml
@@ -20,6 +20,6 @@
 [tool.poetry.dependencies]
 python = "^3.11"
-flask = "^2.0"
+flask = "^2.1"
 click = "^8.0"
`
    expect(changedDependencies(diff, 'PyPI')).toEqual(['flask'])
  })

  it('ignores [project] version/name and other quoted arrays (classifiers, authors)', () => {
    const diff = `diff --git a/pyproject.toml b/pyproject.toml
--- a/pyproject.toml
+++ b/pyproject.toml
@@ -1,10 +1,10 @@
 [project]
 name = "myapp"
-version = "1.0.0"
+version = "1.1.0"
 classifiers = [
-  "License :: OSI Approved :: MIT License",
+  "License :: OSI Approved :: Apache Software License",
 ]
`
    expect(changedDependencies(diff, 'PyPI')).toEqual([])
  })

  it('captures a requirements.txt change and skips option lines', () => {
    const diff = `diff --git a/requirements.txt b/requirements.txt
--- a/requirements.txt
+++ b/requirements.txt
@@ -1,4 +1,4 @@
-Django==4.2
+Django==4.3
 -r dev-requirements.txt
 # a comment
 click
`
    expect(changedDependencies(diff, 'PyPI')).toEqual(['django'])
  })

  it('captures a resolved version bump in a TOML lockfile [[package]] block', () => {
    const diff = `diff --git a/uv.lock b/uv.lock
--- a/uv.lock
+++ b/uv.lock
@@ -118,7 +118,7 @@
 [[package]]
 name = "urllib3"
-version = "2.1.0"
+version = "2.2.0"
 source = { registry = "https://pypi.org/simple" }
`
    expect(changedDependencies(diff, 'PyPI')).toEqual(['urllib3'])
  })

  it('normalizes (PEP 503) and unions across the manifest and the lockfile', () => {
    const diff = `diff --git a/pyproject.toml b/pyproject.toml
--- a/pyproject.toml
+++ b/pyproject.toml
@@ -8,5 +8,5 @@
 dependencies = [
-  "Flask_Login==0.6.2",
+  "Flask_Login==0.6.3",
 ]
diff --git a/uv.lock b/uv.lock
--- a/uv.lock
+++ b/uv.lock
@@ -200,7 +200,7 @@
 [[package]]
 name = "flask-login"
-version = "0.6.2"
+version = "0.6.3"
 source = { registry = "https://pypi.org/simple" }
`
    expect(changedDependencies(diff, 'PyPI')).toEqual(['flask-login'])
  })
})

describe('changedDependencies — RubyGems Gemfile + Gemfile.lock', () => {
  it('captures a changed gem in the Gemfile', () => {
    const diff = `diff --git a/Gemfile b/Gemfile
--- a/Gemfile
+++ b/Gemfile
@@ -1,4 +1,4 @@
 source "https://rubygems.org"
-gem "rails", "~> 7.0.4"
+gem "rails", "~> 7.0.8"
 gem "pg"
`
    expect(changedDependencies(diff, 'RubyGems')).toEqual(['rails'])
  })

  it('captures a resolved top-level spec bump in Gemfile.lock and skips transitive/constraint rows', () => {
    const diff = `diff --git a/Gemfile.lock b/Gemfile.lock
--- a/Gemfile.lock
+++ b/Gemfile.lock
@@ -10,9 +10,9 @@
 GEM
   remote: https://rubygems.org/
   specs:
-    rails (7.0.4)
+    rails (7.0.8)
       actionpack (= 7.0.4)
     rake (13.0.6)
 DEPENDENCIES
   rails (~> 7.0.4)
`
    expect(changedDependencies(diff, 'RubyGems')).toEqual(['rails'])
  })

  it('unions the Gemfile and Gemfile.lock, deduped and sorted', () => {
    const diff = `diff --git a/Gemfile b/Gemfile
--- a/Gemfile
+++ b/Gemfile
@@ -1,3 +1,3 @@
-gem "puma", "~> 5.6"
+gem "puma", "~> 6.4"
 gem "pg"
diff --git a/Gemfile.lock b/Gemfile.lock
--- a/Gemfile.lock
+++ b/Gemfile.lock
@@ -20,7 +20,7 @@
   specs:
-    nokogiri (1.15.0)
+    nokogiri (1.16.0)
     puma (5.6.0)
`
    expect(changedDependencies(diff, 'RubyGems')).toEqual(['nokogiri', 'puma'])
  })
})
