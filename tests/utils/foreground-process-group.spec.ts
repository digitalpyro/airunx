/**
 * Foreground process group probe + SIGINT ladder start (issue #19)
 */

import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { execFileSync, spawn } from 'child_process';
import {
  isForegroundProcessGroup,
  parseForegroundPs,
  terminalDeliveredSigint,
} from '../../src/utils/foreground-process-group.js';
import {
  ShutdownCoordinator,
  installShutdownSignalHandlers,
} from '../../src/utils/shutdown-coordinator.js';

const psAvailable = (() => {
  try {
    execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
})();

describe('parseForegroundPs', () => {
  it('is true only when pgid equals a positive tpgid', () => {
    expect(parseForegroundPs('72728 72728\n')).toBe(true);
    expect(parseForegroundPs('  72728   72700')).toBe(false);
    expect(parseForegroundPs('72712    0')).toBe(false); // macOS, no ctty
    expect(parseForegroundPs('72712   -1')).toBe(false); // Linux, no ctty
    expect(parseForegroundPs('')).toBe(false);
    expect(parseForegroundPs('PGID TPGID')).toBe(false);
    expect(parseForegroundPs('1 1 1')).toBe(false);
  });
});

describe('isForegroundProcessGroup', () => {
  it('asks ps for pgid and tpgid of the given pid', () => {
    const calls: string[][] = [];
    const result = isForegroundProcessGroup({
      pid: 42,
      exec: (args) => {
        calls.push(args);
        return '7 7';
      },
    });
    expect(result).toBe(true);
    expect(calls).toEqual([['-o', 'pgid=,tpgid=', '-p', '42']]);
  });

  it('answers false when ps fails', () => {
    expect(
      isForegroundProcessGroup({
        exec: () => {
          throw new Error('spawn ps ENOENT');
        },
      })
    ).toBe(false);
  });

  it('answers false, quickly, when the probe times out', () => {
    const started = Date.now();
    const result = isForegroundProcessGroup({
      timeoutMs: 100,
      exec: (_args, timeoutMs) =>
        execFileSync(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], {
          encoding: 'utf8',
          timeout: timeoutMs,
        }),
    });
    expect(result).toBe(false);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it.skipIf(!psAvailable)(
    'real ps: a detached child with no controlling terminal is not foreground',
    async () => {
      const child = spawn(
        process.execPath,
        ['-e', 'setTimeout(() => {}, 10000)'],
        { detached: true, stdio: 'ignore' }
      );
      try {
        await new Promise((resolve) => child.once('spawn', resolve));
        expect(isForegroundProcessGroup({ pid: child.pid })).toBe(false);
      } finally {
        child.kill('SIGKILL');
      }
    }
  );
});

describe('terminalDeliveredSigint', () => {
  it('no TTY: false without probing', () => {
    let probed = false;
    expect(
      terminalDeliveredSigint({
        isTTY: () => false,
        isForeground: () => {
          probed = true;
          return true;
        },
      })
    ).toBe(false);
    expect(probed).toBe(false);
  });

  it('TTY: follows the foreground check, false if it throws', () => {
    const tty = (): boolean => true;
    expect(
      terminalDeliveredSigint({ isTTY: tty, isForeground: () => true })
    ).toBe(true);
    expect(
      terminalDeliveredSigint({ isTTY: tty, isForeground: () => false })
    ).toBe(false);
    expect(
      terminalDeliveredSigint({
        isTTY: tty,
        isForeground: () => {
          throw new Error('boom');
        },
      })
    ).toBe(false);
  });
});

describe('SIGINT ladder start', () => {
  const ladderStartOnSigint = async (
    attachedToTerminal: () => boolean
  ): Promise<{ alreadySignaled: boolean }[]> => {
    const coordinator = new ShutdownCoordinator();
    const signals = new EventEmitter();
    const interrupts: { alreadySignaled: boolean }[] = [];
    coordinator.registerSpawn({ interrupt: (o) => interrupts.push(o) });
    let exited: () => void = () => {};
    const exit = new Promise<void>((resolve) => {
      exited = resolve;
    });
    const uninstall = installShutdownSignalHandlers({
      exit: () => exited(),
      coordinator,
      target: signals,
      attachedToTerminal,
      shutdownOptions: { timeoutMs: 50, flushTimeoutMs: 50 },
    });
    signals.emit('SIGINT');
    await exit;
    uninstall();
    return interrupts;
  };

  const probe = (tty: boolean, ps: () => string) => (): boolean =>
    terminalDeliveredSigint({
      isTTY: () => tty,
      isForeground: () => isForegroundProcessGroup({ exec: ps }),
    });

  it('foreground TTY: CLIs already got SIGINT, ladder starts at SIGTERM', async () => {
    expect(await ladderStartOnSigint(probe(true, () => '10 10'))).toEqual([
      { alreadySignaled: true },
    ]);
  });

  it('TTY but background process group: ladder starts at SIGINT', async () => {
    expect(await ladderStartOnSigint(probe(true, () => '10 20'))).toEqual([
      { alreadySignaled: false },
    ]);
  });

  it('no TTY: ladder starts at SIGINT', async () => {
    expect(await ladderStartOnSigint(probe(false, () => '10 10'))).toEqual([
      { alreadySignaled: false },
    ]);
  });

  it('probe failure: ladder starts at SIGINT', async () => {
    const failing = probe(true, () => {
      throw new Error('ETIMEDOUT');
    });
    expect(await ladderStartOnSigint(failing)).toEqual([
      { alreadySignaled: false },
    ]);
  });

  it('a throwing terminal check: ladder starts at SIGINT', async () => {
    expect(
      await ladderStartOnSigint(() => {
        throw new Error('boom');
      })
    ).toEqual([{ alreadySignaled: false }]);
  });
});
