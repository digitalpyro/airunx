---
purpose: "Testing conventions, CI constraints, and test design guidelines"
last_updated: "2026-05-06"
---

# Testing Guidelines

## CI Matrix

CI runs tests against **Node 18, 20, and 22**. All code and tests must pass on Node 18+.

## Test Framework

- **Vitest** 4.x with V8 coverage
- Coverage threshold: 80%
- Test files mirror `src/` structure in `tests/`

## Node 18 Constraints

Do NOT use these in tests — they break on Node 18:

- **jsdom** / **happy-dom** — ESM-only transitive deps fail with `require()` on Node 18
- **`node:inspector/promises`** — not available on Node 18
- **`fetch()`** without a guard — experimental on Node 18

## Testing Static HTML/CSS/JS

For testing static sites (e.g., `www/`), use lightweight approaches:

- Read HTML files with `fs.readFileSync()` and assert content with string matching or regex
- Use Vitest matchers (`toContain`, `toMatch`) — no DOM parsing needed
- Check file existence with `existsSync()`
- Validate CSS custom properties and selectors with regex on the CSS string

Do NOT use DOM parsing libraries (jsdom, cheerio, linkedom) for simple content assertions.

## Running Tests

```bash
npm test               # Run all tests
npm run test:watch     # Watch mode
npm run test:coverage  # With coverage report
```
