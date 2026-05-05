/**
 * Adapter registry and factory
 */

export { BaseAdapter } from './base-adapter.js';
export { ClaudeCodeAdapter } from './claude-code-adapter.js';
export { CursorAdapter } from './cursor-adapter.js';
export { CodexAdapter } from './codex-adapter.js';
export { CompoundEngineeringAdapter } from './compound-engineering-adapter.js';
export { BackendValidator } from './backend-validator.js';

export type { ValidationResult } from './backend-validator.js';
export type {
  SubAgentType,
  SubAgentRequest,
  SubAgentResult,
} from './compound-engineering-adapter.js';

import type { ExecutionAdapter, BackendType } from '../core/adapter-types.js';
import { BACKEND_TYPES } from '../core/adapter-types.js';
import { ClaudeCodeAdapter } from './claude-code-adapter.js';
import { CursorAdapter } from './cursor-adapter.js';
import { CodexAdapter } from './codex-adapter.js';
import { CompoundEngineeringAdapter } from './compound-engineering-adapter.js';
import { loadSettings, type ResolvedSettings } from '../utils/settings.js';

/**
 * Create an adapter instance for a given backend type
 *
 * Note: For 'claude-code', Compound Engineering capabilities are included by default.
 * Set disable_compound_engineering: true in settings to use raw Claude Code.
 */
export function createAdapter(
  backend: BackendType,
  options?: {
    disableCompoundEngineering?: boolean;
    settings?: ResolvedSettings;
  }
): ExecutionAdapter {
  switch (backend) {
    case 'claude-code': {
      // Check if CE should be disabled (from options or settings)
      const resolvedSettings = options?.settings ?? loadSettings();
      const disableCE =
        options?.disableCompoundEngineering ??
        resolvedSettings.disable_compound_engineering;
      if (disableCE) {
        return new ClaudeCodeAdapter();
      }
      // Default: Use CompoundEngineeringAdapter which wraps Claude Code with delegation
      return new CompoundEngineeringAdapter();
    }
    case 'cursor':
      return new CursorAdapter();
    case 'codex':
      return new CodexAdapter();
    default:
      throw new Error(`Unknown backend type: ${backend}`);
  }
}

/**
 * Get all available adapter types
 */
export function getAvailableAdapterTypes(): BackendType[] {
  return [...BACKEND_TYPES];
}
