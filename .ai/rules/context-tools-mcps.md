---
purpose: "MCP integration rules and GitHub CLI patterns for AIRunX development"
last_updated: "2026-04-28"
---

# Tools & MCP Integration

## TL;DR
- GitHub CLI (`gh`) is the primary external tool integration
- MCP servers provide additional context (GitHub, custom)
- Always run independent tool calls in parallel
- Configure MCPs via `mcp.json` referenced in `settings.json`

---

## Use / Don't Use

**Use this doc when:**
- Working with GitHub issues, PRs, or repos
- Configuring MCP server integrations
- Building features that interact with external tools

**Don't use for:**
- Internal orchestration logic (see pipeline executor)
- Backend adapter details (see `src/adapters/`)

---

## GitHub CLI (`gh`)

AIRunX wraps `gh` for all GitHub operations. The wrapper lives in `src/integrations/github-cli.ts`.

### Setup
```bash
gh config set pager cat    # Prevent interactive paging (important for automation)
gh auth status             # Verify authentication
```

### Common Operations
```bash
# Issue management (heartbeat mode)
gh issue list --label "airunx:pending" --json number,title,assignees
gh issue edit <number> --add-label "airunx:running" --remove-label "airunx:pending"
gh issue comment <number> --body "Heartbeat: processing..."

# PR creation (pipeline output)
gh pr create --title "feat: description" --body-file pr-body.md
gh pr list --label "ai-generated"

# Context gathering
gh issue view <number> --json body,title,labels,comments
gh pr view <number> --json body,title,files,reviews
gh pr diff <number>
```

### Token Authentication
When `gh` CLI is not installed, AIRunX falls back to GitHub REST API using:
- `GH_TOKEN` (takes precedence, matching gh CLI behavior)
- `GITHUB_TOKEN`

Both work for all heartbeat operations (polling, labels, comments, assignment).

---

## MCP Server Configuration

AIRunX supports MCP (Model Context Protocol) servers for rich context gathering during agent execution.

### Configuration
Point to MCP config in `settings.json`:
```json
{
  "mcp_json_location": "./mcp.json"
}
```

Example `mcp.json`:
```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"]
    }
  }
}
```

### Available MCP Integrations
| MCP | Purpose | Credentials |
|-----|---------|-------------|
| GitHub | PRs, issues, repo context | `gh auth login` or `GITHUB_TOKEN` |

### MCP in Agent Pipelines
MCPs are forwarded to backend CLIs that support them. Context gathering agents use MCPs to collect requirements before implementation stages begin.

---

## Execution Rules

### Parallel Execution (Required)
When gathering context from multiple sources, always execute in parallel:

```markdown
# Correct: single message with multiple tool calls
- gh issue view 123
- gh pr list --label "related"

# Incorrect: sequential calls across messages
Message 1: gh issue view 123
[wait]
Message 2: gh pr list --label "related"
```

### Error Handling
- GitHub CLI errors are classified via `categorizeError()` in the adapter layer
- `NonRetryableError`: blocked commands (git push by agents), auth failures
- `RetryableError`: rate limits, network timeouts
- Circuit breaker protects against repeated backend failures

---

## Integration Points in Codebase

| File | Purpose |
|------|---------|
| `src/integrations/github-cli.ts` | GitHub CLI wrapper (issues, PRs, labels, comments) |
| `src/integrations/mcp-helpers.ts` | MCP server configuration and forwarding |
| `src/pr-automation/` | PR creation, title rules, label rules, templates |
| `src/heartbeat/` | GitHub Issue polling, task claiming, audit logging |

---

## Keywords/Queries

- GitHub CLI gh integration
- MCP Model Context Protocol
- GitHub Issues task queue
- PR creation automation
