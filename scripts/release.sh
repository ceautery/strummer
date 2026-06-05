#!/usr/bin/env bash
# The PUBLISH step run by changesets/action AFTER the "Version Packages" PR is merged
# (i.e. only when there are version bumps to release — never on an ordinary push).
#
# Publish THROUGH pnpm (ADR 0019 §14): pnpm rewrites `workspace:*` to the real version;
# plain `npm publish` / `changeset publish` would ship the literal `workspace:*` and break
# every install. dist-tag is prerelease-aware: in Changesets pre mode (e.g. `alpha`) we
# publish to THAT tag, never `latest` — a prerelease must not become the default `npm i`
# target (the alpha.0 `latest` trap). Stable releases publish to `latest`.
set -euo pipefail
cd "$(dirname "$0")/.."

tag="$(node -e "try { process.stdout.write(require('./.changeset/pre.json').tag) } catch { process.stdout.write('latest') }")"
echo "release: publishing with dist-tag '$tag'"

# OIDC trusted publishing (no token) is picked up from the workflow's id-token; provenance
# is auto-attached. `--no-git-checks` because the version commit was just made by the action.
pnpm -r publish --no-git-checks --tag "$tag"

# Create per-package git tags (<pkg>@<version>) for whatever was just published.
pnpm exec changeset tag
