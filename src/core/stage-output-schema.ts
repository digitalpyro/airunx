/**
 * Stage Output Schema for Memory Handoffs
 *
 * Defines the structure for passing context between pipeline stages.
 * Each stage produces output that feeds into the next stage's context.
 *
 */

import { z } from 'zod';
import { JudgeVerdictSchema, AgentRoleSchema } from './types.js';

/**
 * Context passed from one stage to the next
 */
export const StageContextSchema = z.object({
  key_decisions: z
    .array(z.string())
    .describe('Critical decisions made in this stage'),
  open_questions: z
    .array(z.string())
    .describe('Questions requiring resolution'),
  files_affected: z
    .array(z.string())
    .describe('Files created, modified, or read'),
  dependencies_identified: z
    .array(z.string())
    .optional()
    .describe('External dependencies found'),
  patterns_applied: z
    .array(z.string())
    .optional()
    .describe('Code patterns used'),
});

export type StageContext = z.infer<typeof StageContextSchema>;

/**
 * Output from a single pipeline stage
 */
export const StageOutputSchema = z.object({
  stage_name: z.string().describe('Name of the completed stage'),
  agent: AgentRoleSchema.describe('Agent that executed this stage'),
  timestamp: z.string().datetime().describe('ISO 8601 timestamp of completion'),
  status: z
    .enum(['completed', 'failed', 'skipped'])
    .describe('Execution status'),
  execution_time_ms: z
    .number()
    .int()
    .nonnegative()
    .describe('Time taken to execute'),
  output: z.record(z.unknown()).describe('Stage-specific output data'),
  context_for_next: StageContextSchema.describe(
    'Context to pass to next stage'
  ),
});

export type StageOutput = z.infer<typeof StageOutputSchema>;

/**
 * Judge stage output with verdict
 */
export const JudgeOutputSchema = StageOutputSchema.extend({
  output: z.object({
    verdict: JudgeVerdictSchema,
    verdict_reason: z.string(),
    iteration_target: z.enum(['strategize', 'implement', 'review']).optional(),
    quality_score: z.number().min(0).max(1),
    acceptance_criteria_status: z.array(
      z.object({
        id: z.string(),
        status: z.enum(['met', 'not_met', 'partial']),
        evidence: z.string().optional(),
      })
    ),
    github_issue_updates: z
      .object({
        checkboxes_to_complete: z.array(z.string()),
        comment_body: z.string(),
      })
      .optional(),
    manual_qa_checklist_for_pr: z.array(z.string()).optional(),
    deferred_items: z.array(z.string()).optional(),
    blocking_issues: z.array(z.string()).optional(),
  }),
});

export type JudgeOutput = z.infer<typeof JudgeOutputSchema>;

/**
 * Review stage output with multi-pass details
 */
export const ReviewOutputSchema = StageOutputSchema.extend({
  output: z.object({
    pass_count: z.number().int().positive(),
    fidelity_level: z.enum(['fast', 'standard', 'thorough', 'ultra']),
    verdict: z.enum(['approved', 'needs_changes', 'rejected']),
    issues: z.array(
      z.object({
        id: z.string(),
        severity: z.enum(['critical', 'major', 'minor', 'suggestion']),
        file: z.string(),
        line: z.number().int().optional(),
        description: z.string(),
        suggested_fix: z.string().optional(),
      })
    ),
    touch_points_analyzed: z
      .array(
        z.object({
          file: z.string(),
          relationship: z.enum([
            'calls',
            'called_by',
            'imports',
            'imported_by',
          ]),
        })
      )
      .optional(),
    security_findings: z.array(z.string()).optional(),
    pass_summaries: z
      .array(
        z.object({
          pass: z.number().int(),
          focus: z.string(),
          findings_count: z.number().int(),
        })
      )
      .optional(),
  }),
});

export type ReviewOutput = z.infer<typeof ReviewOutputSchema>;

/**
 * Implementation stage output
 */
