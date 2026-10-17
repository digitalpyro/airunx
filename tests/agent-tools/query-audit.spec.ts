/**
 * query_audit agent tool tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { queryAuditTool } from '../../src/agent-tools/query-audit.js';
import { AuditLogger } from '../../src/audit/audit-logger.js';
import {
  LEDGER_EVENT_TYPES,
  type AgentContext,
} from '../../src/task-queue/types.js';

describe('query_audit tool', () => {
  let testDir: string;
  let auditLogger: AuditLogger;
  let context: AgentContext;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'airunx-query-audit-'));
    auditLogger = new AuditLogger(testDir);
    context = { auditLogger, workflowId: 'wf-agent' } as AgentContext;

    auditLogger.logStageStart('wf-agent', 'plan');
    for (const event of LEDGER_EVENT_TYPES) {
      auditLogger.log({
        event,
        workflowId: 'wf-agent',
        details: { cost_usd: 1 },
      });
    }
    auditLogger.logStageComplete('wf-agent', 'plan', 10);
    auditLogger.logStageStart('wf-other', 'plan');
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('returns none of the cost-ledger event types by default', async () => {
    const events = await queryAuditTool.execute({}, context);

    const types = events.map((e) => e.event);
    expect(types).toEqual(['stage_complete', 'stage_start']);
    for (const ledgerType of LEDGER_EVENT_TYPES) {
      expect(types).not.toContain(ledgerType);
    }
  });

  it('does not let ledger events crowd out the limit', async () => {
    const events = await queryAuditTool.execute({ limit: 2 }, context);
    expect(events).toHaveLength(2);
  });

  it('returns ledger events only when explicitly requested by type', async () => {
    const events = await queryAuditTool.execute(
      { eventTypes: ['llm_spawn'] },
      context
    );
    expect(events.map((e) => e.event)).toEqual(['llm_spawn']);
  });

  it('stays scoped to the current workflow', async () => {
    const events = await queryAuditTool.execute({}, context);
    expect(events.every((e) => e.workflowId === 'wf-agent')).toBe(true);
  });
});
