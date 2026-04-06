# codex-boards

`codex-boards` is a monorepo for turning local Codex rollout history into a project-board style experience.

The current implementation includes:

- `apps/backend`: Hono API, rollout sync service, SQLite persistence, and AI/fallback issue extraction
- `apps/web`: React workspace with project sidebar, issue table, saved views, and a detail sheet
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

Default local URLs:

- Web: `http://localhost:5173`
- Backend: `http://localhost:8787`

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

## Repo layout

```text
apps/
  backend/
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
