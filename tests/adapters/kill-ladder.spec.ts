/**
 * Kill ladder unit tests (fake child, fake timers)
 */

import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createKillLadder,
  processRunning,
  type SignalLadder,
} from '../../src/adapters/kill-ladder.js';

const timings: SignalLadder = {
  interruptGraceMs: 100,
  terminateGraceMs: 100,
  postKillSettleMs: 50,
};

class FakeChild extends EventEmitter {
  pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  signals: string[] = [];
  /** Signals the fake exits on */
  exitOn = new Set<string>();

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    if (this.exitOn.has(signal)) this.exit(null, signal);
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

describe('createKillLadder', () => {
  let child: FakeChild;
  let onGiveUp: ReturnType<typeof vi.fn>;

  const ladder = () =>
    createKillLadder({
      child: child as unknown as ChildProcess,
      timings,
      onGiveUp,
    });

  beforeEach(() => {
    vi.useFakeTimers();
    child = new FakeChild();
    onGiveUp = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('escalates SIGINT → SIGTERM → SIGKILL, then gives up', () => {
    const l = ladder();
    l.start();
    expect(l.started).toBe(true);
    expect(child.signals).toEqual(['SIGINT']);
    vi.advanceTimersByTime(100);
    expect(child.signals).toEqual(['SIGINT', 'SIGTERM']);
    vi.advanceTimersByTime(100);
    expect(child.signals).toEqual(['SIGINT', 'SIGTERM', 'SIGKILL']);
    expect(onGiveUp).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(onGiveUp).toHaveBeenCalledTimes(1);
  });

  it('exit on SIGINT arms the give-up fallback (stdio may stay open)', () => {
    child.exitOn.add('SIGINT');
    ladder().start();
    expect(processRunning(child as unknown as ChildProcess)).toBe(false);
    vi.advanceTimersByTime(50);
    expect(onGiveUp).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_000);
    expect(onGiveUp).toHaveBeenCalledTimes(1);
    expect(child.signals).toEqual(['SIGINT']);
  });

  it('process already exited at start: no signal, fallback armed', () => {
    child.exit(0);
    ladder().start();
    expect(child.signals).toEqual([]);
    vi.advanceTimersByTime(50);
    expect(onGiveUp).toHaveBeenCalledTimes(1);
  });

  it('alreadySignaled skips SIGINT; start is idempotent', () => {
    const l = ladder();
    l.start(true);
    l.start();
    expect(child.signals).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(child.signals).toEqual(['SIGTERM']);
  });

  it('dispose clears timers and the exit listener', () => {
    const l = ladder();
    l.start();
    l.dispose();
    child.exit(130);
    vi.advanceTimersByTime(1_000);
    expect(child.signals).toEqual(['SIGINT']);
    expect(onGiveUp).not.toHaveBeenCalled();
    expect(child.listenerCount('exit')).toBe(0);
  });
});
