# User Overview

`codex-boards` now turns local Codex rollout history into a project-oriented issue board.

The current workflow is:

1. Configure the parser provider on first open; Codex CLI is selected by default
2. Choose the parse output language on a dedicated second setup step
3. Run the first sync from the onboarding sync screen, or skip to home and sync later
4. Scan rollout files under `~/.codex/sessions`
5. Keep only threads with Git workspace evidence
6. Truncate thread content to a cheap parse payload
7. Extract one issue per thread and collect image references
8. Persist issues, image evidence, Git evidence, and sync diagnostics in SQLite
9. Browse them in a Notion-style web/desktop workspace or a native GNOME workspace with projects, filters, saved views, and issue details

The UI emphasizes reviewability:

- every issue includes rollout path and thread id
- image references detected in the thread are shown in the detail sheet
- low-confidence parses are flagged for review
- commit and tag evidence are shown when present
- each sync run shows a per-file parse log for imported, skipped, and failed rollouts
- the homepage shows live sync status and the next scheduled background sync
- saved views can pin review queues or Git-heavy work
- the Usage page shows selected-interval token, fee, cache, thread, and index cards with all-device totals, plus charts for daily aggregate token history, cached input, uncached input, reasoning output, and newly started threads
- the Settings dialog exposes the active parser provider, model, API key status, output language, Codex CLI/Gemini/OpenRouter/DeepSeek presets, and those settings persist across backend restarts

After the first completed sync, the backend checks for rollout changes in the background once per minute. Unchanged files are skipped; changed files and parser setting changes are reparsed.

Usage charts read aggregate token counters from local Codex logs, including archived sessions. The usage API returns both the selected interval summary and an all-device total from the local index; the Usage page reads that `total` value for the all-device card rows and can fall back to `GET /api/usage?range=all-time` when needed. The usage index refreshes automatically after sync runs. Estimated fees use bundled standard pricing defaults for known models, and a local `usage-pricing.json` file can add or override rates. Unpriced models remain visible instead of being hidden from totals.

The native GNOME app provides the same core workflows with GTK/libadwaita controls: project navigation, saved views, filtering, sync, parser settings, sync history, review toggles, traceability details, and Multica export.
