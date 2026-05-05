---
purpose: "Guide for writing and maintaining .ai/rules/* context documents"
last_updated: "2026-04-25"
---

# Context Rules Updater

This guide defines how to write and maintain `.ai/rules/*` context documents so agents stay fast, precise, and within context windows.

## TL;DR
- Keep context docs small and skimmable (<=1,500 tokens per sub-doc)
- Use `context.md` as router; avoid duplicating content across files
- Include routing, exclude implementation plans
- Prefer bullets over prose, links over large examples
- Update `last_updated` frontmatter on every meaningful change

---

## Use / Don't Use

**Use this guide when:**
- Creating new `context-*.md` files
- Updating existing context documents
- Splitting oversized docs to stay within token budgets

**Don't use for:**
- Writing feature implementation code
- Creating project documentation (use README.md)
- Planning specific features (use issues/plans)

---

## Core Principles
- **Single source of truth**: Keep "how things work" and invariant specs here; link out for details
- **Small, skimmable, on-demand**: Each sub-doc must be consumable independently
- **Route, don't duplicate**: Use `context.md` to route; avoid repeating content across sub-docs
- **Stable references**: Prefer stable links (repo paths) over ephemeral content

---

## Token and Size Budgets
- **Root index (`context.md`)**: <= 800 words
- **Sub-docs (`context-*.md`)**: Target <= 1,500 tokens. Split before 2,000 tokens
- **Examples/code**: <= 300 tokens each; include only if they materially clarify a rule
- If a doc exceeds budget: split into `context-<topic-detail>.md` and update routing

---

## Include vs Exclude

### Include
- How things work (architecture, invariants, constraints)
- Specs, definitions, and concise procedures
- Routing to deeper docs and reference links
- Pointers to tests, commands, and entry points
- "Keywords/Queries" section at bottom for semantic search

### Exclude
- Forward-looking implementation plans or "next steps"
- Long narratives, meeting notes, or opinions
- Large code blocks (link out instead)
- Content already in another sub-doc or README

---

## Structure Template

```markdown
---
purpose: "one-line description"
last_updated: "YYYY-MM-DD"
---

# [Topic Name]

## TL;DR
- 5-8 bullets, crisp and actionable

## Use / Don't Use
**Use this when:** ...
**Don't use for:** ...

## Core Patterns
- Rule 1: Clear statement
- Rule 2: Clear constraint

## References
- [File](path/to/file.ts)
- [Docs](https://docs.example.com)

## Keywords/Queries
- keyword1, keyword2
```

---

## Optimization Playbook (when over budget)

1. **Collapse prose -> bullets**: Remove adverbs and qualifiers
2. **Move extended examples**: Link to docs or README sections
3. **Factor subsections**: Create dedicated files
4. **Prefer tables**: Use tables over paragraphs for settings/flags
5. **Deduplicate**: Single canonical section and cross-link

---

## Directory and Naming Conventions

- **Location**: `.ai/rules/`
- **Filenames**: `context-<topic>.md` (lowercase, kebab-case)
- **Index file**: `context.md` routes to all sub-docs
- **Update `last_updated`** on every meaningful change

---

## Authoring Checklist

- [ ] Follow token/word budgets (root <= 800 words; sub-doc <= 1,500 tokens)
- [ ] Keep "how it works/specs/links"; exclude implementation plans
- [ ] Route from `context.md`; no duplication
- [ ] Examples are short or linked out
- [ ] Frontmatter `last_updated` set
- [ ] Updated `context.md` routing table

---

## Keywords/Queries

- context file maintenance
- .ai/rules documentation
- token budget management
- context file structure
- agent context optimization
