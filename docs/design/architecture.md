# Architecture

## Goal

Build a local-first system that turns Codex rollout history into a project-oriented issue workspace with inspectable AI-assisted parsing.

## Monorepo rationale

The product needs two independently evolving surfaces:

- a backend that ingests history, enriches it, and exposes query APIs
- a frontend that presents projects, threads, and inferred work categories
- a desktop shell that packages both for local desktop workflows
- a native GNOME shell for Linux workflows that uses platform widgets instead of an embedded web view

The domain model is central to both, so it lives in a shared package.

## Current structure

- `apps/backend`
  - Hono API
  - rollout-file sync service
  - SQLite persistence and diagnostics
  - OpenAI-compatible and Codex CLI parse clients with heuristic fallback
- `apps/web`
  - React UI
  - Notion-style project/issues workspace
  - filters, saved views, and issue detail sheet
  - global and project-local skills catalog with a shared detail sheet
  - usage dashboard with local token, cost, cache, reasoning, and thread-start charts
- `apps/desktop`
  - Tauri desktop wrapper
  - local backend process lifecycle
  - runtime API base URL injection for the shared web UI
- `apps/gnome`
  - GJS application using GTK 4 and libadwaita widgets
  - local backend process lifecycle matching the Tauri desktop app
  - Flatpak manifest targeting `org.gnome.Platform`/`org.gnome.Sdk` runtime version `50`
- `packages/domain`
  - issue, project, sync, and evidence types
  - deterministic fallback helpers and confidence rules

## Data model direction

The first working pipeline now produces:

- `rollout files`: raw `.jsonl` records under `~/.codex/sessions`
- `thread candidates`: normalized threads with filtered text, timestamps, and Git evidence
- `projects`: inferred groupings derived from repository/workspace metadata
- `issues`: parent issues plus optional sub-issues
- `sync runs`: temporary full-resync diagnostics
  - manual and onboarding runs scan the current rollout set and reparse only new, changed, removed, or parser-fingerprint-changed files
  - first-run onboarding can cap the initial scan to the latest 100 rollout files; subsequent manual syncs scan the full rollout set
  - each run records a per-file parse log for imported, skipped, and failed rollouts
  - each run also records parser target, resolved response model(s), and token usage totals for auditability
  - background sync runs once per minute after the first completed sync, queues only newly added or file-updated rollout threads, and publishes live status over WebSocket
- `skills`: read-only `SKILL.md` files discovered from local Codex, agent, enabled plugin, and selected project skill roots
- `usage events`: aggregate-only Codex token-count rows from active and archived local session logs

## Inference strategy

The implementation stays heuristic and inspectable:

- import only Git-backed workspaces
- deterministically extract branch, commit, and tag evidence from thread/tool output
- truncate thread text before sending it to the configured parser
- fall back to deterministic issue shaping when AI parsing fails
- flag low-confidence issues for review instead of hiding uncertainty

The Codex CLI parser path is isolated from normal session ingestion. It runs
non-interactively with ephemeral execution, reads only the final CLI message,
does not rely on a response schema, and tags its prompt with an internal marker
so any accidentally persisted parser session is ignored by rollout sync.

Opaque ML classification should not be the default path until the baseline heuristic layer is stable.

## API direction

Primary endpoints:

- `GET /api/health`
- `GET /api/settings`
- `POST /api/settings`
- `GET /api/projects`
- `GET /api/skills`
- `GET /api/skills/suggestions`
- `GET /api/skills/:id`
- `POST /api/skills/install`
- `GET /api/usage`
- `POST /api/usage/refresh`
- `GET /api/issues`
- `GET /api/issues/:id`
- `POST /api/sync`
- `GET /api/sync/status`
- `GET /api/sync/runs`
- `GET /api/views`
- `POST /api/views`

The web UI consumes these endpoints directly and renders first-run provider onboarding, a user-started first sync screen with an optional latest-100 thread cap, project navigation, filterable issue tables, global and project-local skill lists, draft skill suggestions derived from repeated workspace thread patterns, usage charts, a runtime parser settings sheet with sync history, live homepage sync status, and right-side detail sheets.

The usage dashboard follows the same local-first boundary as issue ingestion. It parses only token-count aggregates from local Codex JSONL logs, including archived sessions, and persists no prompts, assistant messages, tool output, command text, patches, or transcript snippets. Successful sync runs refresh the local usage index automatically. Estimated USD cost starts from bundled standard pricing defaults for known models, then applies local pricing JSON additions or overrides when present; normal dashboard reads do not fetch pricing from the network.

The desktop shells reuse the same HTTP API. The Tauri app launches the backend as a local companion process, waits for readiness, and then loads the shared web UI against the injected API base URL. The GNOME app follows the same sidecar lifecycle, but renders project navigation, filters, issue detail, parser settings, sync history, review triage, saved views, and Multica export with native GTK/libadwaita controls.
