# User Overview

`codex-boards` now turns local Codex rollout history into a project-oriented issue board.

The current workflow is:

1. Scan rollout files under `~/.codex/sessions`
2. Keep only threads with Git workspace evidence
3. Truncate thread content to a cheap parse payload
4. Extract parent issues and optional sub-issues
5. Persist issues, Git evidence, and sync diagnostics in SQLite
6. Browse them in a Notion-style web/desktop workspace or a native GNOME workspace with projects, filters, saved views, and issue details

The UI emphasizes reviewability:

- every issue includes rollout path and thread id
- low-confidence parses are flagged for review
- commit and tag evidence are shown when present
- each sync run shows a per-file parse log for imported, skipped, and failed rollouts
- saved views can pin review queues or Git-heavy work
- the Usage page charts aggregate token history, estimated local fee, cached input, uncached input, reasoning output, and newly started threads by day
- the Settings dialog exposes the active parser base URL, model, and API key status, and those settings persist across backend restarts

Usage charts read aggregate token counters from local Codex logs, including archived sessions. Estimated fees require a local `usage-pricing.json` file; unpriced models remain visible instead of being hidden from totals.

The native GNOME app provides the same core workflows with GTK/libadwaita controls: project navigation, saved views, filtering, sync, parser settings, sync history, review toggles, traceability details, sub-issues, and Multica export.
