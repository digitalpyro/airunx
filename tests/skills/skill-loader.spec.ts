/**
 * Tests for skills loader
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';

// Mock fs and os modules
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock('os', () => ({
  homedir: vi.fn(() => '/mock/home'),
}));

// Import after mocks
import {
  loadSkills,
  clearSkillsCache,
  getProjectSkillsDir,
  getGlobalSkillsDir,
} from '../../src/skills/skill-loader.js';

describe('skill-loader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSkillsCache();
    // Default: no directories exist
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readdirSync).mockReturnValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
    clearSkillsCache();
  });

  describe('getProjectSkillsDir', () => {
    it('should return .airunx/skills in cwd by default', () => {
      const dir = getProjectSkillsDir();
      expect(dir).toContain('.airunx/skills');
    });

    it('should use custom project directory', () => {
      const dir = getProjectSkillsDir('/custom/project');
      expect(dir).toBe('/custom/project/.airunx/skills');
    });
  });

  describe('getGlobalSkillsDir', () => {
    it('should return ~/.airunx/skills', () => {
      const dir = getGlobalSkillsDir();
      expect(dir).toBe('/mock/home/.airunx/skills');
    });
  });

  describe('loadSkills', () => {
    it('should return empty registry when no skills directories exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const registry = loadSkills();

      expect(registry.getAll()).toHaveLength(0);
    });

    it('should load skills from project directory', () => {
      const skillContent = `---
name: project-skill
description: A project skill
---

Content`;

      vi.mocked(fs.existsSync).mockImplementation((path) => {
        const pathStr = String(path);
        if (pathStr.endsWith('.airunx/skills')) return true;
        if (pathStr.endsWith('my-skill/SKILL.md')) return true;
        return false;
      });

      vi.mocked(fs.readdirSync).mockImplementation((path) => {
        const pathStr = String(path);
        if (pathStr.endsWith('.airunx/skills')) {
          return [
            { name: 'my-skill', isDirectory: () => true },
          ] as unknown as fs.Dirent[];
        }
        return [];
      });

      vi.mocked(fs.readFileSync).mockReturnValue(skillContent);

      const registry = loadSkills();

      expect(registry.getAll()).toHaveLength(1);
      expect(registry.get('my-skill')).toBeDefined();
      expect(registry.get('my-skill')!.source).toBe('project');
    });

    it('should load skills from global directory', () => {
      const skillContent = `---
name: global-skill
description: A global skill
---

Content`;

      vi.mocked(fs.existsSync).mockImplementation((path) => {
        const pathStr = String(path);
        if (pathStr === '/mock/home/.airunx/skills') return true;
        if (pathStr.includes('/mock/home') && pathStr.endsWith('SKILL.md'))
          return true;
        return false;
      });

      vi.mocked(fs.readdirSync).mockImplementation((path) => {
        const pathStr = String(path);
        if (pathStr === '/mock/home/.airunx/skills') {
          return [
            { name: 'global-skill', isDirectory: () => true },
          ] as unknown as fs.Dirent[];
        }
        return [];
      });

      vi.mocked(fs.readFileSync).mockReturnValue(skillContent);

      const registry = loadSkills();

      expect(registry.getBySource('global')).toHaveLength(1);
    });

    it('should prioritize project skills over global skills with same id', () => {
      const projectContent = `---
name: shared-skill
description: Project version
---

Project content`;

      const globalContent = `---
name: shared-skill
description: Global version
---

Global content`;

      vi.mocked(fs.existsSync).mockReturnValue(true);

      vi.mocked(fs.readdirSync).mockImplementation((path) => {
        const pathStr = String(path);
        if (pathStr.includes('.airunx/skills')) {
          return [
            { name: 'shared-skill', isDirectory: () => true },
          ] as unknown as fs.Dirent[];
        }
        return [];
      });

      vi.mocked(fs.readFileSync).mockImplementation((path) => {
        const pathStr = String(path);
        if (pathStr.includes('/mock/home')) {
          return globalContent;
        }
        return projectContent;
      });

      const registry = loadSkills();

      // Should only have one skill with the shared id
      expect(registry.getAll()).toHaveLength(1);
      // Project version should win
      expect(registry.get('shared-skill')!.description).toBe(
        'Project version'
      );
      expect(registry.get('shared-skill')!.source).toBe('project');
    });

    it('should load skills from @skills namespace in node_modules', () => {
      const skillContent = `---
name: npm-skill
description: An npm skill
---

Content`;

      vi.mocked(fs.existsSync).mockImplementation((path) => {
        const pathStr = String(path);
        if (pathStr.endsWith('node_modules')) return true;
        if (pathStr.endsWith('node_modules/@skills')) return true;
        if (pathStr.includes('@skills/cool-skill/SKILL.md')) return true;
        return false;
      });

      vi.mocked(fs.readdirSync).mockImplementation((path) => {
        const pathStr = String(path);
        if (pathStr.endsWith('node_modules/@skills')) {
          return [
            { name: 'cool-skill', isDirectory: () => true },
          ] as unknown as fs.Dirent[];
        }
        if (pathStr.endsWith('node_modules')) {
          return [];
        }
        return [];
      });

      vi.mocked(fs.readFileSync).mockReturnValue(skillContent);

      const registry = loadSkills();

      expect(registry.getBySource('npm')).toHaveLength(1);
      expect(registry.get('cool-skill')).toBeDefined();
    });

    it('should load skills from package skills/ subdirectories', () => {
      const skillContent = `---
name: pkg-skill
description: From package skills dir
---

Content`;

      vi.mocked(fs.existsSync).mockImplementation((path) => {
        const pathStr = String(path);
        if (pathStr.endsWith('node_modules')) return true;
        if (pathStr.endsWith('some-pkg/skills')) return true;
        if (pathStr.includes('some-pkg/skills/helper/SKILL.md')) return true;
        return false;
      });

      vi.mocked(fs.readdirSync).mockImplementation((path) => {
        const pathStr = String(path);
        if (pathStr.endsWith('node_modules')) {
          return [
            { name: 'some-pkg', isDirectory: () => true },
          ] as unknown as fs.Dirent[];
        }
        if (pathStr.endsWith('some-pkg/skills')) {
          return [
            { name: 'helper', isDirectory: () => true },
          ] as unknown as fs.Dirent[];
        }
        return [];
      });

      vi.mocked(fs.readFileSync).mockReturnValue(skillContent);

      const registry = loadSkills();

      expect(registry.get('helper')).toBeDefined();
      expect(registry.get('helper')!.source).toBe('npm');
    });

    it('should load skills from scoped package skills/ subdirectories', () => {
      const skillContent = `---
name: scoped-skill
description: From scoped package skills dir
---

Content`;

      vi.mocked(fs.existsSync).mockImplementation((path) => {
        const pathStr = String(path);
        if (pathStr.endsWith('node_modules')) return true;
        if (pathStr.endsWith('@my-org/my-package/skills')) return true;
        if (pathStr.includes('@my-org/my-package/skills/util/SKILL.md'))
          return true;
        return false;
      });

      vi.mocked(fs.readdirSync).mockImplementation((path) => {
        const pathStr = String(path);
        if (pathStr.endsWith('node_modules')) {
          return [
            { name: '@my-org', isDirectory: () => true },
          ] as unknown as fs.Dirent[];
        }
        if (pathStr.endsWith('node_modules/@my-org')) {
          return [
            { name: 'my-package', isDirectory: () => true },
          ] as unknown as fs.Dirent[];
        }
        if (pathStr.endsWith('@my-org/my-package/skills')) {
          return [
            { name: 'util', isDirectory: () => true },
          ] as unknown as fs.Dirent[];
        }
        return [];
      });

      vi.mocked(fs.readFileSync).mockReturnValue(skillContent);

      const registry = loadSkills();

      expect(registry.get('util')).toBeDefined();
      expect(registry.get('util')!.source).toBe('npm');
    });

    it('should cache loaded skills', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const registry1 = loadSkills();
      const registry2 = loadSkills();

      // Same registry instance should be returned
      expect(registry1).toBe(registry2);
    });

    it('should clear cache when clearSkillsCache is called', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const registry1 = loadSkills();
      clearSkillsCache();
      const registry2 = loadSkills();

      // Different registry instances after cache clear
      expect(registry1).not.toBe(registry2);
    });

    it('should skip directories without SKILL.md', () => {
      vi.mocked(fs.existsSync).mockImplementation((path) => {
        const pathStr = String(path);
        if (pathStr.endsWith('.airunx/skills')) return true;
        // no-skill-dir has no SKILL.md
        if (pathStr.includes('no-skill-dir/SKILL.md')) return false;
        return false;
      });

      vi.mocked(fs.readdirSync).mockImplementation((path) => {
        const pathStr = String(path);
        if (pathStr.endsWith('.airunx/skills')) {
          return [
            { name: 'no-skill-dir', isDirectory: () => true },
          ] as unknown as fs.Dirent[];
        }
        return [];
      });

      const registry = loadSkills();

      expect(registry.getAll()).toHaveLength(0);
    });

    it('should skip files (non-directories) in skills folder', () => {
      vi.mocked(fs.existsSync).mockImplementation((path) => {
        const pathStr = String(path);
        return pathStr.endsWith('.airunx/skills');
      });

      vi.mocked(fs.readdirSync).mockImplementation((path) => {
        const pathStr = String(path);
        if (pathStr.endsWith('.airunx/skills')) {
          return [
            { name: 'README.md', isDirectory: () => false },
            { name: '.DS_Store', isDirectory: () => false },
          ] as unknown as fs.Dirent[];
        }
        return [];
      });

      const registry = loadSkills();

      expect(registry.getAll()).toHaveLength(0);
    });
  });

  describe('SkillsRegistry', () => {
    it('should support get method (Map-compatible)', () => {
      const skillContent = `---
name: test
---

Content`;

      vi.mocked(fs.existsSync).mockImplementation((path) => {
        const pathStr = String(path);
        return (
          pathStr.endsWith('.airunx/skills') ||
          pathStr.endsWith('test/SKILL.md')
        );
      });

      vi.mocked(fs.readdirSync).mockImplementation((path) => {
        const pathStr = String(path);
        if (pathStr.endsWith('.airunx/skills')) {
          return [
            { name: 'test', isDirectory: () => true },
          ] as unknown as fs.Dirent[];
        }
        return [];
      });

      vi.mocked(fs.readFileSync).mockReturnValue(skillContent);

      const registry = loadSkills();

      expect(registry.get('test')).toBeDefined();
      expect(registry.get('nonexistent')).toBeUndefined();
    });

    it('should support getAll method', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const registry = loadSkills();

      expect(Array.isArray(registry.getAll())).toBe(true);
    });

    it('should support getBySource method', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const registry = loadSkills();

      expect(registry.getBySource('project')).toHaveLength(0);
      expect(registry.getBySource('global')).toHaveLength(0);
      expect(registry.getBySource('npm')).toHaveLength(0);
    });
  });
});
