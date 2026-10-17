/**
 * cleanup command: --workflow-id validation
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

const cleanupSpy = vi.fn();
vi.mock('../../../src/utils/script-cleanup.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../src/utils/script-cleanup.js')
    >();
  return {
    ...actual,
    ScriptCleanup: vi.fn().mockImplementation(() => ({ cleanup: cleanupSpy })),
  };
});

const { cleanupCommand } = await import('../../../src/cli/commands/cleanup.js');
const { ScriptCleanup } = await import('../../../src/utils/script-cleanup.js');

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(ScriptCleanup).mockClear();
  cleanupSpy.mockReset();
});

describe('cleanup --workflow-id', () => {
  it.each(['../../etc/passwd', 'a/b', 'x'.repeat(65), ''])(
    'rejects %j before touching the filesystem',
    async (workflowId) => {
      const exit = vi.spyOn(process, 'exit').mockImplementation(((
        code?: number
      ) => {
        throw new Error(`exit ${code}`);
      }) as never);
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(cleanupCommand({ workflowId })).rejects.toThrow('exit 1');
      expect(exit).toHaveBeenCalledWith(1);
      expect(errors.mock.calls.flat().join('\n')).toContain(
        'Invalid workflow ID'
      );
      expect(ScriptCleanup).not.toHaveBeenCalled();
    }
  );
});
