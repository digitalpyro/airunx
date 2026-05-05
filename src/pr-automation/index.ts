/**
 * PR Automation Module
 *
 * Provides automated commit and pull request creation
 * with workflow metadata and template support.
 */

export { AutoCommit } from './auto-commit.js';
export type { AutoCommitOptions, AutoCommitResult } from './auto-commit.js';

export { PRGenerator } from './pr-generator.js';
export type { PRGeneratorOptions, PRGeneratorResult } from './pr-generator.js';

export { TemplateEngine } from './template-engine.js';
export type { TemplateContext } from './template-engine.js';

export { PR_AUTOMATION_DEFAULTS } from './constants.js';
