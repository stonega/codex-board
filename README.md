# codex-boards

`codex-boards` is a monorepo for turning local Codex rollout history into a project-board style experience.

The current implementation includes:

- `apps/backend`: Hono API, rollout sync service, SQLite persistence, and AI/fallback issue extraction
- `apps/web`: React workspace with project sidebar, issue table, saved views, and a detail sheet
- `apps/desktop`: Tauri wrapper that launches the backend locally and hosts the web UI as a desktop app
- `apps/gnome`: native GNOME app built with GJS, GTK 4, libadwaita, and the GNOME 50 Flatpak SDK
- `packages/domain`: shared issue, project, sync, and evidence contracts

## Product direction

The target workflow is:

1. Read rollout files from `~/.codex/sessions`
2. Keep only Git-backed threads
3. Infer projects from repository metadata and workspace paths
4. Extract one parent issue and optional sub-issues per thread
5. Attach Git metadata, commits, tags, and parse evidence when available
6. Render the result as a filterable issue workspace

## Getting started

```bash
bun install
bun run dev:backend
bun run dev:web
```

Desktop development:

```bash
bun run dev:desktop
```

GNOME development:

```bash
bun run dev:gnome
```

Default local URLs:

- Web: `http://localhost:5173`
- Backend: `http://localhost:7788`
- Desktop: native Tauri window backed by a local API selected at runtime
- GNOME: native GTK/libadwaita window backed by a local API selected at runtime

Optional AI parser env vars:

```bash
OPENAI_COMPAT_BASE_URL=
OPENAI_COMPAT_API_KEY=
OPENAI_COMPAT_MODEL=
```

## Quality commands

```bash
bun run test
bun run check
bun run format
```

Desktop packaging:

```bash
bun run build:desktop
```

GNOME packaging:

```bash
bun run build:gnome
bun run flatpak:gnome
```

## CLI

Export a project into Multica from the backend CLI:

```bash
bun run --filter @codex-boards/backend start -- issues export multica --project codex-boards
```

Useful flags:

- `--issue <issue-id>` to export only selected parent issues
- `--no-children` to skip sub-issues
- `--dry-run` to print the `multica` commands without executing them
- `--skip-sync` to export the current SQLite state without running sync first

## Repo layout

```text
apps/
  backend/
  desktop/
  web/
packages/
  domain/
docs/
  design/
  implementation/
  user/
examples/
postmortem/
scripts/
tests/
```

## Current status

The repo now ships a first working version:

- startup sync from `~/.codex/sessions`
- SQLite-backed issue storage
- deterministic Git evidence extraction
- OpenAI-compatible issue parsing with fallback mode
- parent/sub-issue modeling
- project list, saved views, issue table, and detail sheet UI
- Tauri desktop packaging that reuses the existing backend and web surfaces
- native GNOME packaging that launches the same backend sidecar and renders the board with GTK/libadwaita widgets
