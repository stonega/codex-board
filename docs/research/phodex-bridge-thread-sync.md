# Phodex Bridge Thread Sync Research

## Summary

This note documents how `~/Web/remodex/phodex-bridge` currently discovers, tracks, and rehydrates local Codex threads. The goal is to capture verified implementation details that can later drive a real sync feature in `codex-boards`.

The bridge does not rely on a single source of truth. Local thread sync is assembled from:

- live Codex RPC traffic through a spawned `codex app-server` process or a configured WebSocket endpoint
- persisted rollout files under `CODEX_HOME/sessions` or `~/.codex/sessions`
- remembered active-thread state under `~/.remodex/last-thread.json`

That split matters for `codex-boards`: a future importer cannot depend only on live transport events or only on rollout files if it wants stable thread summaries.

## Scope

Included in this research:

- local thread identity discovery
- active-thread persistence
- rollout file lookup and selection
- rollout-based context usage recovery
- rollout-based catch-up for desktop-origin thread activity
- implementation implications for `codex-boards`

Explicitly out of scope:

- device pairing
- relay encryption
- QR setup
- push notification delivery
- mobile UI behavior outside thread-sync needs

## Source Inventory

The relevant implementation lives in these `phodex-bridge` modules:

- `src/codex-transport.js`
  - abstracts Codex access through either `codex app-server` or a WebSocket endpoint
- `src/bridge.js`
  - central control flow; forwards RPC, remembers active threads, starts rollout watchers, sanitizes large thread history payloads
- `src/session-state.js`
  - persists and reopens the last active thread via `codex://threads/{threadId}`
- `src/rollout-watch.js`
  - resolves the local sessions root, finds rollout files, tails rollout growth, and extracts context-window usage
- `src/thread-context-handler.js`
  - exposes on-demand `thread/contextWindow/read` responses backed by rollout files
- `src/rollout-live-mirror.js`
  - mirrors desktop-origin rollout activity back into live notifications after `thread/read` or `thread/resume`
- `src/codex-desktop-refresher.js`
  - watches rollout growth and uses it as a refresh signal for the desktop app

Tests that lock in thread-sync expectations:

- `test/rollout-watch.test.js`
- `test/codex-transport.test.js`
- `test/bridge.test.js`
- `test/rollout-live-mirror.test.js`

## Current Sync Model

### 1. Live transport establishes thread identity

`src/codex-transport.js` builds the bridge’s Codex-side connection in one of two modes:

- spawn mode: launch `codex app-server`
- websocket mode: connect to an existing endpoint

That transport emits newline-delimited JSON messages back into `src/bridge.js`. The bridge parses those messages and extracts thread identifiers from thread and turn lifecycle traffic. The helper `rememberThreadFromMessage` then persists the thread id when present.

This means the bridge learns thread identity from runtime traffic first, not from scanning the sessions directory.

### 2. Session state remembers the last active thread

`src/session-state.js` stores the latest active thread in:

- state dir: `~/.remodex`
- state file: `~/.remodex/last-thread.json`

The payload contains:

- `threadId`
- `source`
- `updatedAt`

That state is used for two purposes:

- handoff and reopen via `codex://threads/{threadId}`
- fallback resolution when other code paths need a thread id and one was not explicitly provided

This is bridge-local state. It is not stored under `CODEX_HOME`.

### 3. Rollout files provide the durable local evidence

`src/rollout-watch.js` resolves the Codex sessions root as:

- `process.env.CODEX_HOME/sessions` when `CODEX_HOME` is set
- otherwise `~/.codex/sessions`

Rollout files are `.jsonl` files with names that start with `rollout-`. The bridge treats them as the durable local record for thread activity, usage, and replay after the live runtime stops emitting a complete picture.

### 4. Some sync state is reconstructed from rollout files

Two important capabilities are file-driven rather than transport-driven:

- `thread/contextWindow/read` in `src/thread-context-handler.js` reads the newest matching rollout and returns token usage plus `rolloutPath`
- `src/rollout-live-mirror.js` watches desktop-origin rollout files after `thread/read` or `thread/resume` and emits synthetic live notifications

