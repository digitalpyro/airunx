/**
 * Structured Judge Output Parser
 *
 * A robust parser for extracting structured decisions from LLM judge outputs.
 * Implements multiple extraction strategies with confidence scoring.
 */

import { z } from 'zod';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('judge-output-parser');

// ============================================================================
// Types & Schemas
// ============================================================================

/**
 * Possible judge decisions
 * - ITERATE: Continue iterating to improve the implementation
 * - PROCEED: Accept the implementation and continue to next phase
 * - FAIL: The workflow has failed and should not proceed
 */
export type JudgeDecision = 'ITERATE' | 'PROCEED' | 'FAIL';

/**
 * Gap severity levels - single source of truth
 */
export const GAP_SEVERITIES = ['critical', 'major', 'minor', 'info'] as const;
export type GapSeverity = (typeof GAP_SEVERITIES)[number];

/**
 * Individual gap with optional metadata
 */
export interface ParsedGap {
  description: string;
  severity?: GapSeverity;
  category?: string;
}

/**
 * Confidence levels for parsed results
 */
export type ParseConfidence = 'high' | 'medium' | 'low';

/**
 * Parsing strategy that was used
 */
export type ParseStrategy =
  | 'json_markdown_block'
  | 'json_raw'
  | 'json_partial'
  | 'regex_structured'
  | 'regex_freeform'
  | 'fallback_default';

/**
 * Result of parsing judge output
 */
export interface ParsedJudgeOutput {
  decision: JudgeDecision;
  reason: string;
  gaps: ParsedGap[];
  confidence: ParseConfidence;
  strategy: ParseStrategy;
  rawGaps: string[]; // Original gap strings for backward compatibility
  /** Checkbox items the judge identified as completed (from source issue) */
  checkboxesToComplete?: string[];
  metadata?: {
    suggestedNextSteps?: string[];
    estimatedEffort?: string;
    originalOutput?: string;
  };
}

/**
 * Schema for gap objects with optional metadata
 */
const GapObjectSchema = z.object({
  description: z.string(),
  severity: z.enum(GAP_SEVERITIES).optional(),
  category: z.string().optional(),
});

/**
 * Zod schema for the expected JSON structure from judge
 */
const JudgeJsonSchema = z.object({
  decision: z.enum(['ITERATE', 'PROCEED', 'iterate', 'proceed']),
  reason: z.string().min(1),
  gaps: z
    .array(z.union([z.string(), GapObjectSchema]))
    .optional()
    .default([]),
  suggestedNextSteps: z.array(z.string()).optional(),
  estimatedEffort: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
});

/**
 * Lenient schema that accepts more formats and normalizes to canonical field names
 */
const LenientJudgeJsonSchema = z
  .object({
    decision: z.string().optional(),
    reason: z.string().optional(),
    gaps: z.union([z.array(z.unknown()), z.string(), z.null()]).optional(),
    verdict: z.string().optional(), // Alternative to decision
    explanation: z.string().optional(), // Alternative to reason
    issues: z.union([z.array(z.unknown()), z.string(), z.null()]).optional(), // Alternative to gaps
    next_steps: z.array(z.string()).optional(),
    nextSteps: z.array(z.string()).optional(),
  })
  .transform((data) => ({
    // Normalize to canonical field names
    decision: data.decision || data.verdict,
    reason: data.reason || data.explanation,
    gaps: data.gaps || data.issues,
    nextSteps: data.nextSteps || data.next_steps,
  }));

// ============================================================================
// Parser Class
// ============================================================================

export interface ParserOptions {
  /** Default decision when parsing fails and no criteria available */
  defaultDecision?: JudgeDecision;
  /** Whether to preserve original output in metadata */
  preserveRawOutput?: boolean;
  /** Unmet criteria to use as fallback gaps */
  unmetCriteria?: string[];
  /** Additional findings to use as fallback */
  findings?: string[];
  /** Enable verbose logging */
  verbose?: boolean;
}

export class JudgeOutputParser {
  private options: Required<ParserOptions>;

