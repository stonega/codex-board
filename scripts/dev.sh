#!/usr/bin/env bash

set -euo pipefail

bun run dev:backend &
backend_pid=$!

bun run dev:web &
web_pid=$!

cleanup() {
  kill "$backend_pid" "$web_pid" 2>/dev/null || true
}

trap cleanup EXIT INT TERM

wait

