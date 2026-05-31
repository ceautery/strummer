#!/usr/bin/env bash
set -euo pipefail

CLAUDE_JSON="/home/claude/.claude.json"
CLAUDE_JSON_STORE="/home/claude/.claude/.claude.json.persist"

# ~/.claude.json lives OUTSIDE the ~/.claude volume and the CLI rewrites it in
# place, so we copy-restore on start and copy-save on stop instead of symlinking.
[ -f "$CLAUDE_JSON_STORE" ] && cp "$CLAUDE_JSON_STORE" "$CLAUDE_JSON"

save_claude_json() {
  [ -f "$CLAUDE_JSON" ] && cp "$CLAUDE_JSON" "$CLAUDE_JSON_STORE"
}
trap save_claude_json EXIT SIGTERM SIGINT

# Once gh is authenticated (its config persists via GH_CONFIG_DIR on the auth
# volume), route GitHub git operations through its cached https credentials and
# derive git identity from the gh user when it isn't already configured. Only
# unset values are written, so manual overrides are respected.
if gh auth status >/dev/null 2>&1; then
  gh auth setup-git 2>/dev/null || true
  git config --global url."https://github.com/".insteadOf "git@github.com:"

  if ! git config --global user.name >/dev/null 2>&1; then
    name=$(gh api user --jq '.name // .login' 2>/dev/null || true)
    [ -n "$name" ] && git config --global user.name "$name"
  fi
  if ! git config --global user.email >/dev/null 2>&1; then
    email=$(gh api user --jq '.email // empty' 2>/dev/null || true)
    if [ -z "$email" ]; then
      id=$(gh api user --jq '.id' 2>/dev/null || true)
      login=$(gh api user --jq '.login' 2>/dev/null || true)
      [ -n "$id" ] && [ -n "$login" ] && email="${id}+${login}@users.noreply.github.com"
    fi
    [ -n "$email" ] && git config --global user.email "$email"
  fi
fi

# Stay PID 1 so the SIGTERM trap fires on `docker compose down`
"$@" &
wait $!
