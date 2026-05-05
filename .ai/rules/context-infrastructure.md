---
purpose: "Technical infrastructure, tech stack, and project structure for AIRunX"
last_updated: "2026-04-25"
---

# Infrastructure & Technology Stack

## TL;DR
- **Runtime**: Node.js >=18, TypeScript 5.7, ESM modules
- **Orchestration**: LangGraph (DAG/state), LangChain Core
- **AI Backends**: Claude Code, Cursor, OpenAI Codex (subscription CLIs)
- **CLI**: Commander.js, Inquirer, Ora, Chalk
- **Testing**: Vitest 4.x with V8 coverage
- **Code Quality**: ESLint 9.x + Prettier
- **Validation**: Zod for runtime type safety
- **Config**: YAML (pipelines), Markdown (AGENTS.md), JSON (settings)

---

## Use / Don't Use

**Use this doc for:**
- Understanding project dependencies and structure
- Adding new dependencies (check compatibility)
- Troubleshooting build/runtime issues

**Don't use for:**
- Installation instructions (see README.md)
- CLI usage (see README.md CLI Reference)
- Agent role definitions (see config/default/AGENTS.md)

---

## Project Structure

```
airunx/
├── .ai/rules/                 # Context files for AI agents developing airunx
├── config/
│   └── default/               # Default AGENTS.md, pipelines.yaml, templates
├── src/
│   ├── adapters/              # Backend adapters (Claude Code, Cursor, Codex)
│   ├── agent-tools/           # Tools agents can call (complete_task, etc.)
│   ├── audit/                 # Audit logging (JSONL)
│   ├── cli/                   # Commander CLI entry points and commands
│   │   └── commands/          # Individual command handlers
│   ├── core/                  # Core types, schemas, stage definitions
│   ├── heartbeat/             # Heartbeat mode (GitHub Issue polling)
│   ├── integrations/          # GitHub CLI wrapper, MCP helpers
│   ├── orchestration/         # Review coordinator, verification
│   ├── orchestrator/          # LangGraph runner, pipeline executor, judge
│   ├── parsers/               # Input parsers (GitHub, PRD, prompt)
│   ├── pr-automation/         # PR creation, templates, labels
│   ├── skills/                # Skills discovery and loading
│   ├── task-queue/            # Task queue management
│   ├── tools/                 # Git worktree, cleanup utilities
│   └── utils/                 # Logger, config, todo manager, validators
├── tests/                     # Vitest test suites (mirrors src/ structure)
├── scripts/                   # Build/sync utilities
├── dist/                      # Compiled output (gitignored)
├── AGENTS.md                  # Repository guidelines (commit style, testing)
├── README.md                  # Full documentation and CLI reference
└── package.json               # Entry point: dist/cli/index.js
```

### Key Entry Points
- **CLI binary**: `airunx` -> `dist/cli/index.js`
- **CLI commands**: `src/cli/commands/*.ts` (run, init, doctor, heartbeat, etc.)
- **Pipeline executor**: `src/orchestrator/pipeline-executor.ts`
- **LangGraph runner**: `src/orchestrator/langgraph-runner.ts`
- **Backend adapters**: `src/adapters/` (claude-code, cursor, codex)

---

## Core Dependencies

### Orchestration
| Package | Version | Purpose |
|---------|---------|---------|
| `@langchain/langgraph` | ^0.2.32 | DAG workflow orchestration, state management |
| `@langchain/core` | ^0.3.28 | Base abstractions, tool/function interfaces |

### CLI & Terminal
| Package | Version | Purpose |
|---------|---------|---------|
| `commander` | ^12.1.0 | Command-line parsing, subcommand routing |
| `inquirer` | ^12.2.0 | Interactive prompts (init wizard) |
| `ora` | ^8.1.1 | Terminal spinners |
| `chalk` | ^5.4.1 | Terminal colors |
| `boxen` | ^8.0.1 | Boxed terminal output |
| `figlet` | ^1.9.4 | ASCII art banners |
| `gradient-string` | ^3.0.0 | Gradient text |

### Data & Config
| Package | Version | Purpose |
|---------|---------|---------|
| `zod` | ^3.24.1 | Runtime type validation, schema definitions |
| `yaml` | ^2.7.0 | Pipeline and config parsing |
| `handlebars` | ^4.7.8 | PR body templates |
| `jsonc-parser` | ^3.3.1 | JSON with comments parsing |
| `dotenv` | ^16.4.7 | Environment variable loading |
| `proper-lockfile` | ^4.1.2 | File locking (heartbeat singleton) |

### Development
| Package | Version | Purpose |
|---------|---------|---------|
| `typescript` | ^5.7.3 | ES2022, NodeNext modules, strict mode |
| `vitest` | ^4.0.16 | Test runner with watch mode |
| `@vitest/coverage-v8` | ^4.0.16 | V8-based code coverage |
| `eslint` | ^9.18.0 | Linting with @typescript-eslint |
| `prettier` | ^3.4.2 | Code formatting |

---

## Build & Development Commands

```bash
npm install            # Install dependencies
npm run build          # Compile TypeScript to dist/
npm run dev            # Watch mode (auto-rebuild)
npm test               # Run tests once
npm run test:watch     # Watch mode testing
npm run test:coverage  # Coverage report
npm run lint           # ESLint + Prettier check
npm run lint:fix       # Auto-fix lint issues
```

---

## Configuration Files

| File | Purpose |
|------|---------|
| `tsconfig.json` | TypeScript: ES2022, NodeNext, strict, outDir: dist/ |
| `eslint.config.js` | ESLint 9 flat config with @typescript-eslint + prettier |
| `vitest.config.ts` | Test config, coverage thresholds |
| `config/default/AGENTS.md` | Default agent role definitions |
| `config/default/pipelines.yaml` | Default pipeline stage definitions |
| `config/default/github_pull_request_template.md` | Handlebars PR body template |

---

## Environment Variables

### Required
```bash
# At least one backend CLI must be installed
# Claude Code: npm install -g @anthropic-ai/claude-code
# Codex: npm install -g @openai/codex
# Cursor: Install from cursor.com
```

### Optional
```bash
GITHUB_TOKEN=ghp_...          # GitHub API (for heartbeat, issue workflows)
GH_TOKEN=ghp_...              # Alternative (takes precedence)
ANTHROPIC_API_KEY=sk-ant-...  # Claude Code API key auth (vs subscription)
OPENAI_API_KEY=sk-...         # Codex API key auth (vs subscription)
AIRUNX_CHILD_TIMEOUT_MS=...   # Heartbeat child process timeout (default: 9000000)
DEBUG=false                    # Debug mode
```

---

## TypeScript Conventions

- **ESM only**: All imports use `.js` extensions (TypeScript NodeNext resolution)
- **Strict mode**: No implicit any, strict null checks
- **Zod schemas**: Runtime validation for all config files and agent outputs
- **Error handling**: Typed errors with `categorizeError()` for retry logic

---

## Git Worktree Strategy

AIRunX uses git worktrees for isolated pipeline execution:
1. `git worktree add` creates isolated directory with new branch
2. Pipeline runs entirely within the worktree
3. On completion: PR created, worktree cleaned up
4. Multiple pipelines can run in parallel from one machine

Worktrees are created in `.worktrees/` (gitignored).

---

## Keywords/Queries

- TypeScript ESM Node.js configuration
- LangGraph LangChain orchestration
- Commander CLI framework
- Vitest testing coverage
- Zod schema validation
- Git worktree parallel execution
- Backend adapter architecture
