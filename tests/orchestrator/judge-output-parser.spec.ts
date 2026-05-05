/**
 * Tests for Judge Output Parser
 * Comprehensive coverage for structured output parsing strategies
 */

import { describe, it, expect } from 'vitest';
import {
  JudgeOutputParser,
  parseJudgeOutput,
  toLegacyFormat,
  type ParsedJudgeOutput,
} from '../../src/orchestrator/judge-output-parser.js';

describe('JudgeOutputParser', () => {
  describe('JSON Markdown Block Parsing', () => {
    it('should parse JSON in triple-backtick code block', () => {
      const output = `Here's my assessment:

\`\`\`json
{
  "decision": "ITERATE",
  "reason": "Test coverage is below threshold",
  "gaps": ["Increase coverage to 80%", "Add integration tests"]
}
\`\`\`

Let me know if you need more details.`;

      const result = parseJudgeOutput(output);

      expect(result.decision).toBe('ITERATE');
      expect(result.reason).toBe('Test coverage is below threshold');
      expect(result.rawGaps).toHaveLength(2);
      expect(result.rawGaps).toContain('Increase coverage to 80%');
      expect(result.rawGaps).toContain('Add integration tests');
      expect(result.strategy).toBe('json_markdown_block');
      expect(result.confidence).toBe('high');
    });

    it('should parse JSON without language specifier', () => {
      const output = `\`\`\`
{
  "decision": "PROCEED",
  "reason": "All checks passed"
}
\`\`\``;

      const result = parseJudgeOutput(output);

      expect(result.decision).toBe('PROCEED');
      expect(result.reason).toBe('All checks passed');
      expect(result.strategy).toBe('json_markdown_block');
    });

    it('should handle lowercase decision values', () => {
      const output = `\`\`\`json
{
  "decision": "iterate",
  "reason": "needs work",
  "gaps": ["fix bugs"]
}
\`\`\``;

      const result = parseJudgeOutput(output);

      expect(result.decision).toBe('ITERATE');
    });

    it('should parse gaps with severity metadata', () => {
      const output = `\`\`\`json
{
  "decision": "ITERATE",
  "reason": "Multiple issues found",
  "gaps": [
    {"description": "Critical security flaw", "severity": "critical"},
    {"description": "Missing tests", "severity": "major"},
    {"description": "Code style issues", "severity": "minor"}
  ]
}
\`\`\``;

      const result = parseJudgeOutput(output);

      expect(result.gaps).toHaveLength(3);
      expect(result.gaps[0].severity).toBe('critical');
      expect(result.gaps[1].severity).toBe('major');
      expect(result.gaps[2].severity).toBe('minor');
    });

    it('should extract severity from string gaps in JSON', () => {
      const output = `\`\`\`json
{
  "decision": "ITERATE",
  "reason": "Issues found",
  "gaps": [
    "[critical] A very bad bug",
    "[major] Missing validation",
    "(minor) Code style issue"
  ]
}
\`\`\``;

      const result = parseJudgeOutput(output);

      expect(result.gaps).toHaveLength(3);
      expect(result.gaps[0].description).toBe('A very bad bug');
      expect(result.gaps[0].severity).toBe('critical');
      expect(result.gaps[1].description).toBe('Missing validation');
      expect(result.gaps[1].severity).toBe('major');
      expect(result.gaps[2].description).toBe('Code style issue');
      expect(result.gaps[2].severity).toBe('minor');
    });

    it('should parse optional metadata fields', () => {
      const output = `\`\`\`json
{
  "decision": "ITERATE",
  "reason": "Needs improvement",
  "gaps": ["Fix error handling"],
  "suggestedNextSteps": ["Review error patterns", "Add try-catch blocks"],
  "estimatedEffort": "2-3 hours"
}
\`\`\``;

      const result = parseJudgeOutput(output);

      expect(result.metadata?.suggestedNextSteps).toHaveLength(2);
      expect(result.metadata?.estimatedEffort).toBe('2-3 hours');
    });
  });

  describe('Raw JSON Parsing', () => {
    it('should parse raw JSON without code block', () => {
      const output = `{"decision":"PROCEED","reason":"All good","gaps":[]}`;

      const result = parseJudgeOutput(output);

      expect(result.decision).toBe('PROCEED');
      expect(result.strategy).toBe('json_raw');
      expect(result.confidence).toBe('high');
    });

    it('should extract JSON object from mixed content', () => {
      const output = `After reviewing the implementation, here is my verdict:
      {"decision": "ITERATE", "reason": "Coverage insufficient", "gaps": ["Add more tests"]}
      Please address these concerns.`;

      const result = parseJudgeOutput(output);

      expect(result.decision).toBe('ITERATE');
      expect(result.strategy).toBe('json_raw');
    });

    it('should handle alternative field names', () => {
      const output = `{
        "verdict": "proceed",
        "explanation": "Everything looks acceptable",
        "issues": []
      }`;

      const result = parseJudgeOutput(output);

      expect(result.decision).toBe('PROCEED');
      expect(result.reason).toBe('Everything looks acceptable');
    });

    it('should not be confused by trailing braces in text', () => {
      // This tests the brace-counting parser - greedy regex would fail here
      const output = `{"decision": "ITERATE", "reason": "Issues found", "gaps": ["Fix bug"]} but this might fail } or have more { braces }`;

      const result = parseJudgeOutput(output);

      expect(result.decision).toBe('ITERATE');
      expect(result.reason).toBe('Issues found');
      expect(result.rawGaps).toContain('Fix bug');
      expect(result.strategy).toBe('json_raw');
      expect(result.confidence).toBe('high');
    });

    it('should find correct JSON among multiple brace pairs', () => {
      const output = `Some text with {random braces} and then the real JSON:
      {"decision": "PROCEED", "reason": "All good", "gaps": []}
      followed by more {stuff} here.`;

      const result = parseJudgeOutput(output);

      expect(result.decision).toBe('PROCEED');
      expect(result.strategy).toBe('json_raw');
    });
  });

  describe('Partial JSON Parsing', () => {
    it('should extract decision from malformed JSON', () => {
      const output = `{
        "decision": "ITERATE",
        "reason": "Needs more work"
        "gaps": ["missing comma above"]
      }`;

      const result = parseJudgeOutput(output);

      expect(result.decision).toBe('ITERATE');
      expect(result.strategy).toBe('json_partial');
      expect(result.confidence).toBe('medium');
    });

    it('should extract gaps array from partial JSON', () => {
      const output = `The analysis shows: {"decision": "ITERATE", incomplete json
      but "gaps": ["Issue 1", "Issue 2"] were found`;

      const result = parseJudgeOutput(output);

      expect(result.decision).toBe('ITERATE');
      expect(result.rawGaps).toContain('Issue 1');
      expect(result.rawGaps).toContain('Issue 2');
    });

    it('should extract object gaps with severity from partial JSON', () => {
      const output = `{"decision": "ITERATE", malformed
      "gaps": [{"description": "Security issue", "severity": "critical"}, {"description": "Missing tests", "severity": "major"}] more garbage`;

      const result = parseJudgeOutput(output);

      expect(result.decision).toBe('ITERATE');
      expect(result.gaps).toHaveLength(2);
      expect(result.gaps[0].description).toBe('Security issue');
      expect(result.gaps[0].severity).toBe('critical');
      expect(result.gaps[1].description).toBe('Missing tests');
      expect(result.gaps[1].severity).toBe('major');
    });

    it('should not extract JSON keys as gaps', () => {
      const output = `{"decision": "ITERATE", broken json
      "gaps": [{"description": "Real gap", "severity": "minor", "category": "Testing"}]`;

      const result = parseJudgeOutput(output);

      expect(result.decision).toBe('ITERATE');
      // Should only have the actual gap, not "description", "severity", or "category" as gaps
      expect(result.gaps).toHaveLength(1);
      expect(result.gaps[0].description).toBe('Real gap');
      expect(result.rawGaps).not.toContain('description');
      expect(result.rawGaps).not.toContain('severity');
      expect(result.rawGaps).not.toContain('category');
    });

    it('should handle nested objects within gaps', () => {
      const output = `{"decision": "ITERATE", broken
      "gaps": [{"description": "Complex gap", "details": {"impact": "high", "area": "security"}, "severity": "critical"}]`;

      const result = parseJudgeOutput(output);

      expect(result.decision).toBe('ITERATE');
      expect(result.gaps).toHaveLength(1);
      expect(result.gaps[0].description).toBe('Complex gap');
      expect(result.gaps[0].severity).toBe('critical');
    });

    it('should handle deeply nested objects in gaps', () => {
      const output = `{"decision": "ITERATE", "gaps": [{"description": "Deep nesting", "meta": {"level1": {"level2": {"value": true}}}, "severity": "major"}]}`;

      const result = parseJudgeOutput(output);

      expect(result.decision).toBe('ITERATE');
      expect(result.gaps).toHaveLength(1);
      expect(result.gaps[0].description).toBe('Deep nesting');
      expect(result.gaps[0].severity).toBe('major');
    });

    it('should handle multiple gaps with nested objects', () => {
      const output = `{"decision": "ITERATE", malformed
      "gaps": [
        {"description": "Gap 1", "data": {"x": 1}},
        {"description": "Gap 2", "data": {"y": {"z": 2}}},
        {"description": "Gap 3"}
      ]`;

      const result = parseJudgeOutput(output);

      expect(result.decision).toBe('ITERATE');
      expect(result.gaps).toHaveLength(3);
      expect(result.gaps[0].description).toBe('Gap 1');
      expect(result.gaps[1].description).toBe('Gap 2');
      expect(result.gaps[2].description).toBe('Gap 3');
    });
  });

  describe('Structured Regex Parsing', () => {
    it('should parse DECISION/REASON/GAPS format', () => {
      const output = `DECISION: ITERATE

REASON: Test coverage is below the required threshold

GAPS:
- Increase test coverage to 80%
- Add error handling tests
- Include edge case tests`;

      const result = parseJudgeOutput(output);

      expect(result.decision).toBe('ITERATE');
      expect(result.reason).toBe(
        'Test coverage is below the required threshold'
      );
      expect(result.rawGaps).toHaveLength(3);
      expect(result.strategy).toBe('regex_structured');
      expect(result.confidence).toBe('medium');
    });

    it('should handle VERDICT as alternative to DECISION', () => {
      const output = `VERDICT: PROCEED
REASON: All acceptance criteria met`;

      const result = parseJudgeOutput(output);

      expect(result.decision).toBe('PROCEED');
      expect(result.strategy).toBe('regex_structured');
    });

    it('should parse gaps with different bullet styles', () => {
      const output = `DECISION: ITERATE
REASON: Issues found
GAPS:
* First issue
- Second issue
• Third issue
1. Fourth issue
2) Fifth issue`;

      const result = parseJudgeOutput(output);

      expect(result.rawGaps).toHaveLength(5);
      expect(result.rawGaps).toContain('First issue');
      expect(result.rawGaps).toContain('Fifth issue');
    });

    it('should extract severity from gap text', () => {
      const output = `DECISION: ITERATE
REASON: Multiple severity issues
GAPS:
- [critical]: Security vulnerability found
- [major]: Missing input validation
- (minor) Code formatting issue`;

      const result = parseJudgeOutput(output);

      expect(result.gaps[0].severity).toBe('critical');
      expect(result.gaps[1].severity).toBe('major');
      expect(result.gaps[2].severity).toBe('minor');
    });

    it('should extract category from gap text', () => {
      const output = `DECISION: ITERATE
REASON: Various issues
GAPS:
- [Security] SQL injection risk
- [Testing] Missing unit tests`;

      const result = parseJudgeOutput(output);

      expect(result.gaps[0].category).toBe('Security');
      expect(result.gaps[1].category).toBe('Testing');
    });

    it('should handle category before severity in gap text', () => {
      const output = `DECISION: ITERATE
REASON: Documentation issues
GAPS:
- [Docs] [minor] Update README
- [critical] [API] Breaking change detected`;

      const result = parseJudgeOutput(output);

      expect(result.gaps[0].category).toBe('Docs');
      expect(result.gaps[0].severity).toBe('minor');
      expect(result.gaps[0].description).toBe('Update README');
      expect(result.gaps[1].category).toBe('API');
      expect(result.gaps[1].severity).toBe('critical');
      expect(result.gaps[1].description).toBe('Breaking change detected');
    });
  });

  describe('Freeform Regex Parsing', () => {
    it('should infer ITERATE from natural language', () => {
      const output = `The implementation needs more work. Test coverage is insufficient
      and the code requires additional iteration before it can be approved.`;

      const result = parseJudgeOutput(output);

      expect(result.decision).toBe('ITERATE');
      expect(result.strategy).toBe('regex_freeform');
      expect(result.confidence).toBe('low');
    });

    it('should infer PROCEED from natural language', () => {
      const output = `All criteria have been met and the implementation looks good.
      The code is ready to proceed to the next stage.`;

      const result = parseJudgeOutput(output);

      expect(result.decision).toBe('PROCEED');
      expect(result.strategy).toBe('regex_freeform');
    });

    it('should extract issues from freeform text', () => {
      const output = `The implementation is not acceptable. Issues identified:
      - Missing error handling
      - No input validation
      The code needs additional iteration.`;

      const result = parseJudgeOutput(output);

      expect(result.decision).toBe('ITERATE');
      expect(result.rawGaps.length).toBeGreaterThan(0);
    });

    it('should detect failure keywords', () => {
      const output = `Several checks failed. The criteria for test coverage was not met.`;

      const result = parseJudgeOutput(output);

      expect(result.decision).toBe('ITERATE');
    });

    it('should detect approval keywords', () => {
      const output = `The implementation is approved. All requirements have been satisfied.`;

      const result = parseJudgeOutput(output);

      expect(result.decision).toBe('PROCEED');
    });
  });

  describe('Fallback Behavior', () => {
    it('should use fallback when output is empty', () => {
      const result = parseJudgeOutput('');

      expect(result.strategy).toBe('fallback_default');
      expect(result.confidence).toBe('low');
    });

    it('should use unmet criteria as gaps in fallback', () => {
      const result = parseJudgeOutput('Random unparseable content xyz', {
        unmetCriteria: ['Coverage < 80%', 'Lint errors'],
      });

      expect(result.decision).toBe('ITERATE');
      expect(result.rawGaps).toContain('Coverage < 80%');
      expect(result.rawGaps).toContain('Lint errors');
    });

    it('should use findings when no unmet criteria', () => {
      const result = parseJudgeOutput('Unparseable', {
        unmetCriteria: [],
        findings: ['Some warning detected'],
      });

      expect(result.rawGaps).toContain('Some warning detected');
    });

    it('should default to PROCEED when no unmet criteria', () => {
      const result = parseJudgeOutput('Unparseable content', {
        unmetCriteria: [],
        defaultDecision: 'PROCEED',
      });

      expect(result.decision).toBe('PROCEED');
    });
  });

  describe('Gap Deduplication', () => {
    it('should deduplicate identical gaps', () => {
      const output = `DECISION: ITERATE
REASON: Issues found
GAPS:
- Add error handling
- Add error handling
- Add Error Handling`;

      const result = parseJudgeOutput(output);

      expect(result.rawGaps).toHaveLength(1);
    });

    it('should preserve severity during deduplication', () => {
      const output = `\`\`\`json
{
  "decision": "ITERATE",
  "reason": "Issues",
  "gaps": [
    "Fix the bug",
    {"description": "Fix the bug", "severity": "critical"}
  ]
}
\`\`\``;

      const result = parseJudgeOutput(output);

      expect(result.gaps).toHaveLength(1);
      expect(result.gaps[0].severity).toBe('critical');
    });

    it('should keep higher severity when less severe is encountered first', () => {
      const output = `\`\`\`json
{
  "decision": "ITERATE",
  "reason": "Issues",
  "gaps": [
    {"description": "Fix the bug", "severity": "minor"},
    {"description": "Fix the bug", "severity": "critical"},
    {"description": "Fix the bug", "severity": "major"}
  ]
}
\`\`\``;

      const result = parseJudgeOutput(output);

      expect(result.gaps).toHaveLength(1);
      // Should keep critical (highest severity), not minor (first seen)
      expect(result.gaps[0].severity).toBe('critical');
    });

    it('should merge category during deduplication', () => {
      const output = `\`\`\`json
{
  "decision": "ITERATE",
  "reason": "Issues",
  "gaps": [
    {"description": "Fix the bug", "severity": "minor"},
    {"description": "Fix the bug", "category": "Security"}
  ]
}
\`\`\``;

      const result = parseJudgeOutput(output);

      expect(result.gaps).toHaveLength(1);
      expect(result.gaps[0].severity).toBe('minor');
      expect(result.gaps[0].category).toBe('Security');
    });
  });

  describe('Parser Options', () => {
    it('should preserve raw output when option enabled', () => {
      const output = `\`\`\`json
{"decision": "PROCEED", "reason": "OK"}
\`\`\``;

      const result = parseJudgeOutput(output, { preserveRawOutput: true });

      expect(result.metadata?.originalOutput).toBe(output);
    });

    it('should use custom default decision', () => {
      const parser = new JudgeOutputParser({ defaultDecision: 'PROCEED' });
      const result = parser.parse('unparseable');

      expect(result.decision).toBe('PROCEED');
    });
  });

  describe('Legacy Format Conversion', () => {
    it('should convert to legacy JudgeResult format', () => {
      const output = `\`\`\`json
{
  "decision": "ITERATE",
  "reason": "Needs work",
  "gaps": ["Fix A", "Fix B"]
}
\`\`\``;

      const parsed = parseJudgeOutput(output);
      const legacy = toLegacyFormat(parsed);

      expect(legacy.decision).toBe('ITERATE');
      expect(legacy.reason).toBe('Needs work');
      expect(legacy.gaps).toEqual(['Fix A', 'Fix B']);
      expect(legacy.shouldIterate).toBe(true);
    });

    it('should set shouldIterate correctly for PROCEED', () => {
      const output = `{"decision": "PROCEED", "reason": "OK"}`;

      const parsed = parseJudgeOutput(output);
      const legacy = toLegacyFormat(parsed);

      expect(legacy.shouldIterate).toBe(false);
    });
  });

  describe('Edge Cases', () => {
    it('should handle whitespace-only output', () => {
      const result = parseJudgeOutput('   \n\t  \n  ');

      expect(result.strategy).toBe('fallback_default');
    });

    it('should handle very long output', () => {
      const longReason = 'A'.repeat(10000);
      const output = `\`\`\`json
{"decision": "ITERATE", "reason": "${longReason}"}
\`\`\``;

      const result = parseJudgeOutput(output);

      expect(result.decision).toBe('ITERATE');
      expect(result.reason.length).toBe(10000);
    });

    it('should handle unicode in gaps', () => {
      const output = `\`\`\`json
{
  "decision": "ITERATE",
  "reason": "Issues found",
  "gaps": ["修复错误处理", "Исправить тесты", "🔧 Fix encoding"]
}
\`\`\``;

      const result = parseJudgeOutput(output);

      expect(result.rawGaps).toHaveLength(3);
      expect(result.rawGaps).toContain('修复错误处理');
      expect(result.rawGaps).toContain('Исправить тесты');
    });

    it('should handle nested JSON strings in gaps', () => {
      const output = `\`\`\`json
{
  "decision": "ITERATE",
  "reason": "Config issue",
  "gaps": ["Fix config: {\\"key\\": \\"value\\"}"]
}
\`\`\``;

      const result = parseJudgeOutput(output);

      expect(result.rawGaps[0]).toContain('Fix config');
    });

    it('should handle HTML entities in output', () => {
      const output = `DECISION: ITERATE
REASON: Issues with &lt;template&gt; tags
GAPS:
- Fix &amp; escape HTML entities`;

      const result = parseJudgeOutput(output);

      expect(result.decision).toBe('ITERATE');
    });

    it('should handle mixed decision indicators', () => {
      // When both ITERATE and PROCEED appear, first match wins
      const output = `You should PROCEED after you ITERATE once more.
DECISION: ITERATE
REASON: Needs one more pass`;

      const result = parseJudgeOutput(output);

      expect(result.decision).toBe('ITERATE');
    });

    it('should handle JSON with trailing commas', () => {
      const output = `\`\`\`json
{
  "decision": "PROCEED",
  "reason": "All good",
  "gaps": [],
}
\`\`\``;

      // JSON.parse will fail, should fall back to partial parsing
      const result = parseJudgeOutput(output);

      expect(result.decision).toBe('PROCEED');
    });

    it('should handle single-quoted JSON strings gracefully', () => {
      const output = `{'decision': 'ITERATE', 'reason': 'needs work'}`;

      // Invalid JSON, should try other strategies
      const result = parseJudgeOutput(output, {
        unmetCriteria: ['Coverage issue'],
      });

      // Should fall back since single quotes aren't valid JSON
      expect(result.decision).toBe('ITERATE');
    });
  });

  describe('Complex Scenarios', () => {
    it('should handle real-world verbose judge output', () => {
      const output = `## Code Review Summary

After carefully reviewing the implementation against the acceptance criteria, I have the following assessment:

### Overall Verdict
The implementation shows good progress but requires additional work in several areas.

\`\`\`json
{
  "decision": "ITERATE",
  "reason": "Test coverage is at 65% which is below the required 80% threshold. Additionally, there are missing error handlers in the API routes.",
  "gaps": [
    "Increase test coverage from 65% to 80%",
    "Add error handling to /api/users endpoint",
    "Add input validation for user registration",
    "Fix ESLint warnings in utils/helpers.ts"
  ],
  "suggestedNextSteps": [
    "Write unit tests for UserService",
    "Add try-catch blocks to route handlers",
    "Install and configure express-validator"
  ]
}
\`\`\`

Let me know if you need any clarification on these points.`;

      const result = parseJudgeOutput(output);

      expect(result.decision).toBe('ITERATE');
      expect(result.rawGaps).toHaveLength(4);
      expect(result.metadata?.suggestedNextSteps).toHaveLength(3);
      expect(result.strategy).toBe('json_markdown_block');
      expect(result.confidence).toBe('high');
    });

    it('should handle judge output with only decision', () => {
      const output = `Based on my analysis: DECISION: PROCEED`;

      const result = parseJudgeOutput(output);

      expect(result.decision).toBe('PROCEED');
      expect(result.rawGaps).toHaveLength(0);
    });

    it('should prioritize JSON over regex when both present', () => {
      const output = `DECISION: PROCEED

But the real verdict is:
\`\`\`json
{"decision": "ITERATE", "reason": "JSON takes priority"}
\`\`\``;

      const result = parseJudgeOutput(output);

      expect(result.decision).toBe('ITERATE');
      expect(result.reason).toBe('JSON takes priority');
      expect(result.strategy).toBe('json_markdown_block');
    });
  });
});
