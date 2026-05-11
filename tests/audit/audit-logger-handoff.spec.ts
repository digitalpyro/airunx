/**
 * Audit Logger stage_handoff event tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AuditLogger } from '../../src/audit/audit-logger.js';
import { existsSync, readFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('AuditLogger.logStageHandoff', () => {
  let logger: AuditLogger;
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `airunx-audit-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    logger = new AuditLogger(testDir);
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should emit stage_handoff event with all fields', () => {
    logger.logStageHandoff('workflow-123', {
      fromStage: 'orchestrate',
      toStage: 'strategize',
      outputSizeBytes: 4096,
      handoffContextSizeBytes: 2048,
      cumulativeCost: 1.5,
      cumulativeTokens: 30000,
      budgetRemainingPercent: 97.0,
    });

    const logPath = logger.getLogPath();
    expect(existsSync(logPath)).toBe(true);

    const content = readFileSync(logPath, 'utf-8').trim();
    const event = JSON.parse(content);

    expect(event.event).toBe('stage_handoff');
    expect(event.workflowId).toBe('workflow-123');
    expect(event.details.fromStage).toBe('orchestrate');
    expect(event.details.toStage).toBe('strategize');
    expect(event.details.outputSizeBytes).toBe(4096);
    expect(event.details.handoffContextSizeBytes).toBe(2048);
    expect(event.details.cumulativeCost).toBe(1.5);
    expect(event.details.cumulativeTokens).toBe(30000);
    expect(event.details.budgetRemainingPercent).toBe(97.0);
    expect(event.timestamp).toBeDefined();
  });

  it('should be queryable by event type', async () => {
    logger.logStageHandoff('workflow-456', {
      fromStage: 'implement',
      toStage: 'analyze',
      outputSizeBytes: 8000,
      handoffContextSizeBytes: 3000,
      cumulativeCost: 3.2,
      cumulativeTokens: 60000,
      budgetRemainingPercent: 93.6,
    });

    // Also log a different event type
    logger.logStageComplete('workflow-456', 'implement', 5000);

    const handoffEvents = await logger.query({
      workflowId: 'workflow-456',
      eventTypes: ['stage_handoff'],
    });

    expect(handoffEvents).toHaveLength(1);
    expect(handoffEvents[0].event).toBe('stage_handoff');
    expect(handoffEvents[0].details.fromStage).toBe('implement');
  });
});
