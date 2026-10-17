/**
 * Run shutdown integration test (U9)
 *
 * Drives a real LangGraphRunner whose CLI spawns are real node processes
 * (tests/fixtures/kill-path/fake-cli.mjs). Mid-stage, `run`'s SIGTERM handler
 * fires: the in-flight CLI is interrupted once and escalated, its estimated
 * llm_spawn event is written, the runner flushes a final report carrying the
 * in-flight stage as `killed`, and only then does the process exit.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { BaseCliAdapter } from '../../src/adapters/base-cli-adapter.js';
import type {
  CliAdapterConfig,
  SignalLadder,
} from '../../src/adapters/base-cli-adapter.js';
import type {
  AdapterConfig,
  BackendAvailability,
  ExecutionRequest,
} from '../../src/core/adapter-types.js';
import type {
  Pipeline,
  RunReport,
  WorkflowContext,
} from '../../src/core/types.js';
import { LangGraphRunner } from '../../src/orchestrator/langgraph-runner.js';
import { StateManager } from '../../src/orchestrator/state-manager.js';
import {
  AuditLogger,
  createAuditSpawnObserver,
} from '../../src/audit/audit-logger.js';
import type { AuditEvent } from '../../src/audit/audit-logger.js';
import {
  installShutdownSignalHandlers,
  shutdownCoordinator,
} from '../../src/utils/shutdown-coordinator.js';
import { runSpendTracker } from '../../src/adapters/spend-estimator.js';
import { HEARTBEAT_CHILD_GRACE_MS } from '../../src/heartbeat/heartbeat-runner.js';

const FAKE_CLI = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'kill-path',
  'fake-cli.mjs'
);
const WORKFLOW_ID = 'wf-shutdown-fixture';

/** orchestrator finishes with result JSON; developer ignores SIGINT/SIGTERM */
class ProcessFixtureAdapter extends BaseCliAdapter {
  name = 'claude-code' as const;
  constructor(private logDir: string) {
    super();
  }

  protected getCliConfig(): CliAdapterConfig {
    return {
      cliCommand: process.execPath,
      installInstructions: 'n/a',
      pricingMap: { 'fixture-model': { input: 3, output: 15 } },
      defaultModel: 'fixture-model',
    };
  }

  protected buildCliArgs(request: ExecutionRequest): string[] {
    const role = request.agent.role;
    const mode = role === 'developer' ? 'ignore' : 'finish';
    return [FAKE_CLI, mode, join(this.logDir, `${role}.log`)];
  }

  protected getSignalLadder(): SignalLadder {
    return {
      interruptGraceMs: 300,
      terminateGraceMs: 300,
      postKillSettleMs: 300,
    };
  }

  async init(config: AdapterConfig): Promise<void> {
    this.config = config;
    this.initialized = true;
  }

  async isAvailable(): Promise<BackendAvailability> {
    return { available: true };
  }
}

