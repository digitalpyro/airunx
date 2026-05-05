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
