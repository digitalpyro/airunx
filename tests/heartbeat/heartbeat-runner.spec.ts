/**
 * HeartbeatRunner tests — killed-run report hand-off (U5)
 * The heartbeat pre-generates the workflow ID, passes it to `run`, and on a
 * kill/timeout/unparsable stdout reads the incremental run report from
 * `.airunx-state/reports/<workflowId>.json`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { RunReport } from '../../src/core/types.js';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: vi.fn() };
});

vi.mock('../../src/integrations/github-cli.js', () => ({
  GitHubCLI: {
    updateIssueLabels: vi.fn().mockResolvedValue(undefined),
    addIssueComment: vi.fn().mockResolvedValue(undefined),
    unassignIssue: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../src/utils/circuit-breaker.js', () => ({
  CircuitBreaker: vi.fn(
    class {
      isOpen = vi.fn().mockResolvedValue(false);
      recordFailure = vi.fn();
    }
  ),
  getDefaultStateFilePath: () => '/nonexistent/circuit.json',
}));

import { spawn } from 'child_process';
import { HeartbeatRunner } from '../../src/heartbeat/heartbeat-runner.js';
import { GitHubTaskQueue } from '../../src/task-queue/github-task-queue.js';
import { GitHubCLI } from '../../src/integrations/github-cli.js';
import type {
  GitHubTask,
  HeartbeatConfig,
} from '../../src/task-queue/types.js';
import { WORKFLOW_ID_PATTERN } from '../../src/utils/workflow-id.js';

const COST_LINE =
  '$0.42 API-equivalent (subscription) — 60% reported/derived, 40% estimated';

const task: GitHubTask = {
  id: '42',
  issueUrl: 'https://github.com/o/r/issues/42',
  title: 'Do the thing',
  body: '',
  labels: ['airunx:pending'],
  createdAt: new Date(),
  priority: 'p2',
};

const config: HeartbeatConfig = {
  intervalMs: 1,
  maxIdleCycles: 1,
  idlePauseMs: 1,
  defaultPipeline: 'standard',
  repo: 'o/r',
};

function makeReport(workflowId: string): RunReport {
  return {
    workflowId,
    pipelineName: 'standard',
    status: 'running',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    totalDurationMs: 60_000,
    totalTokens: 12_345,
    totalCostUsd: 0.42,
    iterationCount: 1,
    maxIterations: 3,
    iterations: [],
    stages: [
      {
        stage: 'plan',
        agent: 'orchestrator',
        backend: 'claude-code',
        spawnCount: 1,
        durationMs: 30_000,
        tokensUsed: 12_345,
        costUsd: 0.42,
        timestamp: new Date().toISOString(),
        status: 'completed',
      },
    ],
    timeline: [],
    costSummaryLine: COST_LINE,
  };
}

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  killed: boolean;
  kill: (signal?: string) => boolean;
}

/** A child that writes the incremental report, then hangs until killed */
function hangingChildWritingReport(cwd: string): {
  argsSeen: string[][];
} {
  const argsSeen: string[][] = [];
  vi.mocked(spawn).mockImplementation(((
    _cmd: string,
    args: readonly string[]
  ) => {
    argsSeen.push([...args]);
    const idIndex = args.indexOf('--workflow-id');
    const workflowId = args[idIndex + 1];
    const dir = join(cwd, '.airunx-state', 'reports');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${workflowId}.json`),
      JSON.stringify(makeReport(workflowId))
    );

    const child = new EventEmitter() as FakeChild;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = (signal?: string): boolean => {
      child.killed = true;
      setImmediate(() => child.emit('close', null, signal ?? 'SIGTERM'));
      return true;
    };
    return child;
  }) as unknown as typeof spawn);
  return { argsSeen };
}

describe('HeartbeatRunner killed-run report hand-off', () => {
  let tmpDir: string;
  let origCwd: string;
  let runner: HeartbeatRunner;
  let queue: GitHubTaskQueue;
  const origTimeout = process.env.AIRUNX_CHILD_TIMEOUT_MS;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = mkdtempSync(join(tmpdir(), 'heartbeat-test-'));
    origCwd = process.cwd();
    process.chdir(tmpDir);
    process.env.AIRUNX_CHILD_TIMEOUT_MS = '30';

    runner = new HeartbeatRunner({
      repo: 'o/r',
      lockPath: join(tmpDir, 'heartbeat.lock'),
      auditDir: join(tmpDir, 'audit'),
    });
    queue = new GitHubTaskQueue('o/r', 'me');
    vi.spyOn(queue, 'pollTasks').mockResolvedValue([task]);
    vi.spyOn(queue, 'checkoutTask').mockResolvedValue(true);
    vi.spyOn(queue, 'updateHeartbeatTimestamp').mockResolvedValue();
    (runner as unknown as { taskQueue: GitHubTaskQueue }).taskQueue = queue;
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(tmpDir, { recursive: true, force: true });
    if (origTimeout === undefined) delete process.env.AIRUNX_CHILD_TIMEOUT_MS;
    else process.env.AIRUNX_CHILD_TIMEOUT_MS = origTimeout;
  });

  it('timed-out child (exit 124, empty stdout): comment and audit event carry the report cost', async () => {
    const { argsSeen } = hangingChildWritingReport(tmpDir);
    const auditLogger = (
      runner as unknown as {
        auditLogger: { logTaskFailed: (...args: unknown[]) => void };
      }
    ).auditLogger;
    const logTaskFailed = vi.spyOn(auditLogger, 'logTaskFailed');
    const failTask = vi.spyOn(queue, 'failTask');

    await runner.runOneCycle(config);

    // The pre-generated ID was passed to `run` and matches the strict pattern
    expect(argsSeen).toHaveLength(1);
    const idIndex = argsSeen[0].indexOf('--workflow-id');
    expect(idIndex).toBeGreaterThan(-1);
    const workflowId = argsSeen[0][idIndex + 1];
    expect(workflowId).toMatch(WORKFLOW_ID_PATTERN);

    // Task result is built from the on-disk report found via that ID
    expect(failTask).toHaveBeenCalledTimes(1);
    const result = failTask.mock.calls[0][1];
    expect(result.error?.message).toContain('[PROCESS TIMED OUT]');
    expect(result.runReport?.workflowId).toBe(workflowId);
    expect(result.runReport?.stages).toHaveLength(1);
    expect(result.metrics?.costUsd).toBe(0.42);
    expect(result.metrics?.costSummaryLine).toBe(COST_LINE);

    // Issue comment carries the labeled spend
    const body = vi.mocked(GitHubCLI.addIssueComment).mock.calls[0][0].body;
    expect(body).toContain('Cost: $0.4200');
    expect(body).toContain(`Spend: ${COST_LINE}`);
    expect(body).toContain('| plan |');

    // Heartbeat audit event uses the same workflow ID and carries the cost
    expect(logTaskFailed).toHaveBeenCalledWith(
      workflowId,
      '42',
      expect.any(String),
      { costUsd: 0.42, costSummaryLine: COST_LINE }
    );
  });

  it('prefers final stdout JSON when it has at least as many stage records', async () => {
    vi.mocked(spawn).mockImplementation(((
      _cmd: string,
      args: readonly string[]
    ) => {
      const workflowId = args[args.indexOf('--workflow-id') + 1];
      const dir = join(tmpDir, '.airunx-state', 'reports');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `${workflowId}.json`),
        JSON.stringify(makeReport(workflowId))
      );
      const child = new EventEmitter() as FakeChild;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.killed = false;
      child.kill = (): boolean => true;
      setImmediate(() => {
        child.stdout.write(
          JSON.stringify({
            workflowId,
            status: 'completed',
            prUrl: 'https://github.com/o/r/pull/1',
            metrics: { cost: 1.5, tokensUsed: 99, durationMs: 1000 },
            stageRecords: [
              { ...makeReport(workflowId).stages[0], costUsd: 1.5 },
            ],
          })
        );
        setImmediate(() => child.emit('close', 0, null));
      });
      return child;
    }) as unknown as typeof spawn);
    const completeTask = vi.spyOn(queue, 'completeTask');

    await runner.runOneCycle(config);

    const result = completeTask.mock.calls[0][1];
    expect(result.status).toBe('completed');
    expect(result.metrics?.costUsd).toBe(1.5);
    expect(result.runReport?.stages[0].costUsd).toBe(1.5);
  });
});