export const ImplementationOutputSchema = StageOutputSchema.extend({
  output: z.object({
    files_changed: z.array(
      z.object({
        path: z.string(),
        action: z.enum(['create', 'modify', 'delete']),
        lines_changed: z.number().int().nonnegative(),
      })
    ),
    reviewer_feedback_addressed: z
      .array(
        z.object({
          feedback_id: z.string(),
          resolution: z.string(),
        })
      )
      .optional(),
    security_measures_applied: z.array(z.string()).optional(),
    test_hooks_added: z.array(z.string()).optional(),
    handoff_notes: z.string().optional(),
  }),
});

export type ImplementationOutput = z.infer<typeof ImplementationOutputSchema>;

/**
 * Test creator stage output
 * Note: Coverage report removed since test-creator runs BEFORE implementation
 * Coverage analysis should be performed by static-analyzer after implementation
 */
export const TestOutputSchema = StageOutputSchema.extend({
  output: z.object({
    tests_created: z.array(
      z.object({
        file: z.string(),
        test_count: z.number().int().nonnegative(),
        type: z.enum(['unit', 'integration', 'e2e']),
      })
    ),
    manual_qa_checklist: z
      .array(
        z.object({
          scenario: z.string(),
          steps: z.array(z.string()),
          expected_result: z.string(),
          priority: z.enum(['critical', 'high', 'medium', 'low']),
        })
      )
      .optional(),
    issues_for_dev_implementation: z.array(z.string()).optional(),
    code_comments_added: z.array(z.string()).optional(),
  }),
});

export type TestOutput = z.infer<typeof TestOutputSchema>;

/**
 * Static analyzer stage output
 */
export const AnalyzerOutputSchema = StageOutputSchema.extend({
  output: z.object({
    overall_status: z.enum(['pass', 'fail']),
    config_sources_used: z.array(z.string()),
    checks: z.array(
      z.object({
        tool: z.string(),
        status: z.enum(['pass', 'fail']),
        issues_count: z.number().int().nonnegative(),
        issues: z.array(z.string()).optional(),
      })
    ),
    blocking_issues: z.array(z.string()).optional(),
    auto_fixable: z.array(z.string()).optional(),
  }),
});

export type AnalyzerOutput = z.infer<typeof AnalyzerOutputSchema>;

/**
 * Docs generator stage output
 */
export const DocsOutputSchema = StageOutputSchema.extend({
  output: z.object({
    skipped: z.boolean(),
    skip_reason: z.string().optional(),
    iteration_context: z
      .object({
        current: z.number().int(),
        max: z.number().int(),
        is_final: z.boolean(),
      })
      .optional(),
    files_updated: z
      .array(
        z.object({
          path: z.string(),
          action: z.enum(['create', 'modify', 'skip']),
          summary: z.string().optional(),
        })
      )
      .optional(),
    changelog_entry: z.string().optional(),
    ai_docs_updated: z.boolean().optional(),
    surgical_modifications: z.array(z.string()).optional(),
  }),
});

export type DocsOutput = z.infer<typeof DocsOutputSchema>;

/**
 * Pipeline memory - tracks all stage outputs for a workflow
 */
export const PipelineMemorySchema = z.object({
  workflow_id: z.string(),
  iteration: z.number().int().positive(),
  stages: z.record(z.string(), StageOutputSchema),
  accumulated_context: StageContextSchema,
});

export type PipelineMemory = z.infer<typeof PipelineMemorySchema>;

/**
 * Helper to create initial stage context
 */
export function createEmptyContext(): StageContext {
  return {
    key_decisions: [],
    open_questions: [],
    files_affected: [],
  };
}

/**
 * Helper to merge stage contexts
 */
export function mergeContexts(
  previous: StageContext,
  current: StageContext
): StageContext {
  return {
    key_decisions: [...previous.key_decisions, ...current.key_decisions],
    open_questions: [
      ...previous.open_questions.filter(
        (q) => !current.key_decisions.includes(q)
      ),
      ...current.open_questions,
    ],
    files_affected: [
      ...new Set([...previous.files_affected, ...current.files_affected]),
    ],
    dependencies_identified: [
      ...new Set([
        ...(previous.dependencies_identified || []),
        ...(current.dependencies_identified || []),
      ]),
    ],
    patterns_applied: [
      ...new Set([
        ...(previous.patterns_applied || []),
        ...(current.patterns_applied || []),
      ]),
    ],
  };
}
