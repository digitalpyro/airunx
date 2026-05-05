/**
 * Golden Set Evaluation for Judge Output Parser
 *
 * Tests parser accuracy against curated examples covering all parsing strategies.
 * Add new cases here when you encounter parsing failures in production.
 */

import { describe, it, expect } from 'vitest';
import {
  JudgeOutputParser,
  type JudgeDecision,
  type ParseConfidence,
  type ParseStrategy,
} from '../../src/orchestrator/judge-output-parser.js';

interface GoldenCase {
  id: string;
  input: string;
  expected: {
    decision: JudgeDecision;
    gapsCount: number;
    confidence: ParseConfidence;
    strategy: ParseStrategy;
  };
}

// ============================================================================
// GOLDEN TEST CASES
// Organized by parsing strategy. Add new cases when bugs are discovered.
// ============================================================================

const goldenCases: GoldenCase[] = [
  // --- JSON Markdown Block (High Confidence) ---
  {
    id: 'json-md-iterate',
    input:
      '```json\n{"decision": "ITERATE", "reason": "Coverage too low", "gaps": ["Add unit tests"]}\n```',
    expected: {
      decision: 'ITERATE',
      gapsCount: 1,
      confidence: 'high',
      strategy: 'json_markdown_block',
    },
  },
  {
    id: 'json-md-proceed',
    input:
      '```json\n{"decision": "PROCEED", "reason": "All criteria met", "gaps": []}\n```',
    expected: {
      decision: 'PROCEED',
      gapsCount: 0,
      confidence: 'high',
      strategy: 'json_markdown_block',
    },
  },
  {
    id: 'json-md-multiple-gaps',
    input:
      '```json\n{"decision": "ITERATE", "reason": "Issues found", "gaps": ["Fix types", "Add tests", "Handle errors"]}\n```',
    expected: {
      decision: 'ITERATE',
      gapsCount: 3,
      confidence: 'high',
      strategy: 'json_markdown_block',
    },
  },

  // --- Raw JSON (High Confidence) ---
  {
    id: 'json-raw-proceed',
    input: '{"decision": "PROCEED", "reason": "Complete", "gaps": []}',
    expected: {
      decision: 'PROCEED',
      gapsCount: 0,
      confidence: 'high',
      strategy: 'json_raw',
    },
  },
  {
    id: 'json-raw-iterate',
    input:
      '{"decision": "ITERATE", "reason": "Needs work", "gaps": ["Refactor"]}',
    expected: {
      decision: 'ITERATE',
      gapsCount: 1,
      confidence: 'high',
      strategy: 'json_raw',
    },
  },

  // --- Partial JSON Recovery (Medium Confidence) ---
  {
    id: 'json-partial-trailing-comma',
    input: '{"decision": "ITERATE", "reason": "Issues", "gaps": ["Fix bug",]}',
    expected: {
      decision: 'ITERATE',
      gapsCount: 1,
      confidence: 'medium',
      strategy: 'json_partial',
    },
  },
  {
    // Note: Single quotes are NOT valid JSON - parser falls back to default
    // This documents actual behavior, not a bug
    id: 'json-partial-single-quotes-fallback',
    input: "{'decision': 'PROCEED', 'reason': 'Done', 'gaps': []}",
    expected: {
      decision: 'ITERATE', // Falls back to default
      gapsCount: 0,
      confidence: 'low',
      strategy: 'fallback_default',
    },
  },

  // --- Regex Structured (Medium Confidence) ---
  {
    id: 'regex-structured-iterate',
    input:
      'DECISION: ITERATE\n\nREASON: Coverage at 65%\n\nGAPS:\n- Add tests\n- Fix errors',
    expected: {
      decision: 'ITERATE',
      gapsCount: 2,
      confidence: 'medium',
      strategy: 'regex_structured',
    },
  },
  {
    id: 'regex-structured-proceed',
    input: 'DECISION: PROCEED\n\nREASON: All requirements satisfied',
    expected: {
      decision: 'PROCEED',
      gapsCount: 0,
      confidence: 'medium',
      strategy: 'regex_structured',
    },
  },

  // --- Freeform (Low Confidence) ---
  {
    // Note: Freeform requires explicit patterns like "not ready", "should iterate"
    // Vague phrases like "needs more work" fall back to default
    id: 'freeform-iterate-explicit',
    input: 'The implementation is not ready. Several issues must be addressed.',
    expected: {
      decision: 'ITERATE',
      gapsCount: 0,
      confidence: 'low',
      strategy: 'regex_freeform',
    },
  },
  {
    id: 'freeform-proceed-implicit',
    input: 'Everything looks good. The implementation is complete and ready.',
    expected: {
      decision: 'PROCEED',
      gapsCount: 0,
      confidence: 'low',
      strategy: 'regex_freeform',
    },
  },

  // --- Edge Cases ---
  {
    // Note: Empty input defaults to ITERATE (fail-safe behavior)
    // Parser assumes if no output, something went wrong
    id: 'edge-empty-string',
    input: '',
    expected: {
      decision: 'ITERATE',
      gapsCount: 0,
      confidence: 'low',
      strategy: 'fallback_default',
    },
  },
  {
    // Note: Whitespace-only also defaults to ITERATE
    id: 'edge-whitespace-only',
    input: '   \n\t  ',
    expected: {
      decision: 'ITERATE',
      gapsCount: 0,
      confidence: 'low',
      strategy: 'fallback_default',
    },
  },
  {
    id: 'edge-unicode-content',
    input:
      '```json\n{"decision": "ITERATE", "reason": "需要改进", "gaps": ["修复错误"]}\n```',
    expected: {
      decision: 'ITERATE',
      gapsCount: 1,
      confidence: 'high',
      strategy: 'json_markdown_block',
    },
  },
];

// ============================================================================
// TESTS
// ============================================================================

// Parse all cases once at module load to avoid redundant parsing
// (describe.each runs at collection time, before beforeAll)
const parser = new JudgeOutputParser({ verbose: false });
const parsedResults = goldenCases.map((goldenCase) => ({
  id: goldenCase.id,
  result: parser.parse(goldenCase.input),
  expected: goldenCase.expected,
}));

describe('JudgeOutputParser - Golden Set', () => {
  it.each(parsedResults)('parses $id correctly', ({ result, expected }) => {
    expect({
      decision: result.decision,
      gapsCount: result.rawGaps.length,
      confidence: result.confidence,
      strategy: result.strategy,
    }).toEqual(expected);
  });

  it('achieves 100% decision accuracy on golden set', () => {
    const incorrectCases = parsedResults.filter(
      ({ result, expected }) => result.decision !== expected.decision
    );

    expect(incorrectCases).toEqual([]);
  });
});