describe.skipIf(process.platform === 'win32')(
  'run shutdown: events before final report flush',
  () => {
    let testDir: string;
    let origCwd: string;

    beforeEach(() => {
      shutdownCoordinator.reset();
      runSpendTracker.reset();
      runSpendTracker.setReportsDir(null);
      testDir = mkdtempSync(join(tmpdir(), 'airunx-shutdown-'));
      origCwd = process.cwd();
      process.chdir(testDir);
    });

    afterEach(() => {
      shutdownCoordinator.reset();
      process.chdir(origCwd);
      rmSync(testDir, { recursive: true, force: true });
    });

    it('SIGTERM mid-stage: estimated event written, then killed stage in final report, then exit', async () => {
      const auditDir = join(testDir, 'audit');
      const stateManager = new StateManager(join(testDir, 'state'));
      const adapter = new ProcessFixtureAdapter(testDir);
      await adapter.init({ type: 'cli', timeout: 600 });
      adapter.setSpawnObserver(
        createAuditSpawnObserver(new AuditLogger(auditDir))
      );

      const pipeline = {
        name: 'shutdown-pipeline',
        description: 'Shutdown fixture pipeline',
        default_fidelity: 'standard',
        stages: [
          { name: 'plan', agent: 'orchestrator', input: 'Plan the work' },
          { name: 'implement', agent: 'developer', input: 'Implement it' },
        ],
      } as Pipeline;
      const workflowContext: WorkflowContext = {
        id: WORKFLOW_ID,
        input: 'Add a feature',
        inputType: 'prompt',
        mode: 'pipeline',
        fidelityLevel: 'standard',
        createdAt: new Date(),
        status: 'initializing',
        iterationCount: 0,
        maxIterations: 1,
        todos: [],
        metrics: {
          tokensUsed: 0,
          totalTokens: 0,
          runtime: 0,
          totalRuntimeMs: 0,
          stagesCompleted: 0,
          totalStages: 2,
          errors: 0,
          totalCost: 0,
        },
      };
      await stateManager.save(workflowContext);

      const readEvents = (): AuditEvent[] =>
        existsSync(auditDir)
          ? readdirSync(auditDir)
              .filter((f) => f.endsWith('.jsonl'))
              .flatMap((f) =>
                readFileSync(join(auditDir, f), 'utf-8')
                  .split('\n')
                  .filter(Boolean)
                  .map((line) => JSON.parse(line) as AuditEvent)
              )
          : [];
      const reportPath = join(
        testDir,
        '.airunx-state',
        'reports',
        `${WORKFLOW_ID}.json`
      );

      // Snapshot of the world at the moment `run` would exit
      let exitSnapshot:
        | { code: number; report: RunReport; events: AuditEvent[] }
        | undefined;
      const signals = new EventEmitter();
      const uninstall = installShutdownSignalHandlers({
        target: signals,
        attachedToTerminal: () => false,
        exit: (code) => {
          exitSnapshot = {
            code,
            report: JSON.parse(readFileSync(reportPath, 'utf-8')) as RunReport,
            events: readEvents(),
          };
        },
      });

      const runner = new LangGraphRunner({
        adapter,
        stateManager,
        pipeline,
        workflowContext,
      });
      const execution = runner.execute().catch(() => undefined);

      // Wait until the implement-stage CLI is running
      const devLog = join(testDir, 'developer.log');
      const deadline = Date.now() + 10_000;
      while (
        !(existsSync(devLog) && readFileSync(devLog, 'utf-8').includes('pid'))
      ) {
        if (Date.now() > deadline) throw new Error('developer CLI not started');
        await new Promise((r) => setTimeout(r, 20));
      }

      const started = Date.now();
      signals.emit('SIGTERM');
      while (!exitSnapshot && Date.now() - started < HEARTBEAT_CHILD_GRACE_MS) {
        await new Promise((r) => setTimeout(r, 20));
      }
      const shutdownMs = Date.now() - started;
      uninstall();
      await execution;

      expect(exitSnapshot).toBeDefined();
      const { code, report, events } = exitSnapshot!;
      expect(code).toBe(143);
      expect(shutdownMs).toBeLessThan(HEARTBEAT_CHILD_GRACE_MS);

      // The interrupted spawn's event was on disk before the flush/exit
      const spawns = events.filter((e) => e.event === 'llm_spawn');
      const implement = spawns.filter((s) => s.details?.stage === 'implement');
      expect(implement).toHaveLength(1);
      expect(implement[0].details?.exit_reason).toBe('signal');
      expect(implement[0].details?.cost_provenance).toBe('estimated');
      const planSpawn = spawns.find((s) => s.details?.stage === 'plan');
      expect(planSpawn?.details?.cost_provenance).toBe('reported');

      // Exactly one SIGINT reached the CLI; the ladder escalated
      const devSignals = readFileSync(devLog, 'utf-8')
        .split('\n')
        .filter((l) => l === 'SIGINT' || l === 'SIGTERM');
      expect(devSignals).toEqual(['SIGINT', 'SIGTERM']);

      // Final report: completed plan + killed implement with estimated spend
      expect(report.status).toBe('interrupted');
      expect(report.stages.map((s) => [s.stage, s.status])).toEqual([
        ['plan', 'completed'],
        ['implement', 'killed'],
      ]);
      const killed = report.stages[1];
      const estimatedUsd =
        Number(implement[0].details?.cost_micro_usd ?? 0) / 1e6;
      expect(killed.costUsd).toBeGreaterThan(0);
      expect(killed.costUsd).toBeCloseTo(estimatedUsd, 5);
      expect(killed.costSummary?.provenance).toBe('estimated');
      expect(killed.costSummary?.estimationMethods).toContain('kill_time');
      expect(report.totalCostUsd).toBeCloseTo(0.123 + killed.costUsd, 5);
    });
  }
);
