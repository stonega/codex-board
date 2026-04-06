# AGENTS.md

This document defines how AI agents should work in this repository.

Agents must follow these conventions when reading, modifying, or generating code.

## 1. Project Structure

Repository layout:

```text
codex-boards/
├ README.md
├ AGENTS.md
├ apps/
│  ├ backend/         # API for ingestion, indexing, and board queries
│  └ web/             # browser UI for browsing projects and threads
├ packages/
│  └ domain/          # shared board types, classifiers, and parsing contracts
├ docs/
│  ├ design/          # architecture and system design
│  ├ implementation/  # technical implementation notes
│  └ user/            # end-user documentation
├ tests/              # automated tests for shared logic
├ scripts/            # idempotent automation scripts
├ examples/           # sample inputs and payloads
└ postmortem/         # incident reports and retrospectives
```

Agents must preserve this structure.

## 2. Development Workflow

Agents must follow this workflow when implementing features:

1. Read relevant documents in `docs/design` and `docs/implementation`
2. Prefer extending shared contracts in `packages/domain` before duplicating app-local types
3. Implement API behavior inside `apps/backend`
4. Implement UI behavior inside `apps/web`
5. Add or update tests in `tests`
6. Update documentation when architecture, contracts, or workflows change

## 3. Coding Rules

Agents must follow these rules:

- Do not introduce new frameworks without justification
- Keep functions small and composable
- Prefer readable heuristics over opaque classification logic
- Keep backend contracts deterministic and serializable
- Avoid duplication between backend and frontend by pushing shared models into `packages/domain`

When modifying code:

- Prefer editing existing modules over creating parallel ones
- Follow existing naming conventions
- Keep mock data and examples clearly separated from production ingestion logic

## 4. Testing Requirements

All new features must include tests.

Tests must be deterministic and should prefer:

- Unit tests for parsers and classifiers
- Integration tests for board payload shaping
- Fixtures over live device history where possible

Agents must run relevant tests before finishing a task.

## 5. Documentation Rules

Documentation must be updated when:

- architecture changes
- APIs change
- ingestion assumptions change
- new workflows are added

Docs location rules:

- Architecture: `docs/design`
- Implementation detail: `docs/implementation`
- User documentation: `docs/user`

## 6. Examples

When introducing new APIs, classifiers, or ingestion workflows, agents must add or update examples in `examples/`.

Examples should be small, explicit, and reusable in tests.

## 7. Scripts

Automation scripts go into `scripts/`.

Scripts should be idempotent and safe to run repeatedly.

## 8. Postmortems

When bugs or ingestion failures occur, create a report in `postmortem/`.

Each postmortem should cover:

- what happened
- root cause
- fix
- prevention

## 9. Safety Rules

Agents must not:

- delete large sections of code without reason
- change project structure casually
- replace explicit heuristics with hidden remote dependencies
- modify ingestion-related data examples without checking downstream tests

When unsure, agents should request clarification.

## 10. Pull Requests

Agent-generated changes must:

- pass relevant tests
- follow repository conventions
- include documentation updates when contracts or workflows change

