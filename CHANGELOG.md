# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
