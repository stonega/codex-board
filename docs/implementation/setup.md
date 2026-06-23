# Setup

## Prerequisites

- Bun 1.2+
- Node.js 20+

## Install

```bash
bun install
```

## Run locally

Recommended browser workflow:

```bash
bun run codex-board
```

The `codex-board` CLI starts the backend API and Vite web app locally, waits
for both to become reachable, then opens the web UI. Use the web UI's sync
action to refresh local Codex session data. Use `--no-open` when you want to
start the servers without launching a browser.

Backend:

```bash
bun run dev:backend
```

Web:

```bash
bun run dev:web
```

Desktop:

```bash
bun run dev:desktop
```

Export issues to Multica:

```bash
bun run --filter @codex-boards/backend start -- issues export multica --project codex-boards
```

The export command runs a sync first by default, then creates one Multica issue per parent issue and, unless `--no-children` is set, creates sub-issues under the exported Multica parent. Use `--dry-run` to inspect the generated `multica issue create` commands and `--skip-sync` when you want to export the current SQLite snapshot as-is.

Optional parser configuration:

```bash
export OPENAI_COMPAT_BASE_URL=http://localhost:11434/v1
export OPENAI_COMPAT_API_KEY=placeholder
export OPENAI_COMPAT_MODEL=qwen2.5-coder:7b
```

You can also inspect and update the runtime parser settings from the web app's Settings dialog. The dialog updates the backend's OpenAI-compatible parser target, shows recent sync history, and persists both parser settings and sync diagnostics in SQLite for subsequent sync runs and backend restarts.

## Initial implementation choices

- Package manager: Bun workspaces
- Formatter and linter: Biome
- Backend framework: Hono
- Web framework: React with React Router and Vite
- Desktop wrapper: Tauri
- Native GNOME app: GJS with GTK 4, libadwaita, Meson, and the GNOME 50 Flatpak SDK
- Shared models: TypeScript package under `packages/domain`

## Runtime behavior

- The backend scans `~/.codex/sessions` on startup
- Only Git-backed threads are imported
- Parsed issues are stored in SQLite under `.tmp/codex-boards.sqlite` by default
- Sync currently runs as a full rebuild in debug mode: each sync deletes imported issues, projects, sync cache, and sync history, then reparses the current rollout set from scratch
- If AI parsing is unavailable, fallback issues are still persisted and marked for review
- Parser settings can be changed at runtime through `GET /api/settings` and `POST /api/settings`, and persisted in SQLite
- Sync runs persist parser base URL, configured model, resolved response model(s), request counts, token totals, and parse logs in SQLite
- The desktop shell starts the backend on a local loopback port and injects that API base URL into the shared React app at runtime
- The GNOME shell starts the same backend on a local loopback port and renders the board with native GTK/libadwaita widgets
- Desktop builds store SQLite under the platform app data directory by setting `CODEX_BOARDS_APP_DATA_DIR`

## Native GNOME app

The native GNOME app lives in `apps/gnome` and mirrors the current desktop feature surface:

- project navigation and saved views
- issue search, status, priority, parse mode, review, commit, and tag filters
- issue detail windows with review toggling, Git evidence, traceability, warnings, parse preview, and sub-issues
- parser settings with Gemini and OpenRouter presets
- sync history
- manual sync and Multica export

Run from the repository:

```bash
bun run dev:gnome
```

Build the Meson project with a compiled backend sidecar:

```bash
bun run build:gnome
```

Build the Flatpak package:

```bash
bun run flatpak:gnome
```

The Flatpak manifest uses `org.gnome.Platform` and `org.gnome.Sdk` with runtime version `50`, which matches the current GNOME 50 platform. Its sandbox grants read-only home access so the backend can inspect Codex sessions and referenced workspace paths.

## Current limitations

- Diff-heavy and policy-heavy content is intentionally excluded to control parse cost
- Assignee and due date remain null unless the thread states them clearly
- Manual merge/split correction endpoints are intentionally lightweight in v1
- Desktop packaging currently targets macOS and Linux first
- Flatpak Multica export depends on a usable `multica` command inside the package or sandbox environment
