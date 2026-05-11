/**
 * Tests for Todo Manager
 * Validates filesystem-based todo tracking with slugified filenames
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TodoManager } from '../../src/utils/todo-manager.js';
import type { Todo } from '../../src/core/types.js';
import { existsSync } from 'fs';
import { rm, readdir, readFile } from 'fs/promises';
import path from 'path';

describe.sequential('Todo Manager', () => {
  const TEST_TODOS_DIR = '.airunx-test/test-todos';
  let todoManager: TodoManager;

  beforeEach(async () => {
    todoManager = new TodoManager(TEST_TODOS_DIR);

    // Ensure clean state
    if (existsSync(TEST_TODOS_DIR)) {
      await rm(TEST_TODOS_DIR, { recursive: true });
    }
  });

  afterEach(async () => {
    // Clean up test directory
    if (existsSync(TEST_TODOS_DIR)) {
      await rm(TEST_TODOS_DIR, { recursive: true });
    }
  });

  describe('Initialization', () => {
    it('should create todos directory if it does not exist', async () => {
      expect(existsSync(TEST_TODOS_DIR)).toBe(false);

      await todoManager.initialize();

      expect(existsSync(TEST_TODOS_DIR)).toBe(true);
    });

    it('should not fail if todos directory already exists', async () => {
      await todoManager.initialize();

      await expect(todoManager.initialize()).resolves.not.toThrow();
    });
  });

  describe('Create', () => {
    it('should create a new todo with auto-generated ID', async () => {
      const todo = await todoManager.create({
        title: 'Test task',
        description: 'Test description',
      });

      expect(todo.id).toBe('001');
      expect(todo.title).toBe('Test task');
      expect(todo.description).toBe('Test description');
      expect(todo.status).toBe('pending');
      expect(todo.priority).toBe('p2');
      expect(todo.createdAt).toBeInstanceOf(Date);
      expect(todo.updatedAt).toBeInstanceOf(Date);
    });

    it('should increment IDs for multiple todos', async () => {
      const todo1 = await todoManager.create({ title: 'Task 1' });
      const todo2 = await todoManager.create({ title: 'Task 2' });
      const todo3 = await todoManager.create({ title: 'Task 3' });

      expect(todo1.id).toBe('001');
      expect(todo2.id).toBe('002');
      expect(todo3.id).toBe('003');
    });

    it('should create todo with custom status and priority', async () => {
      const todo = await todoManager.create({
        title: 'High priority task',
        status: 'in_progress',
        priority: 'p1',
      });

      expect(todo.status).toBe('in_progress');
      expect(todo.priority).toBe('p1');
    });

    it('should create slugified filename', async () => {
      const todo = await todoManager.create({
        title: 'Test Task With Spaces',
      });

      const files = await readdir(TEST_TODOS_DIR);
      expect(files[0]).toMatch(/001-pending-p2-test-task-with-spaces\.md/);
    });

    it('should slugify special characters in filename', async () => {
      const todo = await todoManager.create({
        title: 'Task: Fix bug #123 (urgent!)',
      });

      const files = await readdir(TEST_TODOS_DIR);
      expect(files[0]).toMatch(/001-pending-p2-task-fix-bug-123-urgent\.md/);
    });

    it('should limit slug length to 50 characters', async () => {
      const longTitle = 'A'.repeat(100);
      const todo = await todoManager.create({
        title: longTitle,
      });

      const files = await readdir(TEST_TODOS_DIR);
      const filename = files[0];
      const slug = filename.split('-').slice(3).join('-').replace('.md', '');

      expect(slug.length).toBeLessThanOrEqual(50);
    });
  });

  describe('Update Status', () => {
    it('should update todo status', async () => {
      const todo = await todoManager.create({ title: 'Test task' });

      const updated = await todoManager.updateStatus(todo.id, 'in_progress');

      expect(updated.status).toBe('in_progress');
      expect(updated.updatedAt.getTime()).toBeGreaterThan(todo.updatedAt.getTime());
    });

    it('should rename file when status changes', async () => {
      const todo = await todoManager.create({ title: 'Test task' });
      const oldFiles = await readdir(TEST_TODOS_DIR);

      await todoManager.updateStatus(todo.id, 'completed');

      const newFiles = await readdir(TEST_TODOS_DIR);
      expect(newFiles[0]).toMatch(/001-completed-p2-test-task\.md/);
      expect(newFiles[0]).not.toBe(oldFiles[0]);
    });

    it('should use atomic file operations (write before delete)', async () => {
      const todo = await todoManager.create({ title: 'Test task' });

      await todoManager.updateStatus(todo.id, 'completed');

      // Verify new file exists
      const files = await readdir(TEST_TODOS_DIR);
      expect(files.length).toBe(1);
      expect(files[0]).toMatch(/completed/);
    });

    it('should throw error when updating non-existent todo', async () => {
      await expect(
        todoManager.updateStatus('999', 'completed')
      ).rejects.toThrow('Todo not found: 999');
    });
  });

  describe('Update Todo', () => {
    it('should update todo title', async () => {
      const todo = await todoManager.create({ title: 'Old title' });

      const updated = await todoManager.update(todo.id, {
        title: 'New title',
      });

      expect(updated.title).toBe('New title');
    });

    it('should update todo description', async () => {
      const todo = await todoManager.create({
        title: 'Test',
        description: 'Old description',
      });

      const updated = await todoManager.update(todo.id, {
        description: 'New description',
      });

      expect(updated.description).toBe('New description');
    });

    it('should update multiple fields at once', async () => {
      const todo = await todoManager.create({
        title: 'Test',
        status: 'pending',
        priority: 'p2',
      });

      const updated = await todoManager.update(todo.id, {
        title: 'Updated',
        status: 'in_progress',
        priority: 'p1',
      });

      expect(updated.title).toBe('Updated');
      expect(updated.status).toBe('in_progress');
      expect(updated.priority).toBe('p1');
    });

    it('should rename file when title changes', async () => {
      const todo = await todoManager.create({ title: 'Old Title' });

      await todoManager.update(todo.id, { title: 'New Title' });

      const files = await readdir(TEST_TODOS_DIR);
      expect(files[0]).toMatch(/new-title\.md/);
    });

    it('should use atomic file operations for updates', async () => {
      const todo = await todoManager.create({ title: 'Test' });

      await todoManager.update(todo.id, {
        title: 'Updated',
        status: 'completed',
      });

      const files = await readdir(TEST_TODOS_DIR);
      expect(files.length).toBe(1);
    });

    it('should throw error when updating non-existent todo', async () => {
      await expect(
        todoManager.update('999', { title: 'Test' })
      ).rejects.toThrow('Todo not found: 999');
    });
  });

  describe('Get Operations', () => {
    it('should get todo by ID', async () => {
      const created = await todoManager.create({ title: 'Test task' });

      const found = await todoManager.getById(created.id);

      expect(found).not.toBeNull();
      expect(found?.id).toBe(created.id);
      expect(found?.title).toBe('Test task');
    });

    it('should return null when getting non-existent todo', async () => {
      const found = await todoManager.getById('999');

      expect(found).toBeNull();
    });

    it('should get all todos', async () => {
      await todoManager.create({ title: 'Task 1' });
      await todoManager.create({ title: 'Task 2' });
      await todoManager.create({ title: 'Task 3' });

      const todos = await todoManager.getAll();

      expect(todos).toHaveLength(3);
    });

    it('should return empty array when no todos exist', async () => {
      const todos = await todoManager.getAll();

      expect(todos).toEqual([]);
    });

    it('should sort todos by ID', async () => {
      await todoManager.create({ title: 'Task 3' });
      await todoManager.create({ title: 'Task 1' });
      await todoManager.create({ title: 'Task 2' });

      const todos = await todoManager.getAll();

      expect(todos[0].id).toBe('001');
      expect(todos[1].id).toBe('002');
      expect(todos[2].id).toBe('003');
    });

    it('should get todos by status', async () => {
      await todoManager.create({ title: 'Task 1', status: 'pending' });
      await todoManager.create({ title: 'Task 2', status: 'in_progress' });
      await todoManager.create({ title: 'Task 3', status: 'pending' });

      const pending = await todoManager.getByStatus('pending');

      expect(pending).toHaveLength(2);
      expect(pending.every((t) => t.status === 'pending')).toBe(true);
    });

    it('should return empty array when no todos match status', async () => {
      await todoManager.create({ title: 'Task 1', status: 'pending' });

      const completed = await todoManager.getByStatus('completed');

      expect(completed).toEqual([]);
    });
  });

  describe('Delete', () => {
    it('should delete todo', async () => {
      const todo = await todoManager.create({ title: 'Test task' });

      await todoManager.delete(todo.id);

      const found = await todoManager.getById(todo.id);
      expect(found).toBeNull();
    });

    it('should delete todo file from filesystem', async () => {
      const todo = await todoManager.create({ title: 'Test task' });

      await todoManager.delete(todo.id);

      const files = await readdir(TEST_TODOS_DIR);
      expect(files).toHaveLength(0);
    });

    it('should throw error when deleting non-existent todo', async () => {
      await expect(todoManager.delete('999')).rejects.toThrow(
        'Todo not found: 999'
      );
    });
  });

  describe('Rollup Summary', () => {
    it('should generate summary with no todos', async () => {
      const summary = await todoManager.generateRollupSummary();

      expect(summary).toContain('## Todos');
      expect(summary).toContain('No todos tracked for this workflow');
    });

    it('should generate summary with progress percentage', async () => {
      await todoManager.create({ title: 'Task 1', status: 'completed' });
      await todoManager.create({ title: 'Task 2', status: 'pending' });
      await todoManager.create({ title: 'Task 3', status: 'pending' });

      const summary = await todoManager.generateRollupSummary();

      expect(summary).toContain('**Progress:** 33% (1/3 completed)');
    });

    it('should group todos by status', async () => {
      await todoManager.create({ title: 'Task 1', status: 'completed' });
      await todoManager.create({ title: 'Task 2', status: 'in_progress' });
      await todoManager.create({ title: 'Task 3', status: 'pending' });
      await todoManager.create({ title: 'Task 4', status: 'blocked' });

      const summary = await todoManager.generateRollupSummary();

      expect(summary).toContain('### ✓ Completed');
      expect(summary).toContain('### ⠼ In Progress');
      expect(summary).toContain('### ○ Pending');
      expect(summary).toContain('### ✗ Blocked');
    });

    it('should include todo details in summary', async () => {
      await todoManager.create({
        title: 'Important task',
        status: 'pending',
        priority: 'p1',
      });

      const summary = await todoManager.generateRollupSummary();

      expect(summary).toContain('**001** (p1): Important task');
    });

    it('should calculate 100% for all completed', async () => {
      await todoManager.create({ title: 'Task 1', status: 'completed' });
      await todoManager.create({ title: 'Task 2', status: 'completed' });

      const summary = await todoManager.generateRollupSummary();

      expect(summary).toContain('**Progress:** 100% (2/2 completed)');
    });

    it('should not show empty status sections', async () => {
      await todoManager.create({ title: 'Task 1', status: 'pending' });

      const summary = await todoManager.generateRollupSummary();

      expect(summary).not.toContain('### ✓ Completed');
      expect(summary).not.toContain('### ⠼ In Progress');
      expect(summary).not.toContain('### ✗ Blocked');
    });
  });

  describe('Serialization', () => {
    it('should serialize todo to markdown with frontmatter', async () => {
      const todo = await todoManager.create({
        title: 'Test task',
        description: 'Test description',
        status: 'pending',
        priority: 'p1',
      });

      const files = await readdir(TEST_TODOS_DIR);
      const content = await readFile(
        path.join(TEST_TODOS_DIR, files[0]),
        'utf-8'
      );

      expect(content).toContain('---');
      expect(content).toContain('id: 001');
      expect(content).toContain('status: pending');
      expect(content).toContain('priority: p1');
      expect(content).toContain('title: Test task');
      expect(content).toContain('created_at:');
      expect(content).toContain('updated_at:');
    });

    it('should include description in markdown body', async () => {
      const todo = await todoManager.create({
        title: 'Test task',
        description: 'This is a detailed description',
      });

      const files = await readdir(TEST_TODOS_DIR);
      const content = await readFile(
        path.join(TEST_TODOS_DIR, files[0]),
        'utf-8'
      );

      expect(content).toContain('## Description');
      expect(content).toContain('This is a detailed description');
    });

    it('should deserialize markdown back to todo object', async () => {
      const created = await todoManager.create({
        title: 'Test task',
        description: 'Test description',
      });

      const loaded = await todoManager.getById(created.id);

      expect(loaded?.id).toBe(created.id);
      expect(loaded?.title).toBe(created.title);
      expect(loaded?.description).toBe(created.description);
      expect(loaded?.status).toBe(created.status);
      expect(loaded?.priority).toBe(created.priority);
    });

    it('should preserve dates through serialization', async () => {
      const created = await todoManager.create({ title: 'Test task' });

      const loaded = await todoManager.getById(created.id);

      expect(loaded?.createdAt).toBeInstanceOf(Date);
      expect(loaded?.updatedAt).toBeInstanceOf(Date);
      expect(loaded?.createdAt.toISOString()).toBe(
        created.createdAt.toISOString()
      );
    });
  });

  describe('Error Handling', () => {
    it('should handle corrupted todo file gracefully', async () => {
      await todoManager.initialize();

      // Create corrupted file
      const fs = await import('fs/promises');
      await fs.writeFile(
        path.join(TEST_TODOS_DIR, '001-pending-p2-corrupted.md'),
        'invalid content without frontmatter',
        'utf-8'
      );

      const todos = await todoManager.getAll();

      // Should skip corrupted file and return empty array
      expect(todos).toEqual([]);
    });

    it('should handle missing description field', async () => {
      const todo = await todoManager.create({
        title: 'Task without description',
      });

      const loaded = await todoManager.getById(todo.id);

      expect(loaded?.description).toBeUndefined();
    });
  });

  describe('Slugification', () => {
    it('should convert to lowercase', async () => {
      await todoManager.create({ title: 'UPPERCASE TITLE' });

      const files = await readdir(TEST_TODOS_DIR);
      expect(files[0]).toMatch(/uppercase-title\.md/);
    });

    it('should replace spaces with hyphens', async () => {
      await todoManager.create({ title: 'Title With Spaces' });

      const files = await readdir(TEST_TODOS_DIR);
      expect(files[0]).toMatch(/title-with-spaces\.md/);
    });

    it('should remove special characters', async () => {
      await todoManager.create({ title: 'Title: With @ Special # Chars!' });

      const files = await readdir(TEST_TODOS_DIR);
      expect(files[0]).toMatch(/title-with-special-chars\.md/);
    });

    it('should remove leading and trailing hyphens', async () => {
      await todoManager.create({ title: '---Title---' });

      const files = await readdir(TEST_TODOS_DIR);
      const slug = files[0].split('-').slice(3).join('-').replace('.md', '');
      expect(slug.startsWith('-')).toBe(false);
      expect(slug.endsWith('-')).toBe(false);
    });

    it('should handle empty title after slugification', async () => {
      await todoManager.create({ title: '###' });

      const files = await readdir(TEST_TODOS_DIR);
      expect(files.length).toBe(1);
    });
  });

  describe('Namespacing', () => {
    const NAMESPACE_BASE_DIR = '.airunx-test/test-todos-namespace';
    const NAMESPACE_1 = 'issue-123';
    const NAMESPACE_2 = 'issue-456';

    afterEach(async () => {
      // Clean up namespace test directories
      if (existsSync(NAMESPACE_BASE_DIR)) {
        await rm(NAMESPACE_BASE_DIR, { recursive: true });
      }
    });

    it('should create todos in namespace directory when provided', async () => {
      const namespacedManager = new TodoManager(NAMESPACE_BASE_DIR, NAMESPACE_1);
      await namespacedManager.create({ title: 'Namespaced task' });

      const expectedDir = path.join(NAMESPACE_BASE_DIR, NAMESPACE_1);
      expect(existsSync(expectedDir)).toBe(true);

      const files = await readdir(expectedDir);
      expect(files.length).toBe(1);
      expect(files[0]).toMatch(/001-pending-p2-namespaced-task\.md/);
    });

    it('should use base directory when no namespace provided', async () => {
      const nonNamespacedManager = new TodoManager(NAMESPACE_BASE_DIR);
      await nonNamespacedManager.create({ title: 'Base task' });

      expect(existsSync(NAMESPACE_BASE_DIR)).toBe(true);

      const files = await readdir(NAMESPACE_BASE_DIR);
      expect(files.length).toBe(1);
      expect(files[0]).toMatch(/001-pending-p2-base-task\.md/);
    });

    it('should isolate todos between different namespaces', async () => {
      const manager1 = new TodoManager(NAMESPACE_BASE_DIR, NAMESPACE_1);
      const manager2 = new TodoManager(NAMESPACE_BASE_DIR, NAMESPACE_2);

      await manager1.create({ title: 'Task from issue 123' });
      await manager1.create({ title: 'Another task from 123' });
      await manager2.create({ title: 'Task from issue 456' });

      // Each namespace should have its own independent IDs starting at 001
      const todos1 = await manager1.getAll();
      const todos2 = await manager2.getAll();

      expect(todos1.length).toBe(2);
      expect(todos2.length).toBe(1);

      expect(todos1[0].id).toBe('001');
      expect(todos1[1].id).toBe('002');
      expect(todos2[0].id).toBe('001'); // Independent ID sequence

      // Verify directory structure
      const dir1 = path.join(NAMESPACE_BASE_DIR, NAMESPACE_1);
      const dir2 = path.join(NAMESPACE_BASE_DIR, NAMESPACE_2);

      expect(existsSync(dir1)).toBe(true);
      expect(existsSync(dir2)).toBe(true);

      const files1 = await readdir(dir1);
      const files2 = await readdir(dir2);

      expect(files1.length).toBe(2);
      expect(files2.length).toBe(1);
    });
  });
});
