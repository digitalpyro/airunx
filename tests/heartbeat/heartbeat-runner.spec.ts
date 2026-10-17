/**
 * HeartbeatRunner tests — killed-run report hand-off (U5)
 * The heartbeat pre-generates the workflow ID, passes it to `run`, and on a
 * kill/timeout/unparsable stdout reads the incremental run report from
 * `.airunx-state/reports/<workflowId>.json`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
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

// ─── Process topology (U9) — real processes ──────────────────────────────────

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'kill-path'
);

describe.skipIf(process.platform === 'win32')(
  'HeartbeatRunner group kill (real processes)',
  () => {
    let tmpDir: string;
    let origCwd: string;
    let queue: GitHubTaskQueue;
    let spawnOptions: Array<{ detached?: boolean }>;
    /** Extra fake-run.mjs args (e.g. `exit`) */
    let runMode: string[];
    const origTimeout = process.env.AIRUNX_CHILD_TIMEOUT_MS;

    const logPath = (): string => join(tmpDir, 'signals.log');
    const pidPath = (): string => join(tmpDir, 'grandchild.pid');
    const grandchildPid = (): number =>
      existsSync(pidPath()) ? Number(readFileSync(pidPath(), 'utf-8')) : 0;
    const logLines = (): string[] =>
      existsSync(logPath())
        ? readFileSync(logPath(), 'utf-8').split('\n').filter(Boolean)
        : [];
    const isAlive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const waitFor = async (
      condition: () => boolean,
      timeoutMs = 5_000
    ): Promise<boolean> => {
      const deadline = Date.now() + timeoutMs;
      while (!condition() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      return condition();
    };

    const makeRunner = (childGraceMs = 300): HeartbeatRunner => {
      const runner = new HeartbeatRunner({
        repo: 'o/r',
        lockPath: join(tmpDir, 'heartbeat.lock'),
        auditDir: join(tmpDir, 'audit'),
        childGraceMs,
      });
      (runner as unknown as { taskQueue: GitHubTaskQueue }).taskQueue = queue;
      return runner;
    };

    beforeEach(async () => {
      vi.clearAllMocks();
      tmpDir = mkdtempSync(join(tmpdir(), 'heartbeat-group-'));
      origCwd = process.cwd();
      process.chdir(tmpDir);
      queue = new GitHubTaskQueue('o/r', 'me');
      vi.spyOn(queue, 'pollTasks').mockResolvedValue([task]);
      vi.spyOn(queue, 'checkoutTask').mockResolvedValue(true);
      vi.spyOn(queue, 'updateHeartbeatTimestamp').mockResolvedValue();
      vi.spyOn(queue, 'failTask').mockResolvedValue();
      vi.spyOn(queue, 'releaseTask').mockResolvedValue();

      // `airunx run` is replaced by fake-run.mjs: it ignores SIGTERM and
      // owns a signal-ignoring fake CLI in its process group
      const actual =
        await vi.importActual<typeof import('child_process')>('child_process');
      spawnOptions = [];
      runMode = [];
      vi.mocked(spawn).mockImplementation(((
        cmd: string,
        _args: readonly string[],
        options: { detached?: boolean }
      ) => {
        spawnOptions.push(options);
        return actual.spawn(
          cmd,
          [
            join(FIXTURES, 'fake-run.mjs'),
            join(FIXTURES, 'fake-cli.mjs'),
            logPath(),
            pidPath(),
            ...runMode,
          ],
          options
        );
      }) as unknown as typeof spawn);
    });

    afterEach(() => {
      const pid = grandchildPid();
      if (pid && isAlive(pid)) process.kill(pid, 'SIGKILL');
      process.chdir(origCwd);
      rmSync(tmpDir, { recursive: true, force: true });
      if (origTimeout === undefined) delete process.env.AIRUNX_CHILD_TIMEOUT_MS;
      else process.env.AIRUNX_CHILD_TIMEOUT_MS = origTimeout;
    });

    it('child timeout: SIGTERM to run only, then group SIGKILL leaves no CLI grandchild', async () => {
      process.env.AIRUNX_CHILD_TIMEOUT_MS = '800';
      const runner = makeRunner();

      await runner.runOneCycle(config);

      // run is spawned as a process-group leader
      expect(spawnOptions[0].detached).toBe(true);
      const pid = grandchildPid();
      expect(pid).toBeGreaterThan(0);
      // Killed grandchild is reparented and reaped; wait for it to vanish
      expect(await waitFor(() => !isAlive(pid))).toBe(true);
      // Heartbeat signalled only run (pid) before the final group SIGKILL:
      // the CLI never saw SIGINT/SIGTERM from the heartbeat
      const lines = logLines();
      expect(lines.filter((l) => l === 'run SIGTERM')).toHaveLength(1);
      expect(lines.filter((l) => l === 'SIGINT' || l === 'SIGTERM')).toEqual(
        []
      );
      const result = vi.mocked(queue.failTask).mock.calls[0][1];
      expect(result.error?.message).toContain('[PROCESS TIMED OUT]');
    });

    it('stop(): waits out the grace, then group SIGKILL leaves no CLI grandchild', async () => {
      process.env.AIRUNX_CHILD_TIMEOUT_MS = String(60 * 60 * 1000);
      const runner = makeRunner();

      const cycle = runner.runOneCycle(config);
      expect(await waitFor(() => grandchildPid() > 0)).toBe(true);
      const pid = grandchildPid();
      expect(isAlive(pid)).toBe(true);

      const started = Date.now();
      await runner.stop();
      await cycle;

      expect(Date.now() - started).toBeLessThan(5_000);
      expect(await waitFor(() => !isAlive(pid))).toBe(true);
      expect(logLines().filter((l) => l === 'run SIGTERM')).toHaveLength(1);
    });

    it('stop() twice: run receives exactly one SIGTERM', async () => {
      process.env.AIRUNX_CHILD_TIMEOUT_MS = String(60 * 60 * 1000);
      const runner = makeRunner();

      const cycle = runner.runOneCycle(config);
      expect(await waitFor(() => grandchildPid() > 0)).toBe(true);
      const pid = grandchildPid();

      const first = runner.stop();
      const second = runner.stop();
      expect(second).toBe(first);
      await Promise.all([first, second]);
      await cycle;

      expect(await waitFor(() => !isAlive(pid))).toBe(true);
      expect(logLines().filter((l) => l === 'run SIGTERM')).toHaveLength(1);
    });

    it('child timeout then stop(): one shared SIGTERM + grace sequence', async () => {
      process.env.AIRUNX_CHILD_TIMEOUT_MS = '300';
      const runner = makeRunner(1_000);

      const cycle = runner.runOneCycle(config);
      expect(
        await waitFor(() => logLines().includes('run SIGTERM'), 5_000)
      ).toBe(true);
      const pid = grandchildPid();

      // Heartbeat stop arrives during the timeout's grace window
      await runner.stop();
      await cycle;

      expect(await waitFor(() => !isAlive(pid))).toBe(true);
      expect(logLines().filter((l) => l === 'run SIGTERM')).toHaveLength(1);
    });

    it('run exits on its own: CLI left in its process group is reaped', async () => {
      process.env.AIRUNX_CHILD_TIMEOUT_MS = String(60 * 60 * 1000);
      runMode = ['exit'];
      const runner = makeRunner();

      await runner.runOneCycle(config);

      const pid = grandchildPid();
      expect(pid).toBeGreaterThan(0);
      expect(await waitFor(() => !isAlive(pid))).toBe(true);
      // Never signalled through SIGTERM: run exited by itself
      expect(logLines().filter((l) => l === 'run SIGTERM')).toEqual([]);
    });
  }
);
