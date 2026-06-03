#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$ROOT_DIR/apps/gnome"
BUILD_DIR="$APP_DIR/builddir"

"$ROOT_DIR/scripts/build-gnome-sidecar.sh"

if [ -d "$BUILD_DIR" ]; then
  meson setup "$BUILD_DIR" "$APP_DIR" --reconfigure
else
  meson setup "$BUILD_DIR" "$APP_DIR"
fi

meson compile -C "$BUILD_DIR"
