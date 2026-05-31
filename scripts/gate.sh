#!/usr/bin/env bash
# The green gate. Nothing commits or pushes unless this is 100% green
# (see CLAUDE.md). Runs both language toolchains.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== TypeScript :: biome (lint + format) =="
pnpm lint

echo "== TypeScript :: typecheck =="
pnpm typecheck

echo "== TypeScript :: vitest =="
pnpm test

echo "== Python :: ruff (lint) =="
( cd py/strummer_ingest && uv run ruff check . )

echo "== Python :: ruff (format) =="
( cd py/strummer_ingest && uv run ruff format --check . )

echo "== Python :: pytest =="
( cd py/strummer_ingest && uv run pytest )

echo
echo "ALL GREEN ✅"
