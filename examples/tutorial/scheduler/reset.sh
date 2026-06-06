#!/usr/bin/env bash
# Restore the tutorial to its pristine (intentionally buggy) starting state.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

rm -f "$here/schedule.json"
rm -rf "$here/reports" "$here/.stryker-tmp"

if git -C "$here" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git -C "$here" checkout -- "$here"
  echo "Reset examples/tutorial/scheduler to pristine HEAD (and cleared run state)."
else
  echo "Not a git checkout — discard your edits to this directory manually."
  echo "(Cleared schedule.json + reports/.)"
fi
