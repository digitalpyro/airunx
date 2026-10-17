/**
 * AuditLogger envelope, hardening and llm_spawn ledger tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  appendFileSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  AuditLogger,
  MAX_AUDIT_RECORD_BYTES,
  createAuditSpawnObserver,
} from '../../src/audit/audit-logger.js';
import { usdToMicroUsdOrUndefined as toMicroUsd } from '../../src/core/cost-accounting.js';
import type {
  ExecutionRequest,
  SpawnRecord,
} from '../../src/core/adapter-types.js';

const readLines = (path: string): Record<string, unknown>[] =>
  readFileSync(path, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

const spawnRecord = (overrides: Partial<SpawnRecord> = {}): SpawnRecord => ({
  spawnId: '01HZZZZZZZZZZZZZZZZZZZZZZZ',
  workflowId: 'wf-ledger',
  stage: 'implement',
  iteration: 1,
  backend: 'claude-code',
  model: 'claude-sonnet-5-5',
  authMode: 'subscription',
  agentRole: 'developer',
  promptBytes: 1200,
  promptSections: {
    staticContext: 100,
    dynamicContext: 0,
    handoffContext: 200,
    systemPrompt: 300,
    task: 600,
    other: 0,
    total: 1200,
  },
  tokensUsed: 1500,
  inputTokens: 1000,
  outputTokens: 500,
  costUsd: 0.123456789,
  startedAt: '2026-10-16T10:00:00.000Z',
  endedAt: '2026-10-16T10:00:05.000Z',
  durationMs: 5000,
  exitReason: 'ok',
  success: true,
  salvaged: false,
  providerSessionId: 'sess-1',
  ...overrides,
});

describe('AuditLogger', () => {
  let testDir: string;
  let logDir: string;
  let logger: AuditLogger;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'airunx-audit-'));
    logDir = join(testDir, 'audit');
    logger = new AuditLogger(logDir);
  });

  afterEach(() => {
    vi.useRealTimers();
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('envelope', () => {
    it('adds schema_version, unique event_id and run_id to every event', () => {
      logger.logStageStart('wf-1', 'plan');
      logger.logStageStart('wf-1', 'implement');
      logger.logHeartbeatStart();

      const [a, b, c] = readLines(logger.getLogPath());
      expect(a.schema_version).toBe(1);
      expect(a.event_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(a.run_id).toBe('wf-1');
      expect(a.event_id).not.toBe(b.event_id);
      // Monotonic ULIDs sort in write order
      expect(String(a.event_id) < String(b.event_id)).toBe(true);
      // Events without a workflow have no run_id
      expect(c.run_id).toBeUndefined();
      expect(c.event_id).toBeDefined();
    });
  });

  describe('logLlmSpawn', () => {
    it('writes one llm_spawn event with R1 fields and micro-USD cost', () => {
      logger.logLlmSpawn(
        spawnRecord({ parentSpawnId: '01HPARENTPARENTPARENTPAREN' })
      );

      const [event] = readLines(logger.getLogPath());
      expect(event).toMatchObject({
        event: 'llm_spawn',
        workflowId: 'wf-ledger',
        run_id: 'wf-ledger',
        spawn_id: '01HZZZZZZZZZZZZZZZZZZZZZZZ',
        parent_spawn_id: '01HPARENTPARENTPARENTPAREN',
        schema_version: 1,
      });
      expect(event.details).toMatchObject({
        backend: 'claude-code',
        model: 'claude-sonnet-5-5',
        auth_mode: 'subscription',
        agent_role: 'developer',
        stage: 'implement',
        iteration: 1,
        prompt_bytes: 1200,
        tokens_used: 1500,
        input_tokens: 1000,
        output_tokens: 500,
        cost_usd: 0.123456789,
        cost_micro_usd: 123457,
        started_at: '2026-10-16T10:00:00.000Z',
        ended_at: '2026-10-16T10:00:05.000Z',
        duration_ms: 5000,
        exit_reason: 'ok',
        success: true,
        salvaged: false,
        provider_session_id: 'sess-1',
      });
      expect(
        (event.details as Record<string, unknown>).prompt_sections
      ).toMatchObject({ task: 600, total: 1200 });
    });

    it('records provenance, billing basis, normalized and raw provider usage', () => {
      logger.logLlmSpawn(
        spawnRecord({
          costProvenance: 'reported',
          billingBasis: 'api_equivalent',
          derivedCostUsd: 0.1,
          pricingVersion: 'sha256:0123456789ab',
          unmodeledModifiers: [],
          tokens: {
            inputTokens: 1300,
            outputTokens: 500,
            cacheReadInputTokens: 200,
            cacheWriteInputTokens: 100,
          },
          tokenProvenance: 'reported',
          providerUsage: { 'usage.input_tokens': 1000 },
          semconvVersion: '1.38.0',
        })
      );
      const [event] = readLines(logger.getLogPath());
      expect(event.details).toMatchObject({
        cost_provenance: 'reported',
        billing_basis: 'api_equivalent',
        derived_cost_micro_usd: 100_000,
        pricing_version: 'sha256:0123456789ab',
        token_provenance: 'reported',
        semconv_version: '1.38.0',
        usage: {
          input_tokens: 1300,
          cache_read_input_tokens: 200,
          cache_write_input_tokens: 100,
        },
        provider_usage: { 'usage.input_tokens': 1000 },
      });
    });

    it('labels a spawn without cost provenance as missing', () => {
      logger.logLlmSpawn(spawnRecord({ costUsd: undefined }));
      const [event] = readLines(logger.getLogPath());
      expect((event.details as Record<string, unknown>).cost_provenance).toBe(
        'missing'
      );
    });

    it('converts USD to integer micro-USD', () => {
      expect(toMicroUsd(1.5)).toBe(1_500_000);
      expect(toMicroUsd(0)).toBe(0);
      expect(toMicroUsd(undefined)).toBeUndefined();
      expect(Number.isInteger(toMicroUsd(0.0000004))).toBe(true);
    });
  });

  describe('createAuditSpawnObserver', () => {
    it('routes spawn records into the ledger', () => {
      const observer = createAuditSpawnObserver(logger);
      observer.onSpawnComplete(spawnRecord(), {} as ExecutionRequest);
      const events = readLines(logger.getLogPath());
      expect(events).toHaveLength(1);
      expect(events[0].event).toBe('llm_spawn');
    });

    it('swallows write failures and reports them', () => {
      const failing = {
        logLlmSpawn: () => {
          throw new Error('disk full');
        },
      } as unknown as AuditLogger;
      const onError = vi.fn();
      const observer = createAuditSpawnObserver(failing, onError);
      expect(() =>
        observer.onSpawnComplete(spawnRecord(), {} as ExecutionRequest)
      ).not.toThrow();
      expect(onError).toHaveBeenCalledOnce();
    });

    it('routes attempt and delegation records into the ledger', () => {
      const observer = createAuditSpawnObserver(logger);
      observer.onAttempt?.(
        {
          workflowId: 'wf-ledger',
          stage: 'implement',
          iteration: 1,
          spawnId: 'spawn-a',
          attempt: 2,
          backendAttempt: 1,
          backend: 'codex',
          agentRole: 'developer',
          outcome: 'failure',
          errorCategory: 'model_rejected',
          fallback: false,
          costUsd: 0.0123,
        },
        {} as ExecutionRequest
      );
      observer.onDelegation?.(
        {
          phase: 'completion',
          workflowId: 'wf-ledger',
          spawnId: 'spawn-main',
          triggerReason: 'keyword',
          keyword: 'system design',
          keywordSource: 'task',
          taskLength: 40,
          lengthThreshold: 500,
          subAgentCount: 3,
          subAgents: ['a', 'b', 'c'],
          succeededCount: 3,
          marginalCostUsd: 0.03,
          marginalCostMicroUsd: 30_000,
        },
        {} as ExecutionRequest
      );
      logger.logIterationDecision('wf-ledger', {
        stage: 'judge',
        verdict: 'ITERATE',
        iteration: 1,
        maxIterations: 3,
        gapCount: 2,
        willIterate: true,
        iterationCostUsd: 1.5,
        projectedRerunCostUsd: 1.25,
      });

      const [attempt, delegation, decision] = readLines(logger.getLogPath());
      expect(attempt).toMatchObject({
        event: 'attempt',
        run_id: 'wf-ledger',
        spawn_id: 'spawn-a',
        details: {
          attempt: 2,
          error_category: 'model_rejected',
          salvaged: true,
          cost_micro_usd: 12_300,
        },
      });
      expect(delegation).toMatchObject({
        event: 'delegation',
        spawn_id: 'spawn-main',
        details: {
          phase: 'completion',
          trigger_reason: 'keyword',
          keyword: 'system design',
          sub_agent_count: 3,
          marginal_cost_micro_usd: 30_000,
        },
      });
      expect(decision).toMatchObject({
        event: 'iteration_decision',
        details: {
          verdict: 'ITERATE',
          iteration: 1,
          max_iterations: 3,
          gap_count: 2,
          iteration_cost_micro_usd: 1_500_000,
          projected_rerun_cost_micro_usd: 1_250_000,
        },
      });
    });
  });

  describe('dated files', () => {
    it('writes to a new dated file after UTC midnight', () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-16T23:59:59.500Z'));
      const longLived = new AuditLogger(logDir);
      longLived.logStageStart('wf-1', 'before-midnight');

      vi.setSystemTime(new Date('2026-10-17T00:00:00.500Z'));
      longLived.logStageStart('wf-1', 'after-midnight');

      const files = readdirSync(logDir).sort();
      expect(files).toEqual([
        'audit-2026-10-16.jsonl',
        'audit-2026-10-17.jsonl',
      ]);
      expect(
        readLines(join(logDir, 'audit-2026-10-16.jsonl'))[0].details
      ).toMatchObject({ stageName: 'before-midnight' });
      expect(
        readLines(join(logDir, 'audit-2026-10-17.jsonl'))[0].details
      ).toMatchObject({ stageName: 'after-midnight' });
    });
  });

  describe('permissions', () => {
    it.skipIf(process.platform === 'win32')(
      'creates the directory 0700 and files 0600',
      () => {
        logger.logStageStart('wf-1', 'plan');
        expect(statSync(logDir).mode & 0o777).toBe(0o700);
        expect(statSync(logger.getLogPath()).mode & 0o777).toBe(0o600);
      }
    );

    it.skipIf(process.platform === 'win32')(
      'tightens a pre-existing world-readable audit directory',
      () => {
        const dir = join(logDir, 'preexisting');
        mkdirSync(dir, { mode: 0o755 });
        chmodSync(dir, 0o755);
        new AuditLogger(dir);
        expect(statSync(dir).mode & 0o777).toBe(0o700);
      }
    );

    it.skipIf(process.platform === 'win32')(
      'tightens a pre-existing world-readable log file',
      () => {
        const path = logger.getLogPath();
        writeFileSync(path, '', { mode: 0o644 });
        logger.logStageStart('wf-1', 'plan');
        expect(statSync(path).mode & 0o777).toBe(0o600);
      }
    );
  });

  describe('redaction and size cap', () => {
    it('redacts API-key-shaped strings and sensitive keys in details', () => {
      logger.logHeartbeatError(
        new Error('auth failed with sk-ant-api03-abcdefghijklmnopqrstuvwxyz'),
        { nested: { token: 'plain-secret', note: 'ghp_' + 'a'.repeat(36) } }
      );

      const raw = readFileSync(logger.getLogPath(), 'utf-8');
      expect(raw).not.toContain('abcdefghijklmnopqrstuvwxyz');
      expect(raw).not.toContain('plain-secret');
      expect(raw).not.toContain('a'.repeat(36));
      const [event] = readLines(logger.getLogPath());
      const details = event.details as Record<string, unknown>;
      expect(details.error).toContain('sk-a****');
      expect(details.nested).toMatchObject({ token: '[redacted]' });
    });

    it('truncates oversized details with a marker under the cap', () => {
      logger.logTaskFailed('wf-1', 'task-1', 'x'.repeat(20_000));

      const raw = readFileSync(logger.getLogPath(), 'utf-8');
      expect(Buffer.byteLength(raw, 'utf8')).toBeLessThanOrEqual(
        MAX_AUDIT_RECORD_BYTES
      );
      const [event] = readLines(logger.getLogPath());
      const details = event.details as Record<string, unknown>;
      expect(details._truncated).toBe(true);
      expect(details._original_bytes).toBeGreaterThan(20_000);
      expect(details.taskId).toBe('task-1');
      expect(String(details.error)).toContain('[truncated]');
    });

    it('falls back to a bounded preview when many fields overflow', () => {
      const wide: Record<string, string> = {};
      for (let i = 0; i < 500; i++) wide[`field_${i}`] = 'v'.repeat(50);
      logger.logHeartbeatStart(wide);

      const raw = readFileSync(logger.getLogPath(), 'utf-8');
      expect(Buffer.byteLength(raw, 'utf8')).toBeLessThanOrEqual(
        MAX_AUDIT_RECORD_BYTES
      );
      const [event] = readLines(logger.getLogPath());
      const details = event.details as Record<string, unknown>;
      expect(details._truncated).toBe(true);
      expect(typeof details.preview).toBe('string');
    });
  });

  describe('query', () => {
    it('skips a torn line and reports the skipped count', async () => {
      logger.logStageStart('wf-1', 'plan');
      // Simulate a torn write (process killed mid-line)
      appendFileSync(logger.getLogPath(), '{"timestamp":"2026-10-16T1');
      appendFileSync(logger.getLogPath(), '\n');
      logger.logStageComplete('wf-1', 'plan', 100);

      const { events, skipped } = await logger.queryWithStats({
        workflowId: 'wf-1',
      });
      expect(skipped).toBe(1);
      expect(events.map((e) => e.event)).toEqual([
        'stage_complete',
        'stage_start',
      ]);
      // Legacy API still returns plain events
      expect(await logger.query({ workflowId: 'wf-1' })).toHaveLength(2);
      // readRecentEvents tolerates the torn line too
      expect(logger.readRecentEvents()).toHaveLength(2);
    });

    it('dedupes events by event_id', async () => {
      logger.log({ event: 'stage_start', workflowId: 'wf-1', event_id: 'dup' });
      logger.log({ event: 'stage_start', workflowId: 'wf-1', event_id: 'dup' });

      const events = await logger.query({ workflowId: 'wf-1' });
      expect(events).toHaveLength(1);
    });

    it('excludes event types before applying the limit', async () => {
      logger.logStageStart('wf-1', 'plan');
      logger.logLlmSpawn(spawnRecord({ workflowId: 'wf-1' }));
      logger.logLlmSpawn(spawnRecord({ workflowId: 'wf-1' }));

      const events = await logger.query({
        workflowId: 'wf-1',
        excludeEventTypes: ['llm_spawn'],
        limit: 1,
      });
      expect(events.map((e) => e.event)).toEqual(['stage_start']);
    });
  });
});
