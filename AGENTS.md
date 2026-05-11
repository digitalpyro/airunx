# Repository Guidelines

## Project Structure & Module Organization
Keep the root lean. Agent orchestration assets live under `.ai/`: `rules/` holds context packs and integration policies, and `scripts/` exposes MCP wrapper scripts for external integrations. Place executable CLI code in `src/` (create it if missing) with clear module folders (`cli/`, `workflows/`, `integrations/`), and mirror the layout inside `tests/`. Add `.agents/` for shared prompts and manifests when pipelines land; keep generated worktrees and build outputs untracked.

## Build, Test, and Development Commands
Run `npm install` to pull dependencies after cloning. Use `npm run build` to emit the CLI bundle, and `npm run dev` for watch-mode iteration. Keep `npm run lint` clean before opening reviews, and execute `npm test` for the automated suite. For MCP experimentation, use the corresponding wrapper scripts in `.ai/scripts/`.

## Coding Style & Naming Conventions
Author TypeScript with ES modules and 2-space indentation. Export one primary symbol per file; prefer `camelCase` for functions and `PascalCase` for classes. Configuration, agent manifests, and workflow specs should use `kebab-case` filenames. Format with Prettier and keep ESLint warnings at zero (wire both to `npm run lint`). Shell utilities may be added in `.ai/scripts/`; ensure they use `#!/bin/bash` and defensive env loading like the existing wrappers.

## Testing Guidelines
Target Vitest for unit coverage and integration stubs; structure files as `*.spec.ts` mirroring the module path. Smoke tests for multi-agent pipelines should live in `tests/pipeline/` and rely on fixture prompts. Maintain ≥80% branch coverage, note temporary gaps in `tests/README.md`, and run `npm test -- --coverage` before merging substantial work. Add regression cases whenever a bug is fixed.

## Commit & Pull Request Guidelines
Write commits in imperative mood with a short scope prefix, e.g., `cli: wire LangGraph runner`. Favor focused commits over catch-all dumps. Every PR needs a summary, testing notes, and links to the originating ticket or MCP transcript. Include screenshots or logs when changing CLI output. Request at least one reviewer and wait for CI + lint + test checks to pass before merging.

## Environment & Secrets
Store API keys in `.env` (never commit it). The wrapper scripts auto-load this file; confirm required keys such as `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` before running orchestration workflows. For shared environments, use `.env.example` with placeholder values so new contributors can bootstrap credentials safely.

## Known Patterns & Limitations

### `process.exit()` in CLI Commands
CLI commands (`run.ts`, `init.ts`, `heartbeat.ts`, `cleanup.ts`, `validate.ts`, `agents-validate.ts`, `circuit.ts`) use `process.exit()` for termination. This is intentional — CLI adapters spawn child processes (Claude Code, Codex, Cursor) that hold open file handles and event-loop references. Without an explicit exit, Node.js waits indefinitely for those handles to release. This is a known limitation of the underlying CLI SDKs, not a resource leak in our code. The `run.ts` command documents this at its exit point (line ~935). Do not replace `process.exit()` with thrown errors in CLI entry points — the process will hang.

### Threat Model: Disallowed Tools in Agent Prompts
Non-orchestrator agents receive a `## RESTRICTIONS` section in their prompts (see `base-adapter.ts:buildPrompt()`) that blocks git write operations (`git commit`, `git push`, `git add`) and GitHub mutation commands (`gh pr create`, `gh issue edit`). This is a defense-in-depth measure — agents share a git worktree and have filesystem access, so a misbehaving agent could commit malicious code or create unauthorized PRs. The restrictions are enforced at the prompt level (soft constraint) because CLI-based agents cannot have tool-level access control. Read-only git/gh commands are allowed for context gathering. The orchestrator agent is exempt since it manages the commit-and-PR lifecycle. This is not a hard security boundary — it relies on agent compliance — but it prevents accidental mutations and raises the bar for prompt injection attacks that attempt to escalate agent capabilities.
