# Setup

## Prerequisites

- Bun 1.2+
- Node.js 20+

## Install

```bash
bun install
```

## Run locally

Backend:

```bash
bun run dev:backend
```

Web:

```bash
bun run dev:web
```

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
- Shared models: TypeScript package under `packages/domain`

## Runtime behavior

- The backend scans `~/.codex/sessions` on startup
- Only Git-backed threads are imported
- Parsed issues are stored in SQLite under `.tmp/codex-boards.sqlite` by default
- Sync currently runs as a full rebuild in debug mode: each sync deletes imported issues, projects, sync cache, and sync history, then reparses the current rollout set from scratch
- If AI parsing is unavailable, fallback issues are still persisted and marked for review
- Parser settings can be changed at runtime through `GET /api/settings` and `POST /api/settings`, and persisted in SQLite
- Sync runs persist parser base URL, configured model, resolved response model(s), request counts, token totals, and parse logs in SQLite

## Current limitations

- Diff-heavy and policy-heavy content is intentionally excluded to control parse cost
- Assignee and due date remain null unless the thread states them clearly
- Manual merge/split correction endpoints are intentionally lightweight in v1
