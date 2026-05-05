/**
 * Todo Manager - CRUD operations for todo tracking
 * Creates filesystem-based todos with slugified filenames
 */

import { mkdir, writeFile, readFile, readdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import lockfile from 'proper-lockfile';
import type { Todo } from '../core/types.js';
import { LOCK_RETRY_CONFIG } from '../orchestrator/constants.js';
import { createLogger } from './logger.js';
import { DEFAULT_TODO_DIR } from '../orchestrator/constants.js';

const logger = createLogger('todo-manager');

/**
 * Todo status type
 */
export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'blocked';

/**
 * Todo priority type
 */
export type TodoPriority = 'p1' | 'p2' | 'p3';

/**
 * Options for creating a todo
 */
export interface CreateTodoOptions {
  title: string;
  description?: string;
  status?: TodoStatus;
  priority?: TodoPriority;
}

/**
 * Todo Manager class
 */
export class TodoManager {
  private todosDir: string;

  /**
   * Create a TodoManager instance
   * @param todosDir - Base directory for todos (default: DEFAULT_TODO_DIR)
   * @param namespace - Optional namespace for isolation (e.g., 'issue-123')
   */
  constructor(todosDir: string = DEFAULT_TODO_DIR, namespace?: string) {
    this.todosDir = namespace ? path.join(todosDir, namespace) : todosDir;
  }

  /**
   * Initialize todos directory
   */
  async initialize(): Promise<void> {
    if (!existsSync(this.todosDir)) {
      await mkdir(this.todosDir, { recursive: true });
      logger.info(`Created todos directory: ${this.todosDir}`);
    }
  }

  /**
   * Create a new todo
   * Uses file locking to prevent race conditions when generating IDs
   */
  async create(options: CreateTodoOptions): Promise<Todo> {
    await this.initialize();

    // Acquire lock on todos directory to prevent race conditions
    let release: (() => Promise<void>) | undefined;
    try {
      release = await lockfile.lock(this.todosDir, {
        retries: LOCK_RETRY_CONFIG,
      });

      // Generate ID (simple incrementing number) - safe within lock
      const todos = await this.getAll();
      const maxId = todos.reduce((max, todo) => {
        const id = parseInt(todo.id, 10);
        return isNaN(id) ? max : Math.max(max, id);
      }, 0);
      const id = String(maxId + 1).padStart(3, '0');

      const todo: Todo = {
        id,
        title: options.title,
        description: options.description,
        status: options.status || 'pending',
        priority: options.priority || 'p2',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await this.saveTodoFile(todo);
      logger.info(`Created todo: ${id} - ${todo.title}`);
      return todo;
    } finally {
      if (release) {
        await release();
      }
    }
  }

  /**
   * Update todo status
   * Uses file locking to ensure atomic updates when filename changes
   */
  async updateStatus(id: string, status: TodoStatus): Promise<Todo> {
    await this.initialize();

    // Acquire lock on todos directory to prevent concurrent modifications
    let release: (() => Promise<void>) | undefined;
    try {
      release = await lockfile.lock(this.todosDir, {
        retries: LOCK_RETRY_CONFIG,
      });

      const todo = await this.getById(id);
      if (!todo) {
        throw new Error(`Todo not found: ${id}`);
      }

      const oldPath = this.getTodoPath(todo);

      // Update status and timestamp
      todo.status = status;
      todo.updatedAt = new Date();

      // Save with new filename first (atomic write)
      await this.saveTodoFile(todo);

      // If the path changed, remove the old file after the new one is written
      const newPath = this.getTodoPath(todo);
      if (oldPath !== newPath && existsSync(oldPath)) {
        await rm(oldPath);
      }

      logger.info(`Updated todo status: ${id} -> ${status}`);
      return todo;
    } finally {
      if (release) {
        await release();
      }
    }
  }

  /**
   * Update todo
   * Uses file locking to ensure atomic updates when filename changes
   */
  async update(id: string, updates: Partial<CreateTodoOptions>): Promise<Todo> {
    await this.initialize();

    // Acquire lock on todos directory to prevent concurrent modifications
    let release: (() => Promise<void>) | undefined;
    try {
      release = await lockfile.lock(this.todosDir, {
        retries: LOCK_RETRY_CONFIG,
      });

      const todo = await this.getById(id);
      if (!todo) {
        throw new Error(`Todo not found: ${id}`);
      }

      // Save old path before making changes
      const oldPath = this.getTodoPath(todo);

      // Check if changes affect filename
      const titleChanged = updates.title && updates.title !== todo.title;
      const statusChanged = updates.status && updates.status !== todo.status;
      const priorityChanged =
        updates.priority && updates.priority !== todo.priority;

      // Apply updates
      if (updates.title) todo.title = updates.title;
      if (updates.description !== undefined)
        todo.description = updates.description;
      if (updates.status) todo.status = updates.status;
      if (updates.priority) todo.priority = updates.priority;
      todo.updatedAt = new Date();

      // Save with new filename first (atomic write)
      await this.saveTodoFile(todo);

      // If the path changed, delete old file after new one is written
      if (titleChanged || statusChanged || priorityChanged) {
        const newPath = this.getTodoPath(todo);
        if (oldPath !== newPath && existsSync(oldPath)) {
          await rm(oldPath);
        }
      }

      logger.info(`Updated todo: ${id}`);
      return todo;
    } finally {
      if (release) {
        await release();
      }
    }
  }

  /**
   * Get todo by ID
   */
  async getById(id: string): Promise<Todo | null> {
    const todos = await this.getAll();
    return todos.find((todo) => todo.id === id) || null;
  }

  /**
   * Get all todos
   */
  async getAll(): Promise<Todo[]> {
    if (!existsSync(this.todosDir)) {
      return [];
    }

    const files = await readdir(this.todosDir);
    const todoFiles = files.filter((file) => file.endsWith('.md'));

    const todos: Todo[] = [];
    for (const file of todoFiles) {
      try {
        const todo = await this.loadTodoFile(file);
        if (todo) {
          todos.push(todo);
        }
      } catch (error) {
        logger.warn(`Failed to load todo file: ${file}`, error);
      }
    }

    // Sort by ID
    return todos.sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Get todos by status
   */
  async getByStatus(status: TodoStatus): Promise<Todo[]> {
    const todos = await this.getAll();
    return todos.filter((todo) => todo.status === status);
  }

  /**
   * Delete a todo
   */
  async delete(id: string): Promise<void> {
    const todo = await this.getById(id);
    if (!todo) {
      throw new Error(`Todo not found: ${id}`);
    }

    const todoPath = this.getTodoPath(todo);
    if (existsSync(todoPath)) {
      await rm(todoPath);
      logger.info(`Deleted todo: ${id}`);
    }
  }

  /**
   * Generate rollup summary for PR
   */
  async generateRollupSummary(): Promise<string> {
    const todos = await this.getAll();

    if (todos.length === 0) {
      return '## Todos\n\nNo todos tracked for this workflow.\n';
    }

    const byStatus = {
      completed: todos.filter((t) => t.status === 'completed'),
      in_progress: todos.filter((t) => t.status === 'in_progress'),
      pending: todos.filter((t) => t.status === 'pending'),
      blocked: todos.filter((t) => t.status === 'blocked'),
    };

    const total = todos.length;
    const completed = byStatus.completed.length;
    const percentage = Math.round((completed / total) * 100);

    let summary = '## Todos\n\n';
    summary += `**Progress:** ${percentage}% (${completed}/${total} completed)\n\n`;

    for (const status of [
      'completed',
      'in_progress',
      'pending',
      'blocked',
    ] as const) {
      const items = byStatus[status];
      if (items.length > 0) {
        const statusIcon = this.getStatusIcon(status);
        summary += `### ${statusIcon} ${this.formatStatus(status)}\n\n`;
        for (const todo of items) {
          summary += `- **${todo.id}** (${todo.priority}): ${todo.title}\n`;
        }
        summary += '\n';
      }
    }

    return summary;
  }

  /**
   * Slugify title for filename
   */
  private slugify(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-') // Replace non-alphanumeric with hyphens
      .replace(/^-+|-+$/g, '') // Remove leading/trailing hyphens
      .substring(0, 50); // Limit length
  }

  /**
   * Get todo filename
   */
  private getTodoFilename(todo: Todo): string {
    const slug = this.slugify(todo.title);
    return `${todo.id}-${todo.status}-${todo.priority}-${slug}.md`;
  }

  /**
   * Get todo file path
   */
  private getTodoPath(todo: Todo): string {
    return path.join(this.todosDir, this.getTodoFilename(todo));
  }

  /**
   * Save todo to file
   */
  private async saveTodoFile(todo: Todo): Promise<void> {
    const todoPath = this.getTodoPath(todo);
    const content = this.serializeTodo(todo);
    await writeFile(todoPath, content, 'utf-8');
  }

  /**
   * Load todo from file
   */
  private async loadTodoFile(filename: string): Promise<Todo | null> {
    const filePath = path.join(this.todosDir, filename);
    const content = await readFile(filePath, 'utf-8');
    return this.parseTodo(content);
  }

  /**
   * Serialize todo to markdown
   */
  private serializeTodo(todo: Todo): string {
    let content = '---\n';
    content += `id: ${todo.id}\n`;
    content += `status: ${todo.status}\n`;
    content += `priority: ${todo.priority}\n`;
    content += `title: ${todo.title}\n`;
    content += `created_at: ${todo.createdAt.toISOString()}\n`;
    content += `updated_at: ${todo.updatedAt.toISOString()}\n`;
    content += '---\n\n';
    content += `# ${todo.title}\n\n`;
    content += `**Filename:** \`${this.getTodoFilename(todo)}\`\n\n`;

    if (todo.description) {
      content += `## Description\n\n${todo.description}\n\n`;
    }

    return content;
  }

  /**
   * Parse todo from markdown
   */
  private parseTodo(content: string): Todo | null {
    // Extract frontmatter
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!frontmatterMatch) {
      return null;
    }

    const frontmatter = frontmatterMatch[1];
    const lines = frontmatter.split('\n');
    const data: Record<string, string> = {};

    for (const line of lines) {
      const match = line.match(/^(\w+):\s*(.+)$/);
      if (match) {
        const [, key, value] = match;
        data[key] = value;
      }
    }

    // Extract description from body
    const body = content.substring(frontmatterMatch[0].length);
    const descMatch = body.match(/## Description\n\n([\s\S]*?)(?=\n##|\n$|$)/);
    const description = descMatch ? descMatch[1].trim() : undefined;

    return {
      id: data.id,
      title: data.title,
      description,
      status: data.status as TodoStatus,
      priority: data.priority as TodoPriority,
      createdAt: new Date(data.created_at),
      updatedAt: new Date(data.updated_at),
    };
  }

  /**
   * Get status icon
   */
  private getStatusIcon(status: TodoStatus): string {
    switch (status) {
      case 'completed':
        return '✓';
      case 'in_progress':
        return '⠼';
      case 'pending':
        return '○';
      case 'blocked':
        return '✗';
      default:
        return '○';
    }
  }

  /**
   * Format status for display
   */
  private formatStatus(status: TodoStatus): string {
    return status.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
  }
}