The bridge therefore depends on persisted rollout files to fill gaps that live RPC does not reliably provide.

## Thread Lifecycle Mapping

### Learn

`src/bridge.js` extracts `threadId` and sometimes `turnId` from inbound and outbound messages. The key behaviors are:

- remember thread ids whenever a parsed bridge message exposes one
- start a context-usage watcher when a thread or turn is active
- track `thread/read` and `thread/resume` specially because they can trigger replay/catch-up behavior

### Persist

When a thread id is found, `rememberActiveThread(threadId, source)` writes the last-known thread to `~/.remodex/last-thread.json`.

This persistence is intentionally lightweight. It is not a full thread index. It is only the latest active thread.

### Reopen

`openLastActiveThread()` reads that file and opens:

```text
codex://threads/{threadId}
```

through the macOS `open` command with the Codex bundle id.

### Rehydrate

Once a thread is known, the bridge uses rollout selection rules to:

- find the relevant local rollout file
- stream growth events while the run is active
- recover context-window usage from the most recent matching rollout
- replay desktop-origin activity into synthetic notifications

## Rollout Discovery Rules

`src/rollout-watch.js` is the most important source file for later sync design.

### Sessions root

The local sessions root is:

- `${CODEX_HOME}/sessions` when `CODEX_HOME` is set
- otherwise `${HOME}/.codex/sessions`

This should become a first-class configuration input in `codex-boards`.

### Basic thread file lookup

`findRolloutFileForThread()` recursively scans the sessions tree and returns a file when all of these are true:

- filename contains the target `threadId`
- filename starts with `rollout-`
- filename ends with `.jsonl`

That helper is simple and not sufficient on its own for robust selection.

### Watch-time selection

`findRecentRolloutFileForWatch()` uses a two-stage strategy:

- collect recent rollout candidates, sorted newest first
- prefer a file containing the requested `turnId`
- otherwise prefer the newest same-thread rollout

If the recent candidate window misses the thread, the code falls back to a full-tree scan and still chooses the newest matching thread rollout.

### On-demand context-read selection

`findRecentRolloutFileForContextRead()` uses similar logic for read paths:

- collect rollout candidates from the full tree, sorted newest first
- prefer turn match when `turnId` is available
- then prefer newest same-thread filename match
- then scan file contents for a matching `threadId`

This protects against selecting a newer rollout from another thread.

### Why the newest same-thread rule matters

The tests in `test/rollout-watch.test.js` explicitly lock down these behaviors:

- same-thread rollout must beat newer unrelated files
- the newest rollout must win when a thread has multiple rollout files
- fallback scanning must still recover an older valid thread rollout when recent candidates miss it
- no match should return `null`

Any future `codex-boards` importer should preserve those exact precedence rules unless there is a deliberate migration away from rollout-file semantics.

## Rollout-Derived Behaviors Worth Reusing

### Context-window usage recovery

`src/thread-context-handler.js` serves `thread/contextWindow/read` by calling `readLatestContextWindowUsage()` from `src/rollout-watch.js`.

Important details:

- `threadId` is required
- `turnId` is optional but preferred when available
- result shape includes both `usage` and `rolloutPath`
- usage extraction prefers `last_token_usage.total_tokens` over cumulative totals

The tests show this is deliberate: the bridge wants last-turn usage, not session-total usage, when both are present.

### Rollout activity watching

`createThreadRolloutActivityWatcher()` polls until it finds a matching rollout file, then:

- watches for file growth
- emits a `materialized` event when the file first appears
- emits `growth` events as the file expands
- extracts usage snapshots as new token-count lines arrive
- stops after idle timeout, lookup timeout, or fatal filesystem errors

This is the bridge’s local approximation of “thread is actively running.”

### Desktop-origin live replay

`src/rollout-live-mirror.js` exists because desktop-origin activity is not always fully represented through the current relay/runtime path.

It starts mirroring only after inbound:

- `thread/read`
- `thread/resume`

Then it:

- finds the matching rollout
- bootstraps state from the existing file
- tails new lines
- emits synthetic app-server-like notifications
- stops on idle or lookup timeout

For `codex-boards`, this is evidence that replay from persisted rollout files is a real product requirement, not an implementation quirk.

