#!/usr/bin/env bash
# Restore the tutorial to its pristine (intentionally buggy) starting state.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

rm -f "$here/todos.json"

if git -C "$here" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git -C "$here" checkout -- "$here"
  echo "Reset examples/tutorial/todo to pristine HEAD (and cleared todos.json)."
else
  echo "Not a git checkout — discard your edits to this directory manually."
  echo "(Cleared todos.json.)"
fi
