# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.1.7] - 2026-10-26

### Added

- `get_run_cost` agent tool: returns the current run's cost summary (billed and API-equivalent totals, provenance mix, per-stage spend, top drivers) so agents can reason about spend mid-run. Aggregate numbers only, and limited to the agent's own run, like `query_audit`. Totals are partial while the run is in progress.
- `airunx costs reconcile` now also checks Anthropic token counts against the Admin API usage report for each closed UTC day. It reports drift per token class (uncached input, cache read, cache write, output), using the same admin key, workspace scope, finality and fail-closed rules as the dollar check. `--json` rows gain a `tokens` object.
- `mcp_config` setting on the `claude-code` backend: one or more absolute paths or inline JSON objects, passed to every spawn with `--mcp-config`

### Changed

- **Breaking:** requires Node.js 20 or later (`@langchain/core` 1.x dropped Node 18). CI now tests Node 20, 22 and 24
- Enum-keyed config maps (`agent_routing`, `backends`, fidelity `levels`) stay partial under zod 4 (`z.partialRecord`)
- **`--backend` now overrides the provider of every agent**, including agents that set `provider` in AGENTS.md. Logs show `[cli-override]`. If the chosen backend is unavailable, the run fails instead of falling back to the AGENTS.md provider. A per-agent AGENTS.md model meant for a different provider is ignored, with an info log, so a Claude model is never passed to codex.
- **Headless `claude` spawns no longer load your MCP servers.** Each spawn runs with `--strict-mcp-config` and `ENABLE_CLAUDEAI_MCP_SERVERS=false`, so claude.ai connectors and `~/.claude.json` / `.mcp.json` servers are not loaded. Use the new `mcp_config` setting to give spawns specific servers.
- `Iterations` in the run summary, `run --format json` metrics, run reports, PR and commit bodies, and heartbeat issue comments now counts the iterations actually run: 1 for a run accepted on the first pass. Reports written by older versions still hold the old count, which was one lower.
- Ctrl-C detection: `run` now skips its own SIGINT to child CLIs only when it is the terminal's foreground process group, checked with `ps` when the signal arrives. If the check fails, it sends SIGINT.

### Security

- Cleared every `npm audit` finding (26 in the repo, 8 shipped to installs, 3 critical): upgraded `zod` 3 → 4, `@langchain/core` 0.3 → 1.x and `@langchain/langgraph` 0.2 → 1.x, and raised the floors for `handlebars`, `figlet`, `yaml` and `vitest`

### Fixed