## Thread History Payload Constraints

`src/bridge.js` sanitizes `thread/read` and `thread/resume` payloads by replacing inline image blobs with a lightweight reference URL:

```text
remodex://history-image-elided
```

This is a transport optimization, but it has ingestion implications:

- historical thread payloads may be intentionally incomplete
- a consumer cannot assume inline binary artifacts survive transport
- thread summaries should treat images as optional evidence, not required content

## Risks And Constraints

- Local-only assumption: the bridge assumes access to a local Codex sessions directory.
- Rollout format coupling: usage recovery and replay both depend on the current `.jsonl` event layout.
- Eventual consistency: live RPC and persisted rollout files can lag each other.
- Partial state: the bridge only remembers the latest active thread, not a full local thread catalog.
- Platform-specific reopen path: `openLastActiveThread()` is macOS-oriented.
- File scanning cost: the fallback full-tree scan is correct but can become expensive as sessions accumulate.

## Implications For `codex-boards`

The current `codex-boards` architecture in `docs/design/architecture.md` already points toward:

- local-first ingestion
- heuristic and inspectable inference
- deterministic backend contracts
- shared models in `packages/domain`

The `phodex-bridge` findings fit that direction well.

### Minimum viable sync shape

A first real importer in `apps/backend` should likely separate these concerns:

- local thread discovery from rollout files
- normalization of raw rollout evidence into deterministic thread records
- board shaping from normalized thread records into existing `packages/domain` contracts

### Candidate normalized fields

For later extension of `packages/domain`, the importer will likely need fields beyond the current `RawHistoryThread` shape:

- `threadId`
- `turnId`
- `source` such as `rpc`, `rollout`, or `session_state`
- `rolloutPath`
- `cwd`
- `timestamp`
- `tokensUsed`
- `tokenLimit`
- `title`
- `summary`
- optional raw evidence references

The board layer does not need every raw field, but the ingestion layer probably does.

### Recommended backend responsibilities

The backend should own:

- resolving the sessions root
- enumerating rollout candidates
- applying deterministic precedence rules for thread and turn matching
- extracting stable thread summaries from rollout evidence
- exposing board-friendly normalized responses

The frontend should not scan `~/.codex/sessions` directly.

### Relationship to current shared types

`packages/domain/src/index.ts` currently expects `RawHistoryThread` to contain:

- `threadId`
- `title`
- `summary`
- optional `cwd`
- `timestamp`
- optional git context

That means a later sync implementation can start by mapping rollout-derived thread summaries into `RawHistoryThread`, then extend the domain package only when the importer needs richer evidence fields that cannot stay backend-local.

## Recommended Implementation Direction

When this research is turned into code, the safest first step is:

1. Add a backend-only rollout reader in `apps/backend`.
2. Reuse the same precedence rules proven in `phodex-bridge`.
3. Normalize rollout evidence into deterministic thread summaries.
4. Map those summaries into the existing board contract.
5. Add fixtures and deterministic tests modeled after `phodex-bridge/test/rollout-watch.test.js`.

This avoids over-designing a full sync engine before basic local ingestion is stable.

## Open Questions For Implementation

- What is the exact rollout line schema produced by the local Codex runtime across versions, beyond the token-count and task events exercised in `phodex-bridge` tests?
- Does `codex-boards` need only file-based ingestion, or should it also support a live app-server transport path?
- Should remembered last-active-thread state from `~/.remodex/last-thread.json` be consumed directly, or treated only as optional auxiliary evidence?
- When multiple rollout files exist for one thread, do we want only the newest summary or a stitched session history?
- Which rollout-derived fields belong in shared domain types versus backend-private ingestion records?

## Recommended Acceptance Criteria For The Future Feature

The later implementation should be considered correct only if it can:

- find the Codex sessions directory from `CODEX_HOME` or the default home path
- ignore newer unrelated rollout files when a same-thread rollout exists
- prefer the newest same-thread rollout when duplicates exist
- fall back to older valid same-thread rollouts outside the recent candidate slice
- extract deterministic thread summaries from rollout evidence
- produce board data that remains stable across repeated imports of unchanged local files
