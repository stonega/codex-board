#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$ROOT_DIR/apps/gnome/resources/backend"
OUT_FILE="$OUT_DIR/codex-boards-backend"

mkdir -p "$OUT_DIR"

bun build "$ROOT_DIR/apps/backend/src/index.ts" \
  --compile \
  --outfile "$OUT_FILE"