- `--backend codex` was ignored for agents with a `provider` in AGENTS.md (#20)
- In headless runs the orchestrator could see only the user's claude.ai connector tools, such as Claude Docs, and stop, treating itself as blocked (#20)
- Heartbeat completion comments showed `Iterations: 0` for a completed run (#20)
- A background (`&`) or `kill -INT`'d `run` attached to a TTY skipped SIGINT for its child CLIs, so Claude never got the chance to report its spend (#19)
- A `null` cache tier in provider usage data is treated as 0 instead of failing the reconcile

## [0.1.6] - 2026-10-19

### Added

- Claude 5.5 family: `claude-fable-5-1` ($10/$50), `claude-fable-5`, `claude-opus-5-5` ($4/$20), `claude-opus-5`, `claude-sonnet-5-5` ($2/$10), and `claude-haiku-5-5` ($0.10/$0.50 for prompts up to 100K tokens)
- GPT-6 family: `gpt-6-astra` ($10/$50), `gpt-6.1-sol` and `gpt-6-sol` ($2/$10), and `gpt-6-luna` ($0.10/$0.50)
- New `fable` alias (Fable 5.1), plus pinned aliases `fable-5.1`, `fable-5`, `opus-5.5`, `opus-5`, `sonnet-5.5`, and `haiku-5.5`
- Validation now flags OpenAI models with a scheduled API shutdown and suggests a replacement: a notice before the shutdown date and a warning once it has passed. Covers `gpt-4`, `gpt-4-turbo`, `gpt-3.5-turbo`, `o1`, and `o1-mini` (2026-10-23), `gpt-4o` and `gpt-4o-mini` (2027-01-14), and `gpt-5.3-codex` and `gpt-5.4-nano` (2027-04-01). Retirement warnings are still shown when cost warnings are turned off.
- Per-run spend ledger: every CLI spawn is written to the audit log as an attributed `llm_spawn` event, and each figure is labelled `reported`, `derived`, or `estimated`, and as either billed or API-equivalent
- Per-model prompt-cache pricing (cache reads plus 5-minute and 1-hour cache writes) for Anthropic and OpenAI
- `airunx costs [--workflow-id] [--json]` to show a run's spend, and `airunx costs reconcile` to compare API-key spend with provider billing
- The ledger now records which models a spawn actually ran on (`response_models`), as well as the model it requested

### Changed

- Aliases repointed: `opus` → Opus 5.5, `sonnet` → Sonnet 5.5, and `haiku` → Haiku 5.5
- Backend defaults are now `claude-sonnet-5-5` (Anthropic) and `gpt-6.1-sol` (OpenAI). Cursor passes the OpenAI default as `--model` on every run.
- Shipped `config/default/AGENTS.md` refreshed: new model table, and the codex reviewer and judge roles now use `gpt-6.1-sol`. The generated template and README examples were updated to match.
- Validation suggestions and cheaper-model hints no longer offer retiring models, or aliases that point to legacy models
- Cancelling a run now stops each CLI with SIGINT, then SIGTERM, then SIGKILL, and the heartbeat ends the whole process group, so no CLI keeps running after its run is killed
- Killed and timed-out runs now report a bounded `estimated` spend instead of $0
- Provider admin API keys are removed from the environment of every child process
- **Requires Codex CLI 0.163.0 or newer for GPT-6.** Older CLIs reject GPT-6 on a ChatGPT login. airunx then retries once on the CLI's own default model.

### Fixed

- Codex `auto` approval mode passed `--full-auto`, which Codex CLI 0.163 removed, so every codex stage failed. It now passes `--sandbox workspace-write`, which blocks writes outside the workspace exactly as `--full-auto` did, and older CLIs accept it too. Pipeline mode no longer passes `--sandbox` twice.
- When a model was set in the backend config, the codex model-rejection retry sent that same model again; it now drops `--model` as intended. The spend from the rejected first attempt is included in the stage total.
- Corrected prices: `gpt-5.6-sol` $4/$20, `gpt-5.6-terra` $2/$12, `gpt-5.6-luna` $0.20/$1.20; `claude-sonnet-5` $2/$10
- `heartbeat stop` during a task no longer leaves the issue labelled both `airunx:failed` and `airunx:pending`, and no longer crashes while releasing the task
- Spawns interrupted by shutdown are counted as killed-spawn losses, not retry waste
- "failed after N attempt(s)" now reports the number of attempts actually made
- If marking an issue as running fails, its `airunx:pending` label is restored and the error mentions possibly missing labels

## [0.1.5] - 2026-07-14

### Added

- Claude Sonnet 5 (`claude-sonnet-5`, $3/$15; introductory $2/$10 through 2026-08-31), Opus 4.8/4.7/4.6, Sonnet 4.6, and Haiku 4.5 to the Anthropic registry
- GPT-5.6 family (`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`) and `gpt-5.4-nano` to the OpenAI registry
- Real dated IDs `claude-sonnet-4-5-20250929` and `claude-opus-4-1-20250805`
- Cursor adapter test coverage for the default `--model` flag

### Changed

- Aliases repointed: `opus` → Opus 4.8, `sonnet` → Sonnet 5, `haiku` → Haiku 4.5; new `gpt-5.6` → `gpt-5.6-terra`
- Backend defaults: `claude-sonnet-5` (Anthropic) and `gpt-5.6-terra` (OpenAI)
- Shipped `config/default/AGENTS.md` template refreshed (model table, reviewer/judge roles moved to `gpt-5.6-terra`)
- Legacy models excluded from validation suggestions and cheaper-alternative hints while remaining valid for backward compatibility

### Fixed

- Corrected OpenAI prices (`gpt-5.5` $5/$30, `gpt-5.4-mini` $0.75/$4.50, `gpt-5.3-codex` $1.75/$14)
- Registry entries for Anthropic IDs that never existed upstream (`...20250514`, `...20250324`) are now marked legacy, with typo suggestions no longer recommending them
