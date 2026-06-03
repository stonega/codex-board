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
  - OpenAI-compatible parse client with heuristic fallback
- `apps/web`
  - React UI
  - Notion-style project/issues workspace
  - filters, saved views, and issue detail sheet
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
  - each run clears imported board data and rebuilds from the current rollout set
  - each run records a per-file parse log for imported, skipped, and failed rollouts
  - each run also records parser target, resolved response model(s), and token usage totals for auditability

## Inference strategy

The implementation stays heuristic and inspectable:

- import only Git-backed workspaces
- deterministically extract branch, commit, and tag evidence from thread/tool output
- truncate thread text before sending it to an OpenAI-compatible parser
- fall back to deterministic issue shaping when AI parsing fails
- flag low-confidence issues for review instead of hiding uncertainty

Opaque ML classification should not be the default path until the baseline heuristic layer is stable.

## API direction

Primary endpoints:

- `GET /api/health`
- `GET /api/settings`
- `POST /api/settings`
- `GET /api/projects`
- `GET /api/issues`
- `GET /api/issues/:id`
- `POST /api/sync`
- `GET /api/sync/runs`
- `GET /api/views`
- `POST /api/views`

The web UI consumes these endpoints directly and renders project navigation, filterable issue tables, a runtime parser settings sheet with sync history, and a right-side detail sheet.

The desktop shells reuse the same HTTP API. The Tauri app launches the backend as a local companion process, waits for readiness, and then loads the shared web UI against the injected API base URL. The GNOME app follows the same sidecar lifecycle, but renders project navigation, filters, issue detail, parser settings, sync history, review triage, saved views, and Multica export with native GTK/libadwaita controls.
