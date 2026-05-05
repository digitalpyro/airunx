/**
 * Tests for Git Worktree Manager
 * Validates git worktree operations with mocked child_process
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  GitWorktreeManager,
  MainBranchError,
  GIT_OPERATION_TIMEOUT,
  GIT_MAX_BUFFER,
} from '../../src/tools/git-worktree.js';
import { execFile } from 'child_process';
import { existsSync } from 'fs';

// Mock child_process
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

// Mock fs
vi.mock('fs', () => ({
  existsSync: vi.fn(),
}));

// Mock crypto for deterministic IDs
vi.mock('crypto', () => ({
  randomBytes: vi.fn(() => ({
    toString: () => 'abc123def456',
  })),
}));

describe('Git Worktree Manager', () => {
  let manager: GitWorktreeManager;
  let mockExecFile: any;
  let mockExistsSync: any;

  beforeEach(() => {
    manager = new GitWorktreeManager('/test/repo');
    mockExecFile = vi.mocked(execFile);
    mockExistsSync = vi.mocked(existsSync);
    vi.clearAllMocks();
  });

  describe('isGitRepo', () => {
    it('should return true when directory is a git repository', async () => {
      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        callback(null, { stdout: '.git\n', stderr: '' });
      });

      const result = await manager.isGitRepo();

      expect(result).toBe(true);
      expect(mockExecFile).toHaveBeenCalledWith(
        'git',
        ['rev-parse', '--git-dir'],
        { cwd: '/test/repo', timeout: GIT_OPERATION_TIMEOUT },
        expect.any(Function)
      );
    });

    it('should return false when directory is not a git repository', async () => {
      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        callback(new Error('not a git repository'), { stdout: '', stderr: '' });
      });

      const result = await manager.isGitRepo();

      expect(result).toBe(false);
    });
  });

  describe('getMainBranch', () => {
    it('should return branch from remote HEAD', async () => {
      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        if (args[0] === 'symbolic-ref') {
          callback(null, { stdout: 'refs/remotes/origin/main\n', stderr: '' });
        } else if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'main') {
          callback(null, { stdout: 'abc123\n', stderr: '' });
        }
      });

      const result = await manager.getMainBranch();

      expect(result).toBe('main');
    });

    it('should fallback to main branch when remote HEAD fails', async () => {
      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        if (args[0] === 'symbolic-ref') {
          callback(new Error('no remote HEAD'), { stdout: '', stderr: '' });
        } else if (args[0] === 'rev-parse' && args[2] === 'main') {
          callback(null, { stdout: 'abc123\n', stderr: '' });
        }
      });

      const result = await manager.getMainBranch();

      expect(result).toBe('main');
    });

    it('should fallback to master branch when main does not exist', async () => {
      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        if (args[0] === 'symbolic-ref') {
          callback(new Error('no remote HEAD'), { stdout: '', stderr: '' });
        } else if (args[0] === 'rev-parse' && args[2] === 'main') {
          callback(new Error('branch not found'), { stdout: '', stderr: '' });
        } else if (args[0] === 'rev-parse' && args[2] === 'origin/main') {
          callback(new Error('branch not found'), { stdout: '', stderr: '' });
        } else if (args[0] === 'rev-parse' && args[2] === 'master') {
          callback(null, { stdout: 'def456\n', stderr: '' });
        }
      });

      const result = await manager.getMainBranch();

      expect(result).toBe('master');
    });

    it('should fallback to develop branch when main and master do not exist', async () => {
      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        if (args[0] === 'symbolic-ref') {
          callback(new Error('no remote HEAD'), { stdout: '', stderr: '' });
        } else if (args[0] === 'rev-parse' && args[2] === 'main') {
          callback(new Error('branch not found'), { stdout: '', stderr: '' });
        } else if (args[0] === 'rev-parse' && args[2] === 'origin/main') {
          callback(new Error('branch not found'), { stdout: '', stderr: '' });
        } else if (args[0] === 'rev-parse' && args[2] === 'master') {
          callback(new Error('branch not found'), { stdout: '', stderr: '' });
        } else if (args[0] === 'rev-parse' && args[2] === 'origin/master') {
          callback(new Error('branch not found'), { stdout: '', stderr: '' });
        } else if (args[0] === 'rev-parse' && args[2] === 'develop') {
          callback(null, { stdout: 'ghi789\n', stderr: '' });
        }
      });

      const result = await manager.getMainBranch();

      expect(result).toBe('develop');
    });

    it('should throw MainBranchError when no standard branch exists', async () => {
      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        if (args[0] === 'symbolic-ref') {
          callback(new Error('no remote HEAD'), { stdout: '', stderr: '' });
        } else if (args[0] === 'rev-parse') {
          callback(new Error('branch not found'), { stdout: '', stderr: '' });
        }
      });

      await expect(manager.getMainBranch()).rejects.toThrow(MainBranchError);
      await expect(manager.getMainBranch()).rejects.toThrow(
        'Could not determine main branch (checked main, master, develop)'
      );
    });

    it('should return branch from remote HEAD when only remote tracking ref exists', async () => {
      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        if (args[0] === 'symbolic-ref') {
          callback(null, { stdout: 'refs/remotes/origin/main\n', stderr: '' });
        } else if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'main') {
          // Local branch does not exist
          callback(new Error('branch not found'), { stdout: '', stderr: '' });
        } else if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'origin/main') {
          // Remote tracking ref exists
          callback(null, { stdout: 'abc123\n', stderr: '' });
        }
      });

      const result = await manager.getMainBranch();

      expect(result).toBe('main');
    });

    it('should handle remote HEAD with master branch', async () => {
      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        if (args[0] === 'symbolic-ref') {
          callback(null, { stdout: 'refs/remotes/origin/master\n', stderr: '' });
        } else if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'master') {
          callback(null, { stdout: 'def456\n', stderr: '' });
        }
      });

      const result = await manager.getMainBranch();

      expect(result).toBe('master');
    });

    it('should use configured base branch when set and valid', async () => {
      const managerWithConfig = new GitWorktreeManager('/test/repo', 'custom-branch');
      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        // Verify the custom branch exists
        if (args[0] === 'rev-parse' && args[2] === 'custom-branch') {
          callback(null, { stdout: 'abc123\n', stderr: '' });
        }
      });

      const result = await managerWithConfig.getMainBranch();

      expect(result).toBe('custom-branch');
    });

    it('should fallback to auto-detection when configured branch does not exist', async () => {
      const managerWithConfig = new GitWorktreeManager('/test/repo', 'nonexistent-branch');
      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        // Configured branch doesn't exist
        if (args[0] === 'rev-parse' && args[2] === 'nonexistent-branch') {
          callback(new Error('branch not found'), { stdout: '', stderr: '' });
        }
        // Fall back to remote HEAD
        else if (args[0] === 'symbolic-ref') {
          callback(null, { stdout: 'refs/remotes/origin/main\n', stderr: '' });
        }
        // Verify remote HEAD branch exists locally
        else if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'main') {
          callback(null, { stdout: 'abc123\n', stderr: '' });
        }
      });

      const result = await managerWithConfig.getMainBranch();

      expect(result).toBe('main');
    });

    it('should use setConfiguredBaseBranch to update the configured branch', async () => {
      manager.setConfiguredBaseBranch('set-branch');
      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        if (args[0] === 'rev-parse' && args[2] === 'set-branch') {
          callback(null, { stdout: 'abc123\n', stderr: '' });
        }
      });

      const result = await manager.getMainBranch();

      expect(result).toBe('set-branch');
    });

    it('should not use configured branch when set to null', async () => {
      const managerWithNull = new GitWorktreeManager('/test/repo', null);
      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        if (args[0] === 'symbolic-ref') {
          callback(null, { stdout: 'refs/remotes/origin/main\n', stderr: '' });
        } else if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'main') {
          callback(null, { stdout: 'abc123\n', stderr: '' });
        }
      });

      const result = await managerWithNull.getMainBranch();

      expect(result).toBe('main');
    });
  });

  describe('createWorktree', () => {
    beforeEach(() => {
      // Mock isGitRepo to return true
      // Note: fetch is now handled by syncBranch, not createWorktree
      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        if (args[0] === 'rev-parse' && args[1] === '--git-dir') {
          callback(null, { stdout: '.git\n', stderr: '' });
        } else if (args[0] === 'symbolic-ref') {
          callback(null, { stdout: 'refs/remotes/origin/main\n', stderr: '' });
        } else if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'main') {
          callback(null, { stdout: 'abc123\n', stderr: '' });
        } else if (args[0] === 'worktree') {
          callback(null, { stdout: '', stderr: '' });
        }
      });
    });

    it('should create worktree with default settings', async () => {
      const result = await manager.createWorktree();

      expect(result).toEqual({
        path: '/test/repo/.worktrees/airunx-feature-abc123def456',
        branch: 'airunx-feature-abc123def456',
        id: 'airunx-feature-abc123def456',
      });

      expect(mockExecFile).toHaveBeenCalledWith(
        'git',
        ['worktree', 'add', '-b', 'airunx-feature-abc123def456', '/test/repo/.worktrees/airunx-feature-abc123def456', 'main'],
        { cwd: '/test/repo', timeout: GIT_OPERATION_TIMEOUT, maxBuffer: GIT_MAX_BUFFER },
        expect.any(Function)
      );
    });

    it('should create worktree with custom branch name', async () => {
      const result = await manager.createWorktree({
        branchName: 'custom-branch',
      });

      expect(result.branch).toBe('custom-branch');
    });

    it('should create worktree with issue number', async () => {
      const result = await manager.createWorktree({
        issueNumber: 123,
      });

      expect(result.branch).toBe('airunx-issue-123-abc123def456');
    });

    it('should create worktree with custom base branch', async () => {
      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        if (args[0] === 'rev-parse' && args[1] === '--git-dir') {
          callback(null, { stdout: '.git\n', stderr: '' });
        } else if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'develop') {
          callback(null, { stdout: 'abc123\n', stderr: '' });
        } else if (args[0] === 'worktree') {
          callback(null, { stdout: '', stderr: '' });
        }
      });

      await manager.createWorktree({
        baseBranch: 'develop',
      });

      expect(mockExecFile).toHaveBeenCalledWith(
        'git',
        ['worktree', 'add', '-b', 'airunx-feature-abc123def456', '/test/repo/.worktrees/airunx-feature-abc123def456', 'develop'],
        { cwd: '/test/repo', timeout: GIT_OPERATION_TIMEOUT, maxBuffer: GIT_MAX_BUFFER },
        expect.any(Function)
      );
    });

    it('should use origin/<branch> as start point when local branch does not exist', async () => {
      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        if (args[0] === 'rev-parse' && args[1] === '--git-dir') {
          callback(null, { stdout: '.git\n', stderr: '' });
        } else if (args[0] === 'symbolic-ref') {
          callback(null, { stdout: 'refs/remotes/origin/main\n', stderr: '' });
        } else if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'main') {
          // Local branch does not exist
          callback(new Error('branch not found'), { stdout: '', stderr: '' });
        } else if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'origin/main') {
          // Remote tracking ref exists
          callback(null, { stdout: 'abc123\n', stderr: '' });
        } else if (args[0] === 'worktree') {
          callback(null, { stdout: '', stderr: '' });
        }
      });

      await manager.createWorktree();

      expect(mockExecFile).toHaveBeenCalledWith(
        'git',
        ['worktree', 'add', '-b', 'airunx-feature-abc123def456', '/test/repo/.worktrees/airunx-feature-abc123def456', 'origin/main'],
        { cwd: '/test/repo', timeout: GIT_OPERATION_TIMEOUT, maxBuffer: GIT_MAX_BUFFER },
        expect.any(Function)
      );
    });

    it('should throw error when not a git repository', async () => {
      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        if (args[0] === 'rev-parse' && args[1] === '--git-dir') {
          callback(new Error('not a git repository'), { stdout: '', stderr: '' });
        }
      });

      await expect(manager.createWorktree()).rejects.toThrow(/Not a git repository:/);
    });

    it('should throw descriptive error when worktree creation fails', async () => {
      const gitError = new Error('branch already exists');
      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        if (args[0] === 'rev-parse' && args[1] === '--git-dir') {
          callback(null, { stdout: '.git\n', stderr: '' });
        } else if (args[0] === 'symbolic-ref') {
          callback(null, { stdout: 'refs/remotes/origin/main\n', stderr: '' });
        } else if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'main') {
          callback(null, { stdout: 'abc123\n', stderr: '' });
        } else if (args[0] === 'worktree') {
          callback(gitError, { stdout: '', stderr: '' });
        }
      });

      await expect(manager.createWorktree()).rejects.toThrow(
        /Failed to create worktree.*branch already exists/
      );
    });

    it('should include troubleshooting guidance in worktree creation error', async () => {
      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        if (args[0] === 'rev-parse' && args[1] === '--git-dir') {
          callback(null, { stdout: '.git\n', stderr: '' });
        } else if (args[0] === 'symbolic-ref') {
          callback(null, { stdout: 'refs/remotes/origin/main\n', stderr: '' });
        } else if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'main') {
          callback(null, { stdout: 'abc123\n', stderr: '' });
        } else if (args[0] === 'worktree') {
          callback(new Error('lock held'), { stdout: '', stderr: '' });
        }
      });

      await expect(manager.createWorktree()).rejects.toThrow(
        /Ensure git is not locked by another process/
      );
    });

    it('should handle non-Error exceptions in worktree creation', async () => {
      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        if (args[0] === 'rev-parse' && args[1] === '--git-dir') {
          callback(null, { stdout: '.git\n', stderr: '' });
        } else if (args[0] === 'symbolic-ref') {
          callback(null, { stdout: 'refs/remotes/origin/main\n', stderr: '' });
        } else if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'main') {
          callback(null, { stdout: 'abc123\n', stderr: '' });
        } else if (args[0] === 'worktree') {
          // Simulate a non-Error exception (string throw)
          callback('unexpected string error', { stdout: '', stderr: '' });
        }
      });

      await expect(manager.createWorktree()).rejects.toThrow(
        /Failed to create worktree.*unexpected string error/
      );
    });

    it('should pass timeout option to git worktree add', async () => {
      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        if (args[0] === 'rev-parse' && args[1] === '--git-dir') {
          callback(null, { stdout: '.git\n', stderr: '' });
        } else if (args[0] === 'symbolic-ref') {
          callback(null, { stdout: 'refs/remotes/origin/main\n', stderr: '' });
        } else if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'main') {
          callback(null, { stdout: 'abc123\n', stderr: '' });
        } else if (args[0] === 'worktree') {
          // Verify timeout is in the options
          expect(opts.timeout).toBe(GIT_OPERATION_TIMEOUT);
          callback(null, { stdout: '', stderr: '' });
        }
      });

      await manager.createWorktree();
    });
  });

  describe('listWorktrees', () => {
    it('should parse worktree list output', async () => {
      const output = `worktree /test/repo
HEAD abc123
branch refs/heads/main

worktree /test/repo/.worktrees/airunx-feature-xyz789
HEAD def456
branch refs/heads/airunx-feature-xyz789

`;

      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        callback(null, { stdout: output, stderr: '' });
      });

      const result = await manager.listWorktrees();

      expect(result).toEqual([
        {
          path: '/test/repo',
          hash: 'abc123',
          branch: 'main',
        },
        {
          path: '/test/repo/.worktrees/airunx-feature-xyz789',
          hash: 'def456',
          branch: 'airunx-feature-xyz789',
        },
      ]);
    });

    it('should handle empty worktree list', async () => {
      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        callback(null, { stdout: '', stderr: '' });
      });

      const result = await manager.listWorktrees();

      expect(result).toEqual([]);
    });
  });

  describe('removeWorktree', () => {
    // Helper to mock listWorktrees returning the worktree
    const mockListWorktreesWithPath = (worktreePath: string) => {
      const listOutput = `worktree ${worktreePath}\nHEAD abc123\nbranch refs/heads/airunx-feature-abc123\n`;
      return listOutput;
    };

    it('should remove worktree by path', async () => {
      const worktreePath = '/test/repo/.worktrees/abc123';

      // First call: listWorktrees (git worktree list --porcelain)
      // Second call: git worktree remove
      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        if (args[0] === 'worktree' && args[1] === 'list') {
          callback(null, { stdout: mockListWorktreesWithPath(worktreePath), stderr: '' });
        } else {
          callback(null, { stdout: '', stderr: '' });
        }
      });
      mockExistsSync.mockReturnValue(true);

      await manager.removeWorktree(worktreePath);

      expect(mockExecFile).toHaveBeenCalledWith(
        'git',
        ['worktree', 'remove', worktreePath],
        { cwd: '/test/repo', timeout: GIT_OPERATION_TIMEOUT, maxBuffer: GIT_MAX_BUFFER },
        expect.any(Function)
      );
    });

    it('should remove worktree with force flag', async () => {
      const worktreePath = '/test/repo/.worktrees/abc123';

      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        if (args[0] === 'worktree' && args[1] === 'list') {
          callback(null, { stdout: mockListWorktreesWithPath(worktreePath), stderr: '' });
        } else {
          callback(null, { stdout: '', stderr: '' });
        }
      });
      mockExistsSync.mockReturnValue(true);

      await manager.removeWorktree(worktreePath, true);

      expect(mockExecFile).toHaveBeenCalledWith(
        'git',
        ['worktree', 'remove', '--force', worktreePath],
        { cwd: '/test/repo', timeout: GIT_OPERATION_TIMEOUT, maxBuffer: GIT_MAX_BUFFER },
        expect.any(Function)
      );
    });

    it('should throw error when removal fails with uncommitted changes', async () => {
      const worktreePath = '/test/repo/.worktrees/abc123';

      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        if (args[0] === 'worktree' && args[1] === 'list') {
          callback(null, { stdout: mockListWorktreesWithPath(worktreePath), stderr: '' });
        } else if (args[0] === 'worktree' && args[1] === 'remove') {
          callback(new Error('worktree has uncommitted changes'), { stdout: '', stderr: '' });
        }
      });
      mockExistsSync.mockReturnValue(true);

      await expect(manager.removeWorktree(worktreePath)).rejects.toThrow(
        'uncommitted changes'
      );
    });

    it('should skip removal when worktree not in list (idempotent)', async () => {
      const worktreePath = '/test/repo/.worktrees/nonexistent';

      // listWorktrees returns empty - worktree not registered
      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        if (args[0] === 'worktree' && args[1] === 'list') {
          callback(null, { stdout: '', stderr: '' });
        } else {
          callback(null, { stdout: '', stderr: '' });
        }
      });
      mockExistsSync.mockReturnValue(false);

      // Should not throw - idempotent operation
      await manager.removeWorktree(worktreePath);

      // Should NOT have called git worktree remove
      expect(mockExecFile).not.toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['worktree', 'remove']),
        expect.any(Object),
        expect.any(Function)
      );
    });

    it('should prune when directory missing but git thinks it exists', async () => {
      const worktreePath = '/test/repo/.worktrees/abc123';

      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        if (args[0] === 'worktree' && args[1] === 'list') {
          callback(null, { stdout: mockListWorktreesWithPath(worktreePath), stderr: '' });
        } else if (args[0] === 'worktree' && args[1] === 'prune') {
          callback(null, { stdout: '', stderr: '' });
        }
      });
      // Directory doesn't exist on filesystem
      mockExistsSync.mockReturnValue(false);

      await manager.removeWorktree(worktreePath);

      // Should have called prune instead of remove
      expect(mockExecFile).toHaveBeenCalledWith(
        'git',
        ['worktree', 'prune'],
        { cwd: '/test/repo', timeout: GIT_OPERATION_TIMEOUT, maxBuffer: GIT_MAX_BUFFER },
        expect.any(Function)
      );
    });
  });

  describe('pruneWorktrees', () => {
    it('should prune stale worktrees', async () => {
      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        callback(null, { stdout: '', stderr: '' });
      });

      await manager.pruneWorktrees();

      expect(mockExecFile).toHaveBeenCalledWith(
        'git',
        ['worktree', 'prune'],
        { cwd: '/test/repo', timeout: GIT_OPERATION_TIMEOUT, maxBuffer: GIT_MAX_BUFFER },
        expect.any(Function)
      );
    });
  });

  describe('getCurrentWorktree', () => {
    it('should return worktree info when in a worktree', async () => {
      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        if (args[0] === 'rev-parse') {
          callback(null, { stdout: '/test/repo/.worktrees/airunx-feature-abc123\n', stderr: '' });
        } else if (args[0] === 'branch') {
          callback(null, { stdout: 'airunx-feature-abc123\n', stderr: '' });
        }
      });

      const result = await manager.getCurrentWorktree();

      expect(result).toEqual({
        path: '/test/repo/.worktrees/airunx-feature-abc123',
        branch: 'airunx-feature-abc123',
        id: 'airunx-feature-abc123',
      });
    });

    it('should return null when not in a worktree', async () => {
      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        if (args[0] === 'rev-parse') {
          callback(null, { stdout: '/test/repo\n', stderr: '' });
        } else if (args[0] === 'branch') {
          callback(null, { stdout: 'main\n', stderr: '' });
        }
      });

      const result = await manager.getCurrentWorktree();

      expect(result).toBeNull();
    });

    it('should return null when branch does not match prefix', async () => {
      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        if (args[0] === 'rev-parse') {
          callback(null, { stdout: '/test/repo/.worktrees/abc123\n', stderr: '' });
        } else if (args[0] === 'branch') {
          callback(null, { stdout: 'feature-branch\n', stderr: '' });
        }
      });

      const result = await manager.getCurrentWorktree();

      expect(result).toBeNull();
    });

    it('should return null on git command failure', async () => {
      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        callback(new Error('not a git repository'), { stdout: '', stderr: '' });
      });

      const result = await manager.getCurrentWorktree();

      expect(result).toBeNull();
    });
  });

  describe('hasChanges', () => {
    it('should return true when worktree has changes', async () => {
      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        callback(null, { stdout: 'M  file.ts\n', stderr: '' });
      });

      const result = await manager.hasChanges('/test/repo/.worktrees/abc123');

      expect(result).toBe(true);
    });

    it('should return false when worktree has no changes', async () => {
      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        callback(null, { stdout: '', stderr: '' });
      });

      const result = await manager.hasChanges('/test/repo/.worktrees/abc123');

      expect(result).toBe(false);
    });

    it('should return false on git command failure', async () => {
      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        callback(new Error('not a git repository'), { stdout: '', stderr: '' });
      });

      const result = await manager.hasChanges('/test/repo/.worktrees/abc123');

      expect(result).toBe(false);
    });
  });

  describe('Constructor', () => {
    it('should use provided base path', () => {
      const customManager = new GitWorktreeManager('/custom/path');
      expect(customManager).toBeDefined();
    });

    it('should use process.cwd() when no path provided', () => {
      const defaultManager = new GitWorktreeManager();
      expect(defaultManager).toBeDefined();
    });
  });

  describe('MainBranchError', () => {
    it('should be an instance of Error', () => {
      const error = new MainBranchError('test message');
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('MainBranchError');
      expect(error.message).toBe('test message');
    });
  });

  describe('fetch', () => {
    it('should fetch from origin', async () => {
      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        callback(null, { stdout: '', stderr: '' });
      });

      await manager.fetch();

      expect(mockExecFile).toHaveBeenCalledWith(
        'git',
        ['fetch', 'origin'],
        { cwd: '/test/repo', timeout: GIT_OPERATION_TIMEOUT, maxBuffer: GIT_MAX_BUFFER },
        expect.any(Function)
      );
    });

    it('should throw on network failure', async () => {
      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        callback(new Error('network error'), { stdout: '', stderr: '' });
      });

      await expect(manager.fetch()).rejects.toThrow('network error');
    });
  });

  describe('getBranchDivergence', () => {
    it('should return ahead/behind counts when branch diverged', async () => {
      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        if (args[0] === 'rev-parse' && args[2] === 'main') {
          callback(null, { stdout: 'abc123\n', stderr: '' });
        } else if (args[0] === 'rev-parse' && args[2] === 'origin/main') {
          callback(null, { stdout: 'def456\n', stderr: '' });
        } else if (args[0] === 'rev-list') {
          callback(null, { stdout: '2\t3\n', stderr: '' });
        }
      });

      const result = await manager.getBranchDivergence('main');

      expect(result).toEqual({ ahead: 2, behind: 3 });
    });

    it('should throw when local branch does not exist', async () => {
      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        if (args[0] === 'rev-parse' && args[2] === 'nonexistent') {
          callback(new Error('branch not found'), { stdout: '', stderr: '' });
        }
      });

      await expect(manager.getBranchDivergence('nonexistent')).rejects.toThrow(
        'Cannot get divergence for non-existent local branch: nonexistent'
      );
    });

    it('should return zeros when remote branch does not exist', async () => {
      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        if (args[0] === 'rev-parse' && args[2] === 'feature') {
          callback(null, { stdout: 'abc123\n', stderr: '' });
        } else if (args[0] === 'rev-parse' && args[2] === 'origin/feature') {
          callback(new Error('remote branch not found'), { stdout: '', stderr: '' });
        }
      });

      const result = await manager.getBranchDivergence('feature');

      expect(result).toEqual({ ahead: 0, behind: 0 });
    });

    it('should throw on rev-list failure', async () => {
      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        if (args[0] === 'rev-parse') {
          callback(null, { stdout: 'abc123\n', stderr: '' });
        } else if (args[0] === 'rev-list') {
          callback(new Error('git error'), { stdout: '', stderr: '' });
        }
      });

      await expect(manager.getBranchDivergence('main')).rejects.toThrow(
        'Failed to get branch divergence for main: git error'
      );
    });
  });

  describe('fastForwardBranch', () => {
    it('should fast-forward branch using combined rev-parse and atomic update-ref', async () => {
      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        // Combined rev-parse call returns both refs
        if (args[0] === 'rev-parse' && args[1] === 'main' && args[2] === 'origin/main') {
          callback(null, { stdout: 'local123\nremote456\n', stderr: '' });
        } else if (args[0] === 'update-ref') {
          callback(null, { stdout: '', stderr: '' });
        }
      });

      await manager.fastForwardBranch('main');

      // Should use combined rev-parse for efficiency
      expect(mockExecFile).toHaveBeenCalledWith(
        'git',
        ['rev-parse', 'main', 'origin/main'],
        { cwd: '/test/repo', timeout: GIT_OPERATION_TIMEOUT },
        expect.any(Function)
      );

      // Should use atomic update-ref with oldvalue to prevent race conditions
      expect(mockExecFile).toHaveBeenCalledWith(
        'git',
        ['update-ref', 'refs/heads/main', 'remote456', 'local123'],
        { cwd: '/test/repo', timeout: GIT_OPERATION_TIMEOUT, maxBuffer: GIT_MAX_BUFFER },
        expect.any(Function)
      );
    });

    it('should throw when rev-parse fails', async () => {
      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        if (args[0] === 'rev-parse') {
          callback(new Error('ref not found'), { stdout: '', stderr: '' });
        }
      });

      await expect(manager.fastForwardBranch('main')).rejects.toThrow(
        'ref not found'
      );
    });

    it('should throw when rev-parse returns incomplete output', async () => {
      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        if (args[0] === 'rev-parse') {
          // Only returns one ref instead of two
          callback(null, { stdout: 'local123\n', stderr: '' });
        }
      });

      await expect(manager.fastForwardBranch('main')).rejects.toThrow(
        'Could not parse refs'
      );
    });
  });

  describe('syncBranch', () => {
    // Helper to handle the git config call that getRemoteForBranch makes
    const handleConfigCall = (args: string[], callback: any) => {
      if (args[0] === 'config' && args[1] === '--get') {
        // Default: no configured remote, fall back to 'origin'
        callback(new Error('not set'), { stdout: '', stderr: '' });
        return true;
      }
      return false;
    };

    it('should return already up to date when no commits behind', async () => {
      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        if (handleConfigCall(args, callback)) return;
        if (args[0] === 'fetch') {
          callback(null, { stdout: '', stderr: '' });
        } else if (args[0] === 'rev-parse') {
          callback(null, { stdout: 'abc123\n', stderr: '' });
        } else if (args[0] === 'rev-list') {
          // 0 ahead, 0 behind
          callback(null, { stdout: '0\t0\n', stderr: '' });
        }
      });

      const result = await manager.syncBranch({ branch: 'main' });

      expect(result).toEqual({
        synced: true,
        commitsBehind: 0,
        message: 'Already up to date',
      });
    });

    it('should fast-forward when behind remote', async () => {
      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        if (handleConfigCall(args, callback)) return;
        if (args[0] === 'fetch') {
          callback(null, { stdout: '', stderr: '' });
        } else if (args[0] === 'rev-parse' && args.length === 3 && args[1] !== '--verify') {
          // Combined rev-parse for fastForwardBranch
          callback(null, { stdout: 'local123\nremote456\n', stderr: '' });
        } else if (args[0] === 'rev-parse') {
          // branchExists checks
          callback(null, { stdout: 'abc123\n', stderr: '' });
        } else if (args[0] === 'rev-list') {
          // 0 ahead, 5 behind
          callback(null, { stdout: '0\t5\n', stderr: '' });
        } else if (args[0] === 'update-ref') {
          callback(null, { stdout: '', stderr: '' });
        }
      });

      const result = await manager.syncBranch({ branch: 'main' });

      expect(result).toEqual({
        synced: true,
        commitsBehind: 5,
        message: 'Synced 5 commit(s) from origin',
      });
    });

    it('should warn when branch has diverged (ahead and behind)', async () => {
      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        if (handleConfigCall(args, callback)) return;
        if (args[0] === 'fetch') {
          callback(null, { stdout: '', stderr: '' });
        } else if (args[0] === 'rev-parse') {
          callback(null, { stdout: 'abc123\n', stderr: '' });
        } else if (args[0] === 'rev-list') {
          // 2 ahead, 3 behind - diverged
          callback(null, { stdout: '2\t3\n', stderr: '' });
        }
      });

      const result = await manager.syncBranch({ branch: 'main' });

      expect(result).toEqual({
        synced: false,
        message: expect.stringContaining('has diverged'),
      });
      expect(result.message).toContain('2 ahead');
      expect(result.message).toContain('3 behind');
    });

    it('should handle fetch failure gracefully', async () => {
      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        if (handleConfigCall(args, callback)) return;
        if (args[0] === 'fetch') {
          callback(new Error('network error'), { stdout: '', stderr: '' });
        }
      });

      const result = await manager.syncBranch({ branch: 'main' });

      expect(result).toEqual({
        synced: false,
        message: expect.stringContaining('Failed to fetch'),
      });
    });

    it('should handle fast-forward failure gracefully', async () => {
      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        if (handleConfigCall(args, callback)) return;
        if (args[0] === 'fetch') {
          callback(null, { stdout: '', stderr: '' });
        } else if (args[0] === 'rev-parse' && args.length === 3 && args[1] !== '--verify') {
          // Combined rev-parse for fastForwardBranch
          callback(null, { stdout: 'local123\nremote456\n', stderr: '' });
        } else if (args[0] === 'rev-parse') {
          callback(null, { stdout: 'abc123\n', stderr: '' });
        } else if (args[0] === 'rev-list') {
          callback(null, { stdout: '0\t5\n', stderr: '' });
        } else if (args[0] === 'update-ref') {
          callback(new Error('update-ref failed'), { stdout: '', stderr: '' });
        }
      });

      const result = await manager.syncBranch({ branch: 'main' });

      expect(result).toEqual({
        synced: false,
        message: expect.stringContaining('Failed to fast-forward'),
      });
    });

    it('should throw when divergence check fails', async () => {
      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        if (handleConfigCall(args, callback)) return;
        if (args[0] === 'fetch') {
          callback(null, { stdout: '', stderr: '' });
        } else if (args[0] === 'rev-parse') {
          callback(null, { stdout: 'abc123\n', stderr: '' });
        } else if (args[0] === 'rev-list') {
          callback(new Error('rev-list failed'), { stdout: '', stderr: '' });
        }
      });

      await expect(manager.syncBranch({ branch: 'main' })).rejects.toThrow(
        'Failed to get branch divergence for main: rev-list failed'
      );
    });

    it('should create local tracking branch when branch exists only on remote', async () => {
      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        if (handleConfigCall(args, callback)) return;
        if (args[0] === 'fetch') {
          callback(null, { stdout: '', stderr: '' });
        } else if (args[0] === 'rev-parse' && args[2] === 'feature-branch') {
          // Local branch doesn't exist
          callback(new Error('not found'), { stdout: '', stderr: '' });
        } else if (
          args[0] === 'rev-parse' &&
          args[2] === 'origin/feature-branch'
        ) {
          // Remote branch exists
          callback(null, { stdout: 'abc123\n', stderr: '' });
        } else if (args[0] === 'branch' && args[1] === '--track') {
          // Create tracking branch
          callback(null, { stdout: '', stderr: '' });
        }
      });

      const result = await manager.syncBranch({ branch: 'feature-branch' });

      expect(result).toEqual({
        synced: true,
        commitsBehind: 0,
        message: "Created local branch 'feature-branch' from remote",
      });
    });

    it('should throw when creating local tracking branch fails', async () => {
      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        if (handleConfigCall(args, callback)) return;
        if (args[0] === 'fetch') {
          callback(null, { stdout: '', stderr: '' });
        } else if (args[0] === 'rev-parse' && args[2] === 'feature-branch') {
          // Local branch doesn't exist
          callback(new Error('not found'), { stdout: '', stderr: '' });
        } else if (
          args[0] === 'rev-parse' &&
          args[2] === 'origin/feature-branch'
        ) {
          // Remote branch exists
          callback(null, { stdout: 'abc123\n', stderr: '' });
        } else if (args[0] === 'branch' && args[1] === '--track') {
          // Creating tracking branch fails
          callback(new Error('permission denied'), { stdout: '', stderr: '' });
        }
      });

      await expect(
        manager.syncBranch({ branch: 'feature-branch' })
      ).rejects.toThrow(
        "Failed to create local branch 'feature-branch' from remote: permission denied"
      );
    });

    it('should return success for local-only branch', async () => {
      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        if (handleConfigCall(args, callback)) return;
        if (args[0] === 'fetch') {
          callback(null, { stdout: '', stderr: '' });
        } else if (args[0] === 'rev-parse' && args[2] === 'local-only') {
          // Local branch exists
          callback(null, { stdout: 'abc123\n', stderr: '' });
        } else if (
          args[0] === 'rev-parse' &&
          args[2] === 'origin/local-only'
        ) {
          // Remote branch doesn't exist
          callback(new Error('not found'), { stdout: '', stderr: '' });
        }
      });

      const result = await manager.syncBranch({ branch: 'local-only' });

      expect(result).toEqual({
        synced: true,
        message: "Local-only branch 'local-only', nothing to sync",
      });
    });

    it('should throw when branch not found anywhere', async () => {
      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        if (handleConfigCall(args, callback)) return;
        if (args[0] === 'fetch') {
          callback(null, { stdout: '', stderr: '' });
        } else if (args[0] === 'rev-parse') {
          // Neither local nor remote branch exists
          callback(new Error('not found'), { stdout: '', stderr: '' });
        }
      });

      await expect(manager.syncBranch({ branch: 'nonexistent' })).rejects.toThrow(
        "Branch 'nonexistent' not found locally or on remote 'origin'"
      );
    });

    it('should use configured remote instead of origin', async () => {
      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        // Return 'upstream' as the configured remote for main branch
        if (args[0] === 'config' && args[1] === '--get') {
          callback(null, { stdout: 'upstream\n', stderr: '' });
        } else if (args[0] === 'fetch') {
          callback(null, { stdout: '', stderr: '' });
        } else if (args[0] === 'rev-parse' && args.length === 3 && args[1] !== '--verify') {
          // Combined rev-parse for fastForwardBranch (main, upstream/main)
          callback(null, { stdout: 'local123\nremote456\n', stderr: '' });
        } else if (args[0] === 'rev-parse') {
          // branchExists checks
          const branchArg = args[2] || args[1];
          if (branchArg === 'main' || branchArg === 'upstream/main') {
            callback(null, { stdout: 'abc123\n', stderr: '' });
          } else {
            callback(new Error('not found'), { stdout: '', stderr: '' });
          }
        } else if (args[0] === 'rev-list') {
          // 0 ahead, 3 behind
          callback(null, { stdout: '0\t3\n', stderr: '' });
        } else if (args[0] === 'update-ref') {
          callback(null, { stdout: '', stderr: '' });
        }
      });

      const result = await manager.syncBranch({ branch: 'main' });

      expect(result).toEqual({
        synced: true,
        commitsBehind: 3,
        message: 'Synced 3 commit(s) from upstream',
      });

      // Verify fetch was called with 'upstream' not 'origin'
      expect(mockExecFile).toHaveBeenCalledWith(
        'git',
        ['fetch', 'upstream'],
        expect.any(Object),
        expect.any(Function)
      );
    });

    it('should include remote name in not found error message', async () => {
      mockExecFile.mockImplementation((cmd, args, opts, callback: any) => {
        // Return 'upstream' as the configured remote
        if (args[0] === 'config' && args[1] === '--get') {
          callback(null, { stdout: 'upstream\n', stderr: '' });
          return;
        }
        if (args[0] === 'fetch') {
          callback(null, { stdout: '', stderr: '' });
        } else if (args[0] === 'rev-parse') {
          // Neither local nor remote branch exists
          callback(new Error('not found'), { stdout: '', stderr: '' });
        }
      });

      await expect(manager.syncBranch({ branch: 'nonexistent' })).rejects.toThrow(
        "Branch 'nonexistent' not found locally or on remote 'upstream'"
      );
    });
  });
});
