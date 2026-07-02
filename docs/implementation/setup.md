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
for both to become reachable, then opens the web UI. On first open, the UI
shows provider setup, then a sync progress screen, then enters the board. Use
`--no-open` when you want to start the servers without launching a browser.
From the repository script, pass CLI flags after `--`; for example:

```bash
bun run codex-board -- --help
bun run codex-board -- --version
bun run codex-board -- --clear
```

When installed as a package executable, the same commands are available as
`codex-board --help`, `codex-board --version`, and `codex-board --clear`.

Use `--clear` to reset local Codex Boards state before startup. The command
asks for confirmation, deletes the resolved SQLite database and SQLite sidecar
files, and leaves the original Codex session history under `~/.codex/sessions`
untouched.

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
export CODEX_BOARDS_PARSER_PROVIDER=openai-compatible
export OPENAI_COMPAT_BASE_URL=http://localhost:11434/v1
export OPENAI_COMPAT_API_KEY=placeholder
export OPENAI_COMPAT_MODEL=qwen2.5-coder:7b
```

For Codex CLI parsing, set `CODEX_BOARDS_PARSER_PROVIDER=codex-cli`; the
default model is `gpt-5.4-mini`. Set `CODEX_BOARDS_CODEX_CLI_BIN` only when the
backend should call a non-default `codex` executable path.

You can also inspect and update the runtime parser settings from the web app's Settings dialog. The dialog includes Codex CLI, Gemini, OpenRouter, DeepSeek, and custom provider presets. The Codex CLI preset runs `codex exec` with `gpt-5.4-mini` and parses the plain final message because this path does not use response schemas. Codex CLI sync runs use ephemeral execution and an internal skip marker so parser runs do not get re-imported as new Codex threads. The dialog updates the backend parser target, shows recent sync history, and persists both parser settings and sync diagnostics in SQLite for subsequent sync runs and backend restarts.

## Initial implementation choices

- Package manager: Bun workspaces
- Formatter and linter: Biome
- Backend framework: Hono
- Web framework: React with React Router and Vite
- Desktop wrapper: Tauri
- Native GNOME app: GJS with GTK 4, libadwaita, Meson, and the GNOME 50 Flatpak SDK
- Shared models: TypeScript package under `packages/domain`

## Runtime behavior

- The backend scans `~/.codex/sessions` when sync is requested or scheduled
- Only Git-backed threads are imported
- Parsed issues are stored in SQLite under `.tmp/codex-boards.sqlite` by default
- First-run onboarding requires parser provider setup, lets the user optionally limit the initial import to the latest 100 threads, runs the first sync, then enters the board
- Manual sync runs incrementally: new, changed, removed, or parser-fingerprint-changed rollout files are processed; unchanged files are skipped
- The `POST /api/sync` `maxThreads` option is only honored before the first completed sync; later manual syncs scan all rollout files
- After the first completed sync, the backend schedules background sync every minute by default and only queues newly added or file-updated rollout threads; set `CODEX_BOARDS_SYNC_INTERVAL_MS=0` to disable it
- Live sync status is available as JSON or WebSocket at `GET /api/sync/status`; before the first sync, `progress.totalFiles` reports the discovered local rollout thread count
- If AI parsing is unavailable, fallback issues are still persisted and marked for review
- Parser settings can be changed at runtime through `GET /api/settings` and `POST /api/settings`, and persisted in SQLite
- Sync runs persist parser base URL, configured model, resolved response model(s), request counts, token totals, and parse logs in SQLite
- Skills are exposed read-only through `GET /api/skills` and `GET /api/skills/:id`; global discovery reads `${CODEX_HOME:-~/.codex}/skills`, `${AGENTS_HOME:-~/.agents}/skills`, and enabled plugin skill roots from `${CODEX_HOME:-~/.codex}/config.toml`
- Project skill discovery reads `.codex/skills` and `.agents/skills` under the selected project's `workspacePath`
- Project skill suggestions are exposed through `GET /api/skills/suggestions?projectId=...`; the backend groups repeated sanitized user prompts and assistant outcomes from imported workspace threads into draft `SKILL.md` ideas. Installed global, plugin, agent, and project-local skills are not ranked against issues.
- Draft skill suggestions can be installed through `POST /api/skills/install`; workspace installs write to `<project workspace>/.agents/skills/<name>/SKILL.md`, and global installs write to `${AGENTS_HOME:-~/.agents}/skills/<name>/SKILL.md`. Existing skill files are not overwritten.
- Usage aggregation is exposed through `GET /api/usage` and `POST /api/usage/refresh`; the first usage read initializes the local index, each successful sync refreshes aggregate `token_count` rows from active sessions and `${CODEX_HOME:-~/.codex}/archived_sessions`, and responses include `summary` for the selected interval plus `total` for all indexed device data
- Usage pricing starts from bundled standard OpenAI pricing defaults for known models, then applies `${CODEX_BOARDS_USAGE_PRICING_PATH}` when set or `usage-pricing.json` next to the SQLite database when present. Local pricing files can add or override model rates. Normal usage reads do not fetch pricing from the network
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

- Diff-heavy and policy-heavy content is intentionally excluded before parsing
- Assignee and due date remain null unless the thread states them clearly
- Manual merge/split correction endpoints are intentionally lightweight in v1
- Desktop packaging currently targets macOS and Linux first
- Flatpak Multica export depends on a usable `multica` command inside the package or sandbox environment
