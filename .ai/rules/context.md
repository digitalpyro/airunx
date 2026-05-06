---
purpose: "Overview, index, and routing for modular context rules"
last_updated: "2026-04-25"
---

# AIRunX - Context Index

## Project Overview

AIRunX is a **vendor-neutral Agent Orchestrator** that automates developer workflows. It executes end-to-end development tasks from GitHub issues, PRDs, or prompts using intelligent agent pipelines and produces pull requests.

### Core Architecture
- **Thin CLI layer** orchestrating multi-agent pipelines via LangGraph
- **AGENTS.md standard** for declarative agent role configuration
- **Subscription-based CLIs** (Claude Code, Cursor, Codex) as execution backends
- **Git worktree isolation** for parallel pipeline execution
- **Heartbeat mode** for continuous GitHub Issue polling as a task queue

### Execution Flow
1. **Ingestion**: Prompt, GitHub issue URL, or PRD file
2. **Orchestrator**: Plans implementation, selects pipeline
3. **Agent stages**: Dev Strategic → Dev Implementation → Reviewer → Static Analyzer → Test Creator → Judge
4. **Iteration**: Judge decides ITERATE (gaps found) or PROCEED (quality met)
5. **Delivery**: PR creation with execution metrics

---

## Tech Stack

- **Runtime**: Node.js >=18, TypeScript ES2022, ESM
- **Orchestration**: LangGraph + LangChain Core
- **CLI**: Commander.js, Inquirer, Ora, Chalk
- **Validation**: Zod schemas
- **Testing**: Vitest (>=80% coverage target)
- **AI Backends**: Claude Code, Cursor, OpenAI Codex

**For full details** -> [context-infrastructure.md](./context-infrastructure.md)

---

## Routing Index

### Context Files
| File | Use When |
|------|----------|
| [context-infrastructure.md](./context-infrastructure.md) | Setup, dependencies, build system, project structure |
| [context-tests.md](./context-tests.md) | Writing tests, test design, CI matrix constraints |
| [context-tools-mcps.md](./context-tools-mcps.md) | GitHub CLI operations, MCP server integration |
| [context-updater.md](./context-updater.md) | Creating or editing context docs in `.ai/rules/` |

### Project Documentation
| File | Use When |
|------|----------|
| [README.md](../../README.md) | Installation, CLI reference, configuration |
| [AGENTS.md](../../AGENTS.md) | Repository guidelines, commit style, testing |
| [config/default/AGENTS.md](../../config/default/AGENTS.md) | Default agent role definitions |
| [config/default/pipelines.yaml](../../config/default/pipelines.yaml) | Default pipeline stage definitions |

---

## Strategic Principles

- **Portability first**: Vendor-neutral design with backend adapters
- **Convention over configuration**: AGENTS.md and pipelines.yaml as standards
- **Thin layer**: Tie together OSS projects with minimal custom code
- **Metrics transparency**: Token usage, runtime, cost tracking per stage
- **MIT licensed**: Open source for personal and commercial use

---

## For Agents Working on AIRunX

1. Read this file first for orientation
2. Check [context-infrastructure.md](./context-infrastructure.md) for project structure
3. Check [context-tools-mcps.md](./context-tools-mcps.md) when working with GitHub or MCP integrations
4. Follow [AGENTS.md](../../AGENTS.md) for commit style and testing conventions
5. Run `npm test` and `npm run lint` before committing

---

## Keywords/Queries

- vendor-neutral agent orchestrator
- LangGraph multi-agent pipelines
- AGENTS.md workflow standard
- git worktree parallel execution
- heartbeat GitHub Issues task queue
- subscription CLI cost optimization