  /** Minimum length for a valid reason sentence */
  private static readonly MIN_REASON_SENTENCE_LENGTH = 20;

  /** Maximum length for a valid reason sentence */
  private static readonly MAX_REASON_SENTENCE_LENGTH = 200;

  constructor(options: ParserOptions = {}) {
    this.options = {
      defaultDecision: options.defaultDecision ?? 'ITERATE',
      preserveRawOutput: options.preserveRawOutput ?? false,
      unmetCriteria: options.unmetCriteria ?? [],
      findings: options.findings ?? [],
      verbose: options.verbose ?? false,
    };
  }

  /**
   * Parse judge output using multiple strategies
   */
  parse(output: string): ParsedJudgeOutput {
    if (!output || output.trim().length === 0) {
      return this.createFallbackResult('Empty output received');
    }

    const strategies: Array<() => ParsedJudgeOutput | null> = [
      (): ParsedJudgeOutput | null => this.tryJsonMarkdownBlock(output),
      (): ParsedJudgeOutput | null => this.tryRawJson(output),
      (): ParsedJudgeOutput | null => this.tryPartialJson(output),
      (): ParsedJudgeOutput | null => this.tryRegexStructured(output),
      (): ParsedJudgeOutput | null => this.tryRegexFreeform(output),
    ];

    for (const strategy of strategies) {
      const result = strategy();
      if (result) {
        if (this.options.verbose) {
          logger.debug(
            `Parsed with strategy: ${result.strategy}, confidence: ${result.confidence}`
          );
        }
        return this.enrichResult(result, output);
      }
    }

    return this.createFallbackResult('No parsing strategy succeeded');
  }

  // ============================================================================
  // Parsing Strategies
  // ============================================================================

  /**
   * Strategy 1: Extract JSON from markdown code block
   */
  private tryJsonMarkdownBlock(output: string): ParsedJudgeOutput | null {
    const patterns = [
      /```json\s*([\s\S]*?)```/i,
      /```\s*([\s\S]*?)```/,
      // Note: Single backtick pattern removed - tryRawJson handles raw JSON more robustly
    ];

    for (const pattern of patterns) {
      const match = output.match(pattern);
      if (match) {
        const jsonStr = match[1].trim();
        const parsed = this.parseJsonString(jsonStr);
        if (parsed) {
          return {
            ...parsed,
            strategy: 'json_markdown_block',
            confidence: 'high',
          };
        }
      }
    }
    return null;
  }

  /**
   * Strategy 2: Try parsing raw JSON (no code block)
   */
  private tryRawJson(output: string): ParsedJudgeOutput | null {
    // Find JSON objects using brace-counting for accurate boundary detection
    const jsonObjects = this.extractJsonObjects(output);

    // Try each extracted JSON object, looking for one with decision/verdict
    for (const jsonStr of jsonObjects) {
      if (/"(?:decision|verdict)"/i.test(jsonStr)) {
        const parsed = this.parseJsonString(jsonStr);
        if (parsed) {
          return {
            ...parsed,
            strategy: 'json_raw',
            confidence: 'high',
          };
        }
      }
    }

    // Try the entire output as JSON
    const parsed = this.parseJsonString(output.trim());
    if (parsed) {
      return {
        ...parsed,
        strategy: 'json_raw',
        confidence: 'high',
      };
    }

    return null;
  }

