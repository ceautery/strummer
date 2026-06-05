#!/usr/bin/env bash
# Build-then-assert PACKAGING checks (ADR 0019 slices 2 + 10) — NOT part of `pnpm gate`.
#
# These run AFTER a real build and operate on packed TARBALLS (what npm actually ships), so
# they catch defects the no-build gate cannot: masquerading/unshipped types, bad publish
# config, and native/heavy deps leaking into the aggregate's startup closure.
#
#   slice 2  — `attw` (Are The Types Wrong) + `publint` against each packed tarball.
#   slice 10 — `assert-lazy-boundary.mjs`: the aggregate `bin.mjs` startup closure stays native-free.
#
# ESM-only by design (ADR §17): `attw --profile esm-only` ignores the node10 + CJS resolutions.
set -euo pipefail
cd "$(dirname "$0")/.."

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "== build (topological) =="
pnpm -r build >/dev/null

echo "== pack all publishable packages =="
for d in packages/*/; do (cd "$d" && pnpm pack --pack-destination "$TMP" >/dev/null 2>&1); done
mapfile -t TARBALLS < <(ls "$TMP"/*.tgz | sort)
echo "  ${#TARBALLS[@]} tarballs"

fail=0
echo "== slice 2: attw --profile esm-only + publint (per tarball) =="
for tb in "${TARBALLS[@]}"; do
  name="$(basename "$tb")"
  if ! pnpm exec attw --profile esm-only "$tb" >"$TMP/attw.log" 2>&1; then
    echo "✘ attw FAILED: $name"; sed 's/^/    /' "$TMP/attw.log"; fail=1
  elif ! pnpm exec publint "$tb" >"$TMP/publint.log" 2>&1; then
    echo "✘ publint FAILED: $name"; sed 's/^/    /' "$TMP/publint.log"; fail=1
  else
    echo "  ✓ $name"
  fi
done

echo "== slice 10: aggregate lazy boundary =="
if ! node scripts/assert-lazy-boundary.mjs; then fail=1; fi

if [ "$fail" -ne 0 ]; then
  echo ""; echo "✘ packaging checks FAILED"; exit 1
fi
echo ""; echo "✓ all packaging checks passed"
