/**
 * Tests for Config utilities
 * Validates environment and file-based configuration loading
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { validateEnv, loadPipelineConfig, loadAgentsConfig } from '../../src/utils/config.js';
import * as fs from 'fs';

// Mock fs module
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

// Mock settings module to isolate config tests
vi.mock('../../src/utils/settings.js', () => ({
  loadSettings: vi.fn(() => ({
    _source: 'default',
    _sourceFile: '/mock/config/default/settings.json',
    resolvedPaths: {
      agents_md: '/mock/config/default/AGENTS.md',
      pipelines_yaml: '/mock/config/default/pipelines.yaml',
    },
    default_fidelity: 'standard',
    default_backend: 'claude-code',
  })),
  getDefaultAgentsMd: vi.fn(() => '# Default Agents Configuration'),
  getDefaultPipelinesYaml: vi.fn(() => `pipelines:
  standard:
    name: standard
    stages:
      - name: test
        agent: orchestrator`),
}));

describe('Config Utils', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('validateEnv', () => {
    it('should validate environment with all optional keys present', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
      process.env.OPENAI_API_KEY = 'sk-openai-test';
      process.env.GOOGLE_API_KEY = 'google-test';
      process.env.CURSOR_API_KEY = 'cursor-test';
      process.env.DEBUG = 'true';

      const result = validateEnv();

      expect(result.ANTHROPIC_API_KEY).toBe('sk-ant-test');
      expect(result.OPENAI_API_KEY).toBe('sk-openai-test');
      expect(result.GOOGLE_API_KEY).toBe('google-test');
      expect(result.CURSOR_API_KEY).toBe('cursor-test');
      expect(result.DEBUG).toBe('true');
    });

    it('should validate environment with no optional keys', () => {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.GOOGLE_API_KEY;
      delete process.env.CURSOR_API_KEY;
      delete process.env.DEBUG;

      const result = validateEnv();

      expect(result.ANTHROPIC_API_KEY).toBeUndefined();
      expect(result.OPENAI_API_KEY).toBeUndefined();
    });

    it('should validate with partial environment keys', () => {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
      process.env.GOOGLE_API_KEY = 'google-key';

      const result = validateEnv();

      expect(result.ANTHROPIC_API_KEY).toBeUndefined();
      expect(result.OPENAI_API_KEY).toBeUndefined();
      expect(result.GOOGLE_API_KEY).toBe('google-key');
    });
  });

  describe('loadPipelineConfig', () => {
    it('should return default config when no config files exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = loadPipelineConfig();

      // Should fall back to package default via mocked getDefaultPipelinesYaml
      expect(result).toBeDefined();
      expect(result?.pipelines).toBeDefined();
    });

    it('should load valid pipeline config from explicit path', () => {
      const mockYamlContent = `
pipelines:
  standard:
    name: standard
    description: Test pipeline
    default_fidelity: standard
    stages:
      - name: stage1
        agent: orchestrator
        input: Test input
`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(mockYamlContent);

      const result = loadPipelineConfig('/explicit/path/pipelines.yaml');

      expect(result).toBeDefined();
      expect(result?.pipelines).toBeDefined();
      expect(Object.keys(result?.pipelines || {})).toHaveLength(1);
      expect(result?.pipelines['standard'].name).toBe('standard');
    });

    it('should load pipeline config from custom path', () => {
      const customPath = '/custom/path/pipelines.yaml';
      const mockYamlContent = `
pipelines:
  thin:
    name: thin
    description: Custom
    default_fidelity: fast
    stages:
      - name: stage1
        agent: developer
`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(mockYamlContent);

      const result = loadPipelineConfig(customPath);

      expect(result).toBeDefined();
      expect(result?.pipelines['thin'].name).toBe('thin');
      expect(fs.existsSync).toHaveBeenCalledWith(customPath);
    });

    it('should handle YAML parsing errors', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('invalid: yaml: content:');

      expect(() => loadPipelineConfig('/some/path.yaml')).toThrow();
    });

    it('should handle schema validation errors', () => {
      const invalidYamlContent = `
pipelines:
  - name: test
    description: Test
    # Missing required fields
`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(invalidYamlContent);

      expect(() => loadPipelineConfig('/some/path.yaml')).toThrow(/Invalid pipeline configuration/);
    });

    it('should handle file read errors', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('Permission denied');
      });

      expect(() => loadPipelineConfig('/some/path.yaml')).toThrow(/Failed to load pipeline config/);
    });
  });

  describe('loadAgentsConfig', () => {
    it('should return default agents when no config files exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = loadAgentsConfig();

      // Should fall back to package default via mocked getDefaultAgentsMd
      expect(result).toBe('# Default Agents Configuration');
    });

    it('should load agents config from explicit path', () => {
      const customPath = '/custom/path/AGENTS.md';
      const mockContent = `# Custom Agents\n\nCustom documentation.`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(mockContent);

      const result = loadAgentsConfig(customPath);

      expect(result).toBe(mockContent);
      expect(fs.existsSync).toHaveBeenCalledWith(customPath);
      expect(fs.readFileSync).toHaveBeenCalledWith(customPath, 'utf-8');
    });

    it('should handle empty agents config file', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('');

      const result = loadAgentsConfig('/some/path/AGENTS.md');

      expect(result).toBe('');
    });

    it('should handle multi-line markdown content', () => {
      const mockContent = `# Agents Configuration

## Orchestrator
- Plans workflow
- Delegates tasks

## Developer
- Implements features
- Writes code`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(mockContent);

      const result = loadAgentsConfig('/some/path/AGENTS.md');

      expect(result).toBe(mockContent);
      expect(result).toContain('Orchestrator');
      expect(result).toContain('Developer');
    });
  });
});