  /**
   * Strategy 3: Try to repair and parse partial/malformed JSON
   */
  private tryPartialJson(output: string): ParsedJudgeOutput | null {
    // Try to extract individual fields even from malformed JSON
    const decisionMatch = output.match(
      /"(?:decision|verdict)"\s*:\s*"?(ITERATE|PROCEED)"?/i
    );
    const reasonMatch = output.match(
      /"(?:reason|explanation)"\s*:\s*"((?:\\.|[^"])*)"/i
    );

    if (decisionMatch) {
      const decision = decisionMatch[1].toUpperCase() as JudgeDecision;
      const reason = reasonMatch?.[1] || this.getDefaultReason(decision);
      const gaps = this.extractGapsFromPartialJson(output);

      return {
        decision,
        reason,
        gaps,
        rawGaps: gaps.map((g) => g.description),
        strategy: 'json_partial',
        confidence: 'medium',
      };
    }

    return null;
  }

  /**
   * Strategy 4: Structured regex parsing (DECISION:, REASON:, GAPS:)
   */
  private tryRegexStructured(output: string): ParsedJudgeOutput | null {
    const decisionMatch = output.match(
      /\b(?:DECISION|VERDICT)\s*:\s*(ITERATE|PROCEED)\b/i
    );

    if (!decisionMatch) return null;

    const decision = decisionMatch[1].toUpperCase() as JudgeDecision;
    const reason = this.extractReasonFromText(output);
    const gaps = this.extractGapsFromText(output);

    return {
      decision,
      reason,
      gaps,
      rawGaps: gaps.map((g) => g.description),
      strategy: 'regex_structured',
      confidence: 'medium',
    };
  }

  /**
   * Strategy 5: Freeform regex parsing (infer from language)
   */
  private tryRegexFreeform(output: string): ParsedJudgeOutput | null {
    // Look for decision keywords in natural language
    const iteratePatterns = [
      /\b(?:should|must|need(?:s)?(?:\s+to)?)\s+iterate\b/i,
      /\brequire(?:s)?\s+(?:additional|more|further)\s+(?:work|iteration)/i,
      /\bnot\s+(?:ready|acceptable|complete)\b/i,
      /\biterate\s+(?:is|recommended|suggested)\b/i,
      /\bfail(?:ed|s|ing)?\b.*\b(?:check|criteria|requirement)/i,
    ];

    const proceedPatterns = [
      /\b(?:can|should|ready\s+to)\s+proceed\b/i,
      /\ball\s+(?:criteria|requirements|checks)\s+(?:met|passed|satisfied)\b/i,
      /\bacceptable\s+(?:to\s+)?proceed\b/i,
      /\bapproved?\b/i,
      /\blooks?\s+good\b/i,
    ];

    let decision: JudgeDecision | null = null;

    for (const pattern of iteratePatterns) {
      if (pattern.test(output)) {
        decision = 'ITERATE';
        break;
      }
    }

    if (!decision) {
      for (const pattern of proceedPatterns) {
        if (pattern.test(output)) {
          decision = 'PROCEED';
          break;
        }
      }
    }

    if (decision) {
      const gaps = this.extractGapsFromText(output);

      // If no explicit gaps found but decision is ITERATE, look for issues
      if (gaps.length === 0 && decision === 'ITERATE') {
        const issuePatterns = [
          /(?:issue|problem|error|warning|concern)s?:\s*([^\n]+)/gi,
          /(?:missing|lacking|need(?:s|ed)?)\s+([^\n.]+)/gi,
        ];

        for (const pattern of issuePatterns) {
          const matches = output.matchAll(pattern);
          for (const match of matches) {
            if (match[1]) {
              gaps.push({
                description: match[1].trim(),
                severity: 'major',
              });
            }
          }
        }
      }

      return {
        decision,
        reason: this.extractReasonFromFreeform(output),
        gaps,
        rawGaps: gaps.map((g) => g.description),
        strategy: 'regex_freeform',
        confidence: 'low',
      };
    }

    return null;
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  /**
   * Extract JSON objects from text using brace-counting
   * Returns all potential JSON objects found in the text
   */
  private extractJsonObjects(text: string): string[] {
    return this.extractJsonStructures(text, '{', '}');
  }

  /**
   * Extract JSON structures (objects or arrays) using bracket-counting
   * Properly handles nested structures and brackets inside string literals
   */
  private extractJsonStructures(
    text: string,
    openChar: '{' | '[',
    closeChar: '}' | ']'
  ): string[] {
    const structures: string[] = [];
    let i = 0;

    while (i < text.length) {
      // Find the start of a potential JSON structure
      const startIndex = text.indexOf(openChar, i);
      if (startIndex === -1) break;

      // Count brackets to find the matching closing bracket
      let bracketCount = 0;
      let inString = false;
      let escapeNext = false;
      let endIndex = -1;

      for (let j = startIndex; j < text.length; j++) {
        const char = text[j];

        if (escapeNext) {
          escapeNext = false;
          continue;
        }

        if (char === '\\' && inString) {
          escapeNext = true;
          continue;
        }

        if (char === '"' && !escapeNext) {
          inString = !inString;
          continue;
        }

        if (!inString) {
          if (char === openChar) {
            bracketCount++;
          } else if (char === closeChar) {
            bracketCount--;
            if (bracketCount === 0) {
              endIndex = j;
              break;
            }
          }
        }
      }

      if (endIndex !== -1) {
        const jsonCandidate = text.substring(startIndex, endIndex + 1);
        structures.push(jsonCandidate);
        i = endIndex + 1;
      } else {
        // No matching closing bracket found, move past this opening bracket
        i = startIndex + 1;
      }
    }

    return structures;
  }

  /**
   * Parse a JSON string with validation
   */
  private parseJsonString(
    jsonStr: string
  ): Omit<ParsedJudgeOutput, 'strategy' | 'confidence'> | null {
    try {
      const parsed = JSON.parse(jsonStr);

      // Extract checkboxes_to_complete if present (before schema validation strips it)
      const checkboxesToComplete =
        Array.isArray(parsed.checkboxes_to_complete) &&
        parsed.checkboxes_to_complete.every(
          (item: unknown) => typeof item === 'string'
        )
          ? (parsed.checkboxes_to_complete as string[])
          : undefined;

      // Try strict schema first
      const strictResult = JudgeJsonSchema.safeParse(parsed);
      if (strictResult.success) {
        const data = strictResult.data;
        const normalizedGaps = this.normalizeGaps(data.gaps);
        return {
          decision: data.decision.toUpperCase() as JudgeDecision,
          reason: data.reason,
          gaps: normalizedGaps,
          rawGaps: normalizedGaps.map((g) => g.description),
          checkboxesToComplete,
          metadata: {
            suggestedNextSteps: data.suggestedNextSteps,
            estimatedEffort: data.estimatedEffort,
          },
        };
      }

      // Try lenient schema (transform normalizes field names)
      const lenientResult = LenientJudgeJsonSchema.safeParse(parsed);
      if (lenientResult.success) {
        const data = lenientResult.data;
        const decision = this.extractDecisionFromLenient(data);
        if (decision) {
          const normalizedGaps = this.normalizeGaps(data.gaps || []);
          return {
            decision,
            reason: data.reason || this.getDefaultReason(decision),
            gaps: normalizedGaps,
            rawGaps: normalizedGaps.map((g) => g.description),
            checkboxesToComplete,
            metadata: {
              suggestedNextSteps: data.nextSteps,
            },
          };
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Extract decision from lenient schema result (already normalized by transform)
   */
  private extractDecisionFromLenient(
    data: z.infer<typeof LenientJudgeJsonSchema>
  ): JudgeDecision | null {
    const decisionStr = data.decision || '';
    const upper = decisionStr.toUpperCase().trim();

    if (upper === 'ITERATE' || /\bITERATE\b/.test(upper)) return 'ITERATE';
    if (upper === 'PROCEED' || /\bPROCEED\b/.test(upper)) return 'PROCEED';
    if (upper === 'PASS' || upper === 'APPROVED' || upper === 'ACCEPT')
      return 'PROCEED';
    if (upper === 'FAIL' || upper === 'REJECTED' || upper === 'REJECT')
      return 'ITERATE';

    return null;
  }

  /**
   * Normalize gaps into ParsedGap objects
   */
  private normalizeGaps(gaps: unknown): ParsedGap[] {
    if (!gaps) return [];

    const gapList: ParsedGap[] = [];

    // Helper to process string gaps with severity/category parsing
    const processStringGap = (gapStr: string): ParsedGap => {
      const cleaned = gapStr
        .trim()
        .replace(/^(?:[-*•]|\d+[.)]|\[\d+\])\s*/, '');
      return this.parseGapLine(cleaned);
    };

    if (typeof gaps === 'string') {
      // Split string by newlines, as this is a more reliable delimiter for list items
      const items = gaps.split('\n').filter((s) => s.trim());
      for (const item of items) {
        gapList.push(processStringGap(item));
      }
    } else if (Array.isArray(gaps)) {
      for (const gap of gaps) {
        if (typeof gap === 'string') {
          gapList.push(processStringGap(gap));
        } else if (gap && typeof gap === 'object') {
          const parsedGap = GapObjectSchema.safeParse(gap);
          if (parsedGap.success) {
            gapList.push(parsedGap.data);
          } else if (
            'description' in gap &&
            typeof (gap as Record<string, unknown>).description === 'string'
          ) {
            // Salvage description if schema validation fails but description is present
            gapList.push({
              description: (gap as Record<string, unknown>)
                .description as string,
            });
          }
        }
      }
    }

    return this.deduplicateGaps(gapList);
  }

  /**
   * Extract gaps from partial/malformed JSON
   */
  private extractGapsFromPartialJson(output: string): ParsedGap[] {
    const gaps: ParsedGap[] = [];

    // Find the "gaps" or "issues" array label
    const arrayLabelMatch = output.match(/"(?:gaps|issues)"\s*:\s*/i);
    if (!arrayLabelMatch || arrayLabelMatch.index === undefined) {
      return gaps;
    }

    // Search for the first array starting from after the label using bracket-counting
    const searchFromIndex = arrayLabelMatch.index + arrayLabelMatch[0].length;
    const textToSearch = output.substring(searchFromIndex);
    const jsonArrays = this.extractJsonStructures(textToSearch, '[', ']');

    if (jsonArrays.length > 0) {
      // Use the first array found
      const arrayStr = jsonArrays[0];
      const content = arrayStr.substring(1, arrayStr.length - 1).trim();
      let remainingContent = content;

      // Extract JSON objects using brace-counting to handle nested structures
      const jsonObjects = this.extractJsonObjects(content);
      for (const jsonStr of jsonObjects) {
        try {
          const gapObj = JSON.parse(jsonStr);
          const parsedGap = GapObjectSchema.safeParse(gapObj);
          if (parsedGap.success) {
            gaps.push(parsedGap.data);
          } else if (gapObj && typeof gapObj.description === 'string') {
            // Salvage description if schema validation fails but description is present
            gaps.push({ description: gapObj.description });
          }
        } catch {
          // Ignore malformed objects in partial parsing
        }
        // Remove processed objects (or malformed candidates) from the string to avoid re-parsing
        remainingContent = remainingContent.replace(jsonStr, '');
      }

      // Extract standalone string literals from the remaining content (not part of objects)
      const stringMatches = remainingContent.matchAll(
        /(?:^|,)\s*"([^"\\]*(?:\\.[^"\\]*)*)"\s*(?=,|$)/g
      );
      for (const match of stringMatches) {
        if (match[1]) {
          gaps.push(this.parseGapLine(match[1]));
        }
      }
    }

    return gaps;
  }

  /**
   * Extract reason from structured text
   */
  private extractReasonFromText(output: string): string {
    const patterns = [
      // Match REASON: followed by content until next keyword, list, blank line, or end
      /\bREASON\s*:\s*(.+?)(?=\n\s*(?:GAPS?|ISSUES?|DECISION|VERDICT)\s*:|\n\s*[-*•]|\n\n|$)/is,
      /\bEXPLANATION\s*:\s*(.+?)(?=\n\s*(?:GAPS?|ISSUES?|DECISION|VERDICT)\s*:|\n\s*[-*•]|\n\n|$)/is,
      /\bRATIONALE\s*:\s*(.+?)(?=\n\s*(?:GAPS?|ISSUES?|DECISION|VERDICT)\s*:|\n\s*[-*•]|\n\n|$)/is,
    ];

    for (const pattern of patterns) {
      const match = output.match(pattern);
      if (match && match[1]) {
        return match[1].trim();
      }
    }

    return 'No explicit reason provided';
  }

  /**
   * Extract reason from freeform text
   */
  private extractReasonFromFreeform(output: string): string {
    // Take the first meaningful sentence as reason (preserve original punctuation)
    const sentences = output.split(/(?<=[.!?])\s+/);
    for (const sentence of sentences) {
      const cleaned = sentence.trim();
      if (
        cleaned.length > JudgeOutputParser.MIN_REASON_SENTENCE_LENGTH &&
        cleaned.length < JudgeOutputParser.MAX_REASON_SENTENCE_LENGTH
      ) {
        return cleaned;
      }
    }

    return output.substring(0, 150).trim() + '...';
  }

  /**
   * Extract gaps from text using various patterns
   */
  private extractGapsFromText(output: string): ParsedGap[] {
    const gaps: ParsedGap[] = [];

    // Pattern 1: Structured GAPS: section (stop before other section headers)
    const gapsMatch = output.match(
      /\bGAPS?\s*:\s*([\s\S]*?)(?=\n\s*(?:DECISION|VERDICT|REASON|RATIONALE|EXPLANATION|ISSUES)\s*:|\n\n|$)/i
    );
    if (gapsMatch) {
      const lines = gapsMatch[1]
        .split('\n')
        .map((l) => l.trim().replace(/^(?:[-*•]|\d+[.)]|\[\d+\])\s*/, ''))
        .filter((l) => l.length > 0);

      for (const line of lines) {
        gaps.push(this.parseGapLine(line));
      }
    }

    // Pattern 2: Numbered or bulleted list after keywords
    const listPatterns = [
      /(?:issues?|problems?|gaps?|concerns?)\s*(?:identified|found|detected)?\s*:\s*((?:\n\s*(?:[-*•]|\d+[.)])[^\n]+)+)/gi,
      /(?:the following|these)\s+(?:issues?|problems?|gaps?)\s*:\s*((?:\n\s*(?:[-*•]|\d+[.)])[^\n]+)+)/gi,
    ];

    for (const pattern of listPatterns) {
      const matches = output.matchAll(pattern);
      for (const match of matches) {
        if (match[1]) {
          const lines = match[1]
            .split('\n')
            .map((l) => l.trim().replace(/^(?:[-*•]|\d+[.)]|\[\d+\])\s*/, ''))
            .filter((l) => l.length > 0);

          for (const line of lines) {
            gaps.push(this.parseGapLine(line));
          }
        }
      }
    }

    return this.deduplicateGaps(gaps);
  }

  /**
   * Parse a gap line, extracting severity and category from tags
   * Handles various orderings like [category] [severity], [severity] [category], severity: text, etc.
   */
  private parseGapLine(line: string): ParsedGap {
    let description = line;
    let severity: GapSeverity | undefined;
    let category: string | undefined;

    // This regex finds any [word], (word), or word: at the start of the string
    // Using separate capture groups for parens, brackets, and colon-terms to avoid mismatched brackets
    const tagRegex =
      /^\s*(?:(?:\(([^)]+)\))|(?:\[([^\]]+)\])|(?:([^:\s]+):))\s*/;
    let match;

    // Iteratively parse all tags from the beginning of the line
    while ((match = description.match(tagRegex))) {
      const fullMatch = match[0];
      const parenTerm = match[1]; // (term)
      const bracketTerm = match[2]; // [term]
      const colonTerm = match[3]; // term:
      const term = (parenTerm || bracketTerm || colonTerm || '').trim();
      description = description.substring(fullMatch.length);

      const lowerTerm = term.toLowerCase();
      const foundSeverity = GAP_SEVERITIES.find((s) => s === lowerTerm);

      if (foundSeverity) {
        // Last-seen severity wins
        severity = foundSeverity;
      } else if ((parenTerm || bracketTerm) && !category) {
        // First non-severity bracketed/parenthesized term is the category
        category = term;
      }
    }

    return { description: description.trim(), severity, category };
  }

  /**
   * Severity ranking for comparison (higher = more severe)
   */
  private readonly severityRank: Record<GapSeverity, number> = {
    critical: 4,
    major: 3,
    minor: 2,
    info: 1,
  };

  /**
   * Compare two severities, returning the more severe one
   */
  private getMoreSevereSeverity(
    a: GapSeverity | undefined,
    b: GapSeverity | undefined
  ): GapSeverity | undefined {
    if (!a && !b) return undefined;
    if (!a) return b;
    if (!b) return a;
    return this.severityRank[a] >= this.severityRank[b] ? a : b;
  }

  private deduplicateGaps(gaps: ParsedGap[]): ParsedGap[] {
    const seen = new Map<string, ParsedGap>();

    for (const gap of gaps) {
      const normalized = gap.description.toLowerCase().replace(/\s+/g, ' ');
      if (!seen.has(normalized)) {
        seen.set(normalized, gap);
      } else {
        const existing = seen.get(normalized)!;

        // Merge severity: keep the more severe rating
        existing.severity = this.getMoreSevereSeverity(
          existing.severity,
          gap.severity
        );

        // Merge category: keep existing if present, otherwise use new
        if (!existing.category && gap.category) {
          existing.category = gap.category;
        }
      }
    }

    return Array.from(seen.values());
  }

  /**
   * Get default reason based on decision
   */
  private getDefaultReason(decision: JudgeDecision): string {
    return decision === 'ITERATE'
      ? 'Quality checks failed, iteration required'
      : 'Quality checks passed';
  }

  /**
   * Create a fallback result when all parsing fails
   */
  private createFallbackResult(debugMessage: string): ParsedJudgeOutput {
    if (this.options.verbose) {
      logger.debug(`Fallback triggered: ${debugMessage}`);
    }

    const hasUnmetCriteria = this.options.unmetCriteria.length > 0;
    const decision = hasUnmetCriteria
      ? 'ITERATE'
      : this.options.defaultDecision;

    const gaps: ParsedGap[] = this.options.unmetCriteria.map((c) => ({
      description: c,
      severity: 'major',
    }));

    // Add findings if no unmet criteria
    if (gaps.length === 0 && this.options.findings.length > 0) {
      for (const finding of this.options.findings) {
        gaps.push({ description: finding, severity: 'info' });
      }
    }

    return {
      decision,
      reason: this.getDefaultReason(decision),
      gaps,
      rawGaps: gaps.map((g) => g.description),
      confidence: 'low',
      strategy: 'fallback_default',
    };
  }

  /**
   * Enrich result with additional context
   */
  private enrichResult(
    result: ParsedJudgeOutput,
    originalOutput: string
  ): ParsedJudgeOutput {
    // Add fallback gaps if needed
    if (
      result.gaps.length === 0 &&
      result.decision === 'ITERATE' &&
      this.options.unmetCriteria.length > 0
    ) {
      result.gaps = this.options.unmetCriteria.map((c) => ({
        description: c,
        severity: 'major',
      }));
      result.rawGaps = this.options.unmetCriteria;
    }

    // Preserve raw output if requested
    if (this.options.preserveRawOutput) {
      result.metadata = {
        ...result.metadata,
        originalOutput,
      };
    }

    return result;
  }
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Parse judge output with default options
 */
export function parseJudgeOutput(
  output: string,
  options?: ParserOptions
): ParsedJudgeOutput {
  const parser = new JudgeOutputParser(options);
  return parser.parse(output);
}

/**
 * Convert ParsedJudgeOutput to legacy JudgeResult format
 */
export interface LegacyJudgeResult {
  decision: JudgeDecision;
  reason: string;
  gaps: string[];
  shouldIterate: boolean;
}

export function toLegacyFormat(parsed: ParsedJudgeOutput): LegacyJudgeResult {
  return {
    decision: parsed.decision,
    reason: parsed.reason,
    gaps: parsed.rawGaps,
    shouldIterate: parsed.decision === 'ITERATE',
  };
}
