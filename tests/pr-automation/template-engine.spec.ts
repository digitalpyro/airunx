import { describe, it, expect, beforeEach } from 'vitest';
import { TemplateEngine } from '../../src/pr-automation/template-engine.js';
import type { WorkflowContext } from '../../src/core/types.js';

// No longer mocking fs - we use the real default template from config/default/

describe('TemplateEngine', () => {
  let templateEngine: TemplateEngine;

  beforeEach(() => {
    templateEngine = new TemplateEngine();
  });

  describe('getDefaultTemplate', () => {
    it('should return a non-empty default template', () => {
      const template = templateEngine.getDefaultTemplate();

      expect(template).toBeTruthy();
      expect(template.length).toBeGreaterThan(0);
      expect(template).toContain('{{taskDescription}}');
      expect(template).toContain('{{fidelityLevel}}');
      expect(template).toContain('{{backend}}');
      expect(template).toContain('{{todos}}');
    });
  });

  describe('render', () => {
    it('should render template with workflow context', async () => {
      const context: WorkflowContext = {
        id: 'test-workflow-123',
        input: 'Add dark mode',
        inputType: 'prompt',
        mode: 'pipeline',
        createdAt: new Date(),
        status: 'completed',
        taskTitle: 'Add dark mode feature',
        taskDescription: 'Implement a dark mode toggle for the application',
        fidelityLevel: 'standard',
        backend: 'claude-code',
        iterationCount: 2,
        maxIterations: 3,
        todos: [
          {
            id: '001',
            title: 'Implement toggle UI',
            status: 'completed',
            priority: 'p1',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          {
            id: '002',
            title: 'Add state management',
            status: 'completed',
            priority: 'p2',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        metrics: {
          tokensUsed: 8500,
          totalTokens: 8500,
          runtimeMs: 12340000,
          totalRuntimeMs: 12340000,
          totalCost: 0.12,
        },
      };

      const rendered = await templateEngine.render(context);

      expect(rendered).toContain('Implement a dark mode toggle for the application');
      expect(rendered).toContain('standard');
      expect(rendered).toContain('claude-code');
      expect(rendered).toContain('2/3');
      expect(rendered).toContain('8,500');
      expect(rendered).toContain('0.12');
      expect(rendered).toContain('[x] Implement toggle UI');
      expect(rendered).toContain('[x] Add state management');
    });

    it('should handle missing optional fields', async () => {
      const context: WorkflowContext = {
        id: 'test-workflow-123',
        input: 'Quick task',
        inputType: 'prompt',
        mode: 'pipeline',
        createdAt: new Date(),
        status: 'completed',
        metrics: {
          tokensUsed: 500,
          runtimeMs: 1000,
          totalTokens: 500,
          totalRuntimeMs: 1000,
          totalCost: 0.01,
        },
      };

      const rendered = await templateEngine.render(context);

      expect(rendered).toBeTruthy();
      expect(rendered).toContain('standard'); // default
      expect(rendered).toContain('claude-code'); // default
      expect(rendered).toContain('_No todos tracked_');
    });

    it('should use taskTitle when taskDescription is missing', async () => {
      const context: WorkflowContext = {
        id: 'test-workflow-123',
        input: 'Fix bug',
        inputType: 'prompt',
        mode: 'pipeline',
        createdAt: new Date(),
        status: 'completed',
        taskTitle: 'Fix authentication bug',
        metrics: {
          tokensUsed: 1000,
          runtimeMs: 5000,
          totalTokens: 1000,
          totalRuntimeMs: 5000,
          totalCost: 0.02,
        },
      };

      const rendered = await templateEngine.render(context);

      expect(rendered).toContain('Fix authentication bug');
    });

    it('should format duration correctly', async () => {
      const context: WorkflowContext = {
        id: 'test-workflow-123',
        input: 'Task',
        inputType: 'prompt',
        mode: 'pipeline',
        createdAt: new Date(),
        status: 'completed',
        taskTitle: 'Task',
        metrics: {
          tokensUsed: 1000,
          runtimeMs: 3661000, // 1 hour, 1 minute, 1 second
          totalRuntimeMs: 3661000,
          totalTokens: 1000,
          totalCost: 0.05,
        },
      };

      const rendered = await templateEngine.render(context);

      expect(rendered).toContain('01:01:01');
    });

    it('should only include completed todos', async () => {
      const context: WorkflowContext = {
        id: 'test-workflow-123',
        input: 'Task',
        inputType: 'prompt',
        mode: 'pipeline',
        createdAt: new Date(),
        status: 'completed',
        taskTitle: 'Task',
        todos: [
          {
            id: '001',
            title: 'Completed task',
            status: 'completed',
            priority: 'p1',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          {
            id: '002',
            title: 'Pending task',
            status: 'pending',
            priority: 'p2',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          {
            id: '003',
            title: 'In progress task',
            status: 'in_progress',
            priority: 'p3',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        metrics: {
          tokensUsed: 1000,
          runtimeMs: 5000,
          totalRuntimeMs: 5000,
          totalTokens: 1000,
          totalCost: 0.02,
        },
      };

      const rendered = await templateEngine.render(context);

      expect(rendered).toContain('[x] Completed task');
      expect(rendered).not.toContain('[x] Pending task');
      expect(rendered).not.toContain('[x] In progress task');
    });
  });

  describe('loadTemplate', () => {
    it('should use default template when no custom template exists', () => {
      // Since we're not using a custom template path, loadTemplate should use the default
      const defaultTemplate = templateEngine.getDefaultTemplate();
      expect(defaultTemplate).toBeTruthy();
      expect(defaultTemplate).toContain('{{taskDescription}}');
    });
  });

  describe('issueUrl', () => {
    it('should prepend Closes link when issueUrl is provided', async () => {
      const context: WorkflowContext = {
        id: 'test-workflow-123',
        input: 'Fix bug',
        inputType: 'github',
        mode: 'pipeline',
        createdAt: new Date(),
        status: 'completed',
        taskTitle: 'Fix authentication bug',
        issueUrl: 'https://github.com/owner/repo/issues/123',
        metrics: {
          tokensUsed: 1000,
          runtimeMs: 5000,
          totalTokens: 1000,
          totalRuntimeMs: 5000,
          totalCost: 0.02,
        },
      };

      const rendered = await templateEngine.render(context);

      expect(rendered).toMatch(/^Closes https:\/\/github\.com\/owner\/repo\/issues\/123\n\n/);
    });

    it('should not include Closes link when issueUrl is not provided', async () => {
      const context: WorkflowContext = {
        id: 'test-workflow-123',
        input: 'Fix bug',
        inputType: 'prompt',
        mode: 'pipeline',
        createdAt: new Date(),
        status: 'completed',
        taskTitle: 'Fix authentication bug',
        metrics: {
          tokensUsed: 1000,
          runtimeMs: 5000,
          totalTokens: 1000,
          totalRuntimeMs: 5000,
          totalCost: 0.02,
        },
      };

      const rendered = await templateEngine.render(context);

      expect(rendered).not.toContain('Closes');
    });
  });

  describe('testPlan', () => {
    const baseContext: WorkflowContext = {
      id: 'test-workflow-123',
      input: 'Fix bug',
      inputType: 'prompt',
      mode: 'pipeline',
      createdAt: new Date(),
      status: 'completed',
      taskTitle: 'Fix authentication bug',
      metrics: {
        tokensUsed: 1000,
        runtime: 5000,
        totalTokens: 1000,
        totalRuntimeMs: 5000,
        totalCost: 0.02,
        stagesCompleted: 0,
        totalStages: 0,
        errors: 0,
      },
    };

    it('should use custom testPlan when provided', async () => {
      const context: WorkflowContext = {
        ...baseContext,
        testPlan: `### Steps to Verify
1. Run the login flow
2. Check that error messages appear correctly
3. Verify token refresh works`,
      };

      const rendered = await templateEngine.render(context);

      expect(rendered).toContain('Steps to Verify');
      expect(rendered).toContain('Run the login flow');
      expect(rendered).toContain('Check that error messages appear correctly');
    });

    it('should fall back to automated tests when testPlan is not provided', async () => {
      const rendered = await templateEngine.render(baseContext);

      expect(rendered).toContain('### Automated Tests');
      expect(rendered).toContain('### Manual Verification');
    });
  });
});
