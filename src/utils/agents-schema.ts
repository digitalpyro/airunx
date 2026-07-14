/**
 * AGENTS.md Schema and Parser
 *
 * Provides structured parsing and validation for AGENTS.md markdown files.
 * Extracts agent definitions, validates roles against known enums, and
 * provides helpful suggestions for invalid values.
 */

import { existsSync, readFileSync } from 'fs';
import { AGENT_ROLES, type AgentRole } from '../core/types.js';
import {
  BACKEND_TYPES,
  SUB_AGENT_TYPES,
  type BackendType,
  type SubAgentType,
} from '../core/adapter-types.js';
import { createLogger } from './logger.js';
import type { ValidationIssue, ValidationMode } from './file-validator.js';

const logger = createLogger('agents-schema');
import { getClosestMatch } from './string-utils.js';
import {
  MODEL_ALIASES,
  ANTHROPIC_PRICING,
  OPENAI_PRICING,
} from '../adapters/pricing.js';

/**
 * Known agent property keys that can be parsed from AGENTS.md
 * Add new properties here - regex is built dynamically from this list
 */
const KNOWN_AGENT_KEYS = [
  'purpose',
  'responsibilities',
  'tools',
  'output',
  'provider',
  'provider-rationale',
  'fallback-provider',
  'model',
  'model-rationale',
  'system-prompt',
  'used in',
  'note',
  'provider-config',
] as const;

/**
 * Cost thresholds for expensive model warnings (USD per million tokens)
 * Models exceeding these thresholds trigger info-level warnings
 */
const EXPENSIVE_MODEL_INPUT_THRESHOLD = 5; // $5 per 1M input tokens
const EXPENSIVE_MODEL_OUTPUT_THRESHOLD = 25; // $25 per 1M output tokens

/**
 * Primary Anthropic model aliases (short, user-friendly names)
 * Used for display and filtering out version-specific aliases
 */
const PRIMARY_ANTHROPIC_ALIASES = ['opus', 'sonnet', 'haiku'] as const;

/**
 * Legacy OpenAI models to exclude from common suggestions
 * These are kept in OPENAI_PRICING for backward compatibility but
 * shouldn't be suggested as primary options to users
 */
const LEGACY_OPENAI_MODELS = [
  'gpt-5.5',
  'gpt-5.4',
  'gpt-4o',
  'gpt-4o-mini',
  'o1',
  'o1-mini',
  'gpt-4-turbo',
  'gpt-4',
  'gpt-3.5-turbo',
] as const;

/**
 * Legacy Anthropic models to exclude from suggestions
 * Kept in ANTHROPIC_PRICING for backward compatibility
 */
const LEGACY_ANTHROPIC_MODELS = [
  'claude-opus-4-5-20251101',
  'claude-sonnet-4-5-20250929',
  'claude-opus-4-1-20250805',
  'claude-sonnet-4-5-20250514',
  'claude-4-1-opus-20250324',
  'claude-4-1-sonnet-20250514',
  'claude-3.5-sonnet-20240620',
  'claude-3-opus-20240229',
  'claude-3-sonnet-20240229',
  'claude-3-haiku-20240307',
] as const;

/**
 * Regex pattern for matching agent property lines
 * Built dynamically from KNOWN_AGENT_KEYS for maintainability
 */
const AGENT_PROPERTY_REGEX = new RegExp(
  `^[-*]\\s+\\*?\\*?(${KNOWN_AGENT_KEYS.join('|')})\\*?\\*?:\\s*(.*)$`,
  'i'
);

/**
 * Helper to create a validation issue for an invalid provider field
 */
function createProviderValidationIssue(
  agentRole: string,
  fieldName: 'provider' | 'fallback-provider',
  value: string,
  mode: ValidationMode
): ValidationIssue {
  const closest = getClosestMatch(value, [...BACKEND_TYPES]);
  const displayName =
    fieldName === 'provider' ? 'provider' : 'fallback provider';
  return {
    severity: mode === 'lenient' ? 'warning' : 'error',
    path: `agents.${agentRole}.${fieldName}`,
    message: `Unknown ${displayName} '${value}' for agent '${agentRole}'`,
    value,
    suggestion: closest
      ? `Did you mean '${closest}'?`
      : `Valid providers: ${BACKEND_TYPES.join(', ')}`,
  };
}

/**
 * Valid model identifiers and aliases
 * Built dynamically from pricing tables and MODEL_ALIASES
 */
export const VALID_MODELS: readonly string[] = [
  // Model aliases (user-friendly names)
  ...Object.keys(MODEL_ALIASES),
  // Full Anthropic model IDs
  ...Object.keys(ANTHROPIC_PRICING),
  // Full OpenAI model IDs
  ...Object.keys(OPENAI_PRICING),
] as const;

/**
 * Check if a model value is valid (alias or full model ID)
 */
export function isValidModel(value: string): boolean {
  const normalized = value.toLowerCase();
  return VALID_MODELS.includes(normalized);
}

/**
 * Legacy model IDs from both providers, as a lookup set
 */
const LEGACY_MODEL_IDS = new Set<string>([
  ...LEGACY_OPENAI_MODELS,
  ...LEGACY_ANTHROPIC_MODELS,
]);

/**
 * Models eligible for "did you mean" suggestions
 * Excludes legacy IDs so validation never recommends a deprecated or
 * never-existed historical ID; they stay in VALID_MODELS for backward compat.
 */
const SUGGESTABLE_MODELS: readonly string[] = VALID_MODELS.filter(
  (model) => !LEGACY_MODEL_IDS.has(model)
);

/**
 * Helper to create a validation issue for an invalid model field
 */
function createModelValidationIssue(
  agentRole: string,
  value: string,
  mode: ValidationMode,
  lineNumber: number
): ValidationIssue {
  // Strip inline comments (e.g., "sonnett # typo here" -> "sonnett")
  const valueWithoutComment = value.split('#')[0].trim();
  const closest = getClosestMatch(
    valueWithoutComment.toLowerCase(),
    SUGGESTABLE_MODELS
  );
  return {
    severity: mode === 'lenient' ? 'warning' : 'error',
    path: `agents.${agentRole}.model`,
    message: `Unknown model '${value}' for agent '${agentRole}'`,
    value,
    suggestedValue: closest || undefined,
    suggestion: closest
      ? `Did you mean '${closest}'?`
      : `Valid models: ${getCommonModelAliases().join(', ')}`,
    lineNumber,
  };
}

/**
/**
 * Provider to model family mapping configuration
 * Maps each provider to its expected model family and example models
 */
const PROVIDER_MODEL_FAMILIES: Record<
  string,
  {
    family: 'anthropic' | 'openai';
    examples: string;
  }
> = {
  'claude-code': { family: 'anthropic', examples: "'opus', 'sonnet', 'haiku'" },
  cursor: {
    family: 'openai',
    examples: "'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.4-mini'",
  },
  codex: {
    family: 'openai',
    examples: "'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.4-mini'",
  },
};

/**
 * Get the family of a model ('anthropic' or 'openai')
 * Centralizes model alias resolution and family detection
 */
function getModelFamily(model: string): 'anthropic' | 'openai' | null {
  const normalized = model.toLowerCase();
  const resolvedModel = MODEL_ALIASES[normalized] || normalized;

  if (Object.prototype.hasOwnProperty.call(ANTHROPIC_PRICING, resolvedModel)) {
    return 'anthropic';
  }
  if (Object.prototype.hasOwnProperty.call(OPENAI_PRICING, resolvedModel)) {
    return 'openai';
  }
  return null;
}

/**
 * Check model-provider compatibility and create issue if incompatible
 * Uses PROVIDER_MODEL_FAMILIES configuration for maintainability
 */
function createModelProviderCompatibilityIssue(
  agentRole: string,
  provider: string,
  model: string,
  mode: ValidationMode,
  lineNumber: number
): ValidationIssue | null {
  const providerConfig = PROVIDER_MODEL_FAMILIES[provider];
  if (!providerConfig) {
    // Unknown provider - skip compatibility check
    return null;
  }

  const modelFamily = getModelFamily(model);

  if (modelFamily !== providerConfig.family) {
    const familyName =
      providerConfig.family === 'anthropic' ? 'Anthropic' : 'OpenAI';
    return {
      severity: mode === 'lenient' ? 'warning' : 'error',
      path: `agents.${agentRole}.model`,
      message: `Model '${model}' is not compatible with provider '${provider}'`,
      value: model,
      suggestion: `Use a valid ${familyName} model (e.g., ${providerConfig.examples})`,
      lineNumber,
    };
  }

  return null;
}

/**
 * Model pricing info for cost warnings
 */
interface ModelCostInfo {
  alias: string;
  input: number;
  output: number;
  provider: 'anthropic' | 'openai';
}

/**
 * Get cost information for a model (for cost warnings)
 */
function getModelCostInfo(model: string): ModelCostInfo | null {
  const family = getModelFamily(model);
  if (!family) {
    return null;
  }

  const normalized = model.toLowerCase();
  const resolvedModel = MODEL_ALIASES[normalized] || normalized;
  const pricingTable =
    family === 'anthropic' ? ANTHROPIC_PRICING : OPENAI_PRICING;
  const pricing = pricingTable[resolvedModel];

  return {
    alias: normalized,
    input: pricing.input,
    output: pricing.output,
    provider: family,
  };
}

/**
 * Get user-friendly name for a model
 * Returns primary aliases (opus, sonnet, haiku) for Anthropic models
 * Returns the model ID directly for OpenAI models (already user-friendly)
 */
function getModelDisplayName(modelId: string): string {
  // Only use primary Anthropic aliases for display
  for (const alias of PRIMARY_ANTHROPIC_ALIASES) {
    if (MODEL_ALIASES[alias] === modelId) {
      return alias;
    }
  }
  // For OpenAI and other models, use the model ID directly
  return modelId;
}

/**
 * Find cheaper alternative models from the same provider
 * Returns up to 2 alternatives, sorted by input cost (cheapest first)
 * Excludes legacy models from suggestions
 */
function findCheaperAlternatives(
  currentCost: ModelCostInfo
): Array<{ name: string; input: number; output: number }> {
  const pricingTable =
    currentCost.provider === 'openai' ? OPENAI_PRICING : ANTHROPIC_PRICING;

  // Exclude legacy models from suggestions
  const legacyModels =
    currentCost.provider === 'openai'
      ? LEGACY_OPENAI_MODELS
      : LEGACY_ANTHROPIC_MODELS;

  const alternatives = Object.entries(pricingTable)
    .filter(
      ([modelId, pricing]) =>
        // Require both input AND output to be cheaper for accurate cost savings
        pricing.input < currentCost.input &&
        pricing.output < currentCost.output &&
        // Cast needed: legacyModels has literal tuple type from 'as const'
        !(legacyModels as readonly string[]).includes(modelId)
    )
    .map(([modelId, pricing]) => ({
      name: getModelDisplayName(modelId),
      input: pricing.input,
      output: pricing.output,
    }))
    .sort((a, b) => a.input - b.input) // Sort by input cost ascending
    .slice(0, 2); // Take top 2 cheapest

  return alternatives;
}

/**
 * Create a cost warning for expensive models
 * Dynamically generates suggestions from pricing tables
 */
function createCostWarningIssue(
  agentRole: string,
  model: string,
  costInfo: ModelCostInfo,
  lineNumber: number
): ValidationIssue | null {
  // Warn for models exceeding cost thresholds
  // Use strict > for input to avoid flagging gpt-4o (exactly $5/M input)
  const isExpensive =
    costInfo.input > EXPENSIVE_MODEL_INPUT_THRESHOLD ||
    costInfo.output >= EXPENSIVE_MODEL_OUTPUT_THRESHOLD;
  if (!isExpensive) return null;

  // Find cheaper alternatives from the same provider
  const alternatives = findCheaperAlternatives(costInfo);

  let suggestion: string;
  if (alternatives.length > 0) {
    const parts = alternatives.map(
      (alt) =>
        `'${alt.name}' ($${alt.input.toFixed(2)}/$${alt.output.toFixed(2)})`
    );
    suggestion = `Consider ${parts.join(' or ')} for cost savings unless complex reasoning is required`;
  } else {
    suggestion =
      'No models were found that are strictly cheaper on both input and output tokens.';
  }

  return {
    severity: 'info',
    path: `agents.${agentRole}.model`,
    message: `Agent '${agentRole}' uses model '${model}' ($${costInfo.input.toFixed(2)} input / $${costInfo.output.toFixed(2)} output per 1M tokens)`,
    suggestion,
    lineNumber,
  };
}

/**
 * Parsed agent definition from AGENTS.md
 */
/**
 * Provider configuration for sub-agent delegation and compound engineering
 */
export interface ProviderConfig {
  /**
   * Sub-agents this agent can delegate to.
   * Valid values: 'architecture-strategist' | 'pattern-recognition-specialist' | 'framework-docs-researcher'
   * Empty array disables all sub-agents.
   * Omitting defaults to all sub-agents enabled.
   * Note: Stored as string[] since values come from markdown parsing; validated at runtime.
   */
  subAgents?: string[];
  /** Whether delegation is enabled (default: true) */
  delegation?: boolean;
  /**
   * Disable compound-engineering entirely for this agent.
   * When true, the agent uses raw Claude Code without CE features.
   */
  disableCompoundEngineering?: boolean;
}

export interface ParsedAgentDefinition {
  role: string;
  isValidRole: boolean;
  purpose?: string;
  responsibilities?: string[];
  tools?: string[];
  /** The expected output or deliverable from the agent */
  output?: string;
  /** Provider backend for this agent (e.g., 'claude-code', 'cursor', 'codex') */
  provider?: string;
  /** Whether the provider value is a valid BackendType */
  isValidProvider?: boolean;
  /** Rationale for choosing this provider */
  providerRationale?: string;
  /** Fallback provider if primary is unavailable */
  fallbackProvider?: string;
  /** Whether the fallback provider is a valid BackendType */
  isValidFallbackProvider?: boolean;
  /** Preferred model for this agent (e.g., 'sonnet', 'haiku', 'opus') */
  model?: string;
  /** Whether the model value is a valid model ID or alias */
  isValidModel?: boolean;
  /** Rationale for choosing this model */
  modelRationale?: string;
  /** Custom system prompt for the agent - overrides auto-generated prompt */
  systemPrompt?: string;
  /** Pipeline stages where this agent is used (informational) */
  usedIn?: string;
  /** Additional notes about the agent (informational) */
  note?: string;
  /** Provider configuration for sub-agent delegation */
  providerConfig?: ProviderConfig;
  lineNumber: number;
  rawContent: string;
}

/**
 * Parsed AGENTS.md structure
 */
export interface ParsedAgentsConfig {
  agents: ParsedAgentDefinition[];
  pipelineFlow?: string;
  conventions?: Record<string, string>;
  customSections: Record<string, string>;
  rawContent: string;
}

/**
 * Parse an agent property line from markdown (e.g., "- **Purpose**: ...")
 * Only matches known agent properties to avoid false positives with colons in values
 * Returns the key and optional inline value (value may be empty for multi-line properties)
 */
function parseAgentProperty(
  line: string
): { key: string; value: string } | null {
  // Value is optional to support multi-line formats like:
  // - **Tools**:
  //   - gh-cli
  //   - vscode
  const match = line.match(AGENT_PROPERTY_REGEX);
  if (match) {
    return {
      key: match[1].trim().toLowerCase(),
      value: match[2].trim(),
    };
  }
  return null;
}

/**
 * Check if a provider value is valid
 */
function isValidBackendType(value: string): value is BackendType {
  return BACKEND_TYPES.includes(value as BackendType);
}

/**
 * Parse an indented list item (for multi-line property values)
 * Matches lines like "  - item" or "    * item"
 */
function parseIndentedListItem(line: string): string | null {
  const match = line.match(/^\s+[-*]\s+(.+)$/);
  return match ? match[1].trim() : null;
}

/**
 * Parse a general key-value line from markdown (e.g., "- **Key**: value")
 * Used for convention sections where any key is valid
 */
function parseKeyValue(line: string): { key: string; value: string } | null {
  // Match patterns like "- **Key**: value" or "- Key: value"
  const match = line.match(/^[-*]\s+\*?\*?([^:*]+)\*?\*?:\s*(.+)$/);
  if (match) {
    return {
      key: match[1].trim().toLowerCase(),
      value: match[2].trim(),
    };
  }
  return null;
}

/**
 * Parse a boolean value from markdown config (supports 'true', 'yes', 'false', 'no')
 */
function parseBooleanConfig(value: string): boolean {
  const normalized = value.toLowerCase().trim();
  return normalized === 'true' || normalized === 'yes';
}

/**
 * Parse a comma-separated list of tools
 */
function parseToolsList(value: string): string[] {
  // Handle "Tool1, Tool2, Tool3" format
  return value
    .split(/,\s*/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * Parse AGENTS.md content into structured format
 */
export function parseAgentsMd(content: string): ParsedAgentsConfig {
  const lines = content.split('\n');
  const result: ParsedAgentsConfig = {
    agents: [],
    customSections: {},
    rawContent: content,
  };

  let currentAgent: ParsedAgentDefinition | null = null;
  let currentSection: string | null = null;
  let sectionContent: string[] = [];
  let inCodeBlock = false;
  // Track current property for multi-line value accumulation
  let currentProperty: 'responsibilities' | 'tools' | 'provider-config' | null =
    null;

  // Helper to save the current agent, reset state, and avoid duplication
  const saveCurrentAgent = (): void => {
    if (currentAgent) {
      result.agents.push(currentAgent);
      currentAgent = null;
    }
  };

  // Helper to check if a ### header is followed by agent property markers
  // Returns true if the following content looks like an agent definition
  const isAgentDefinition = (startIndex: number): boolean => {
    // Look at the next few lines (up to next ## or ### header, or 10 lines max)
    const maxLookahead = Math.min(startIndex + 10, lines.length);
    for (let j = startIndex + 1; j < maxLookahead; j++) {
      const checkLine = lines[j].trim();

      // Stop at next header
      if (checkLine.startsWith('## ') || checkLine.startsWith('### ')) {
        break;
      }

      // Skip empty lines and code fences
      if (!checkLine || checkLine.startsWith('```')) {
        continue;
      }

      // Check for agent property markers (- **Key**: or * **Key**:)
      if (/^[-*]\s+\*?\*?\s*\w+.*\*?\*?:/.test(checkLine)) {
        return true;
      }

      // If first non-empty line doesn't look like a property, it's not an agent
      // (e.g., "Outputs: **GitHub Issue**" or prose text)
      return false;
    }
    return false;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1;

    // Track code blocks to avoid parsing headers inside them
    const isFence = line.trim().startsWith('```');
    if (isFence) {
      inCodeBlock = !inCodeBlock;
    }

    // Accumulate content for code blocks (both fence lines and content inside)
    if (inCodeBlock || isFence) {
      if (currentSection && !currentAgent) {
        sectionContent.push(line);
      } else if (currentAgent) {
        currentAgent.rawContent += '\n' + line;
      }
      continue;
    }

    // Check for H2 sections
    if (line.startsWith('## ')) {
      saveCurrentAgent();

      // Save previous section content
      if (currentSection && sectionContent.length > 0) {
        const sectionText = sectionContent.join('\n').trim();
        if (currentSection === 'pipeline flow') {
          result.pipelineFlow = sectionText;
        } else if (currentSection === 'conventions') {
          result.conventions = parseConventions(sectionText);
        } else {
          result.customSections[currentSection] = sectionText;
        }
      }

      currentSection = line.slice(3).trim().toLowerCase();
      sectionContent = [];
      currentProperty = null;
      continue;
    }

    // Check for H3 agent definitions
    // Only treat as agent if followed by property markers (- **Purpose**:, etc.)
    if (line.startsWith('### ') && isAgentDefinition(i)) {
      saveCurrentAgent();

      const role = line.slice(4).trim();
      currentAgent = {
        role,
        isValidRole: AGENT_ROLES.includes(role as AgentRole),
        lineNumber,
        rawContent: line,
      };
      currentProperty = null;
      continue;
    }

    // Parse agent properties
    if (currentAgent && line.trim()) {
      // Capture all non-empty lines in rawContent first to preserve complete agent definition
      currentAgent.rawContent += '\n' + line;

      const kv = parseAgentProperty(line);
      if (kv) {
        switch (kv.key) {
          case 'purpose':
            currentAgent.purpose = kv.value;
            currentProperty = null; // Purpose doesn't support multi-line
            break;
          case 'responsibilities':
            // Handle inline comma-separated values or prepare for multi-line
            if (kv.value) {
              currentAgent.responsibilities = parseToolsList(kv.value);
              currentProperty = null;
            } else {
              // Empty value means multi-line list follows
              currentAgent.responsibilities = [];
              currentProperty = 'responsibilities';
            }
            break;
          case 'tools':
            // Handle inline comma-separated values or prepare for multi-line
            if (kv.value) {
              currentAgent.tools = parseToolsList(kv.value);
              currentProperty = null;
            } else {
              // Empty value means multi-line list follows
              currentAgent.tools = [];
              currentProperty = 'tools';
            }
            break;
          case 'provider':
            if (kv.value) {
              currentAgent.provider = kv.value;
              currentAgent.isValidProvider = isValidBackendType(kv.value);
            }
            currentProperty = null;
            break;
          case 'fallback-provider':
            if (kv.value) {
              currentAgent.fallbackProvider = kv.value;
              currentAgent.isValidFallbackProvider = isValidBackendType(
                kv.value
              );
            }
            currentProperty = null;
            break;
          case 'model':
            if (kv.value) {
              // Strip inline comments (e.g., "sonnet # recommended" -> "sonnet")
              const modelValue = kv.value.split('#')[0].trim();
              currentAgent.model = modelValue;
              currentAgent.isValidModel = isValidModel(modelValue);
            }
            currentProperty = null;
            break;
          // Simple string properties - grouped for reduced duplication
          case 'output':
          case 'provider-rationale':
          case 'model-rationale':
          case 'system-prompt':
          case 'used in':
          case 'note': {
            if (kv.value) {
              // Map kebab-case keys to camelCase property names
              switch (kv.key) {
                case 'output':
                  currentAgent.output = kv.value;
                  break;
                case 'provider-rationale':
                  currentAgent.providerRationale = kv.value;
                  break;
                case 'model-rationale':
                  currentAgent.modelRationale = kv.value;
                  break;
                case 'system-prompt':
                  currentAgent.systemPrompt = kv.value;
                  break;
                case 'used in':
                  currentAgent.usedIn = kv.value;
                  break;
                case 'note':
                  currentAgent.note = kv.value;
                  break;
              }
            }
            currentProperty = null;
            break;
          }
          case 'provider-config': {
            // Provider-Config is a nested structure, initialize it
            // Sub-properties will be parsed from following indented lines
            currentAgent.providerConfig = {};
            currentProperty = 'provider-config';
            break;
          }
        }
      } else {
        // Check for indented list items (multi-line property values)
        const indentedItem = parseIndentedListItem(line);
        if (indentedItem && currentProperty) {
          if (currentProperty === 'responsibilities') {
            if (!currentAgent.responsibilities) {
              currentAgent.responsibilities = [];
            }
            currentAgent.responsibilities.push(indentedItem);
          } else if (currentProperty === 'tools') {
            if (!currentAgent.tools) {
              currentAgent.tools = [];
            }
            currentAgent.tools.push(indentedItem);
          } else if (currentProperty === 'provider-config') {
            // Parse provider-config sub-properties (key: value or key: item1, item2)
            // Note: providerConfig is guaranteed to exist here since it's initialized
            // when currentProperty is set to 'provider-config' (see case above)
            const colonIdx = indentedItem.indexOf(':');
            if (colonIdx > 0) {
              const key = indentedItem.slice(0, colonIdx).trim().toLowerCase();
              const value = indentedItem.slice(colonIdx + 1).trim();

              if (key === 'sub-agents' || key === 'subagents') {
                // Parse comma-separated list of sub-agents
                currentAgent.providerConfig!.subAgents = value
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean);
              } else if (key === 'delegation') {
                currentAgent.providerConfig!.delegation =
                  parseBooleanConfig(value);
              } else if (
                key === 'disable-compound-engineering' ||
                key === 'disablecompoundengineering'
              ) {
                currentAgent.providerConfig!.disableCompoundEngineering =
                  parseBooleanConfig(value);
              }
            }
          }
        } else if (line.startsWith('- ') || line.startsWith('* ')) {
          // Non-indented list item that doesn't match a known property
          // Reset current property state but don't silently add to responsibilities
          // to avoid misinterpreting custom properties or notes
          currentProperty = null;
        }
      }
      continue;
    }

    // Accumulate section content
    if (currentSection && !currentAgent) {
      sectionContent.push(line);
    }
  }

  // Save last agent and section
  saveCurrentAgent();
  if (currentSection && sectionContent.length > 0) {
    const sectionText = sectionContent.join('\n').trim();
    if (currentSection === 'pipeline flow') {
      result.pipelineFlow = sectionText;
    } else if (currentSection === 'conventions') {
      result.conventions = parseConventions(sectionText);
    } else {
      result.customSections[currentSection] = sectionText;
    }
  }

  return result;
}

/**
 * Parse conventions section into key-value pairs
 */
function parseConventions(content: string): Record<string, string> {
  const conventions: Record<string, string> = {};
  const lines = content.split('\n');

  for (const line of lines) {
    const kv = parseKeyValue(line);
    if (kv) {
      conventions[kv.key] = kv.value;
    }
  }

  return conventions;
}

/**
 * Validate parsed agents configuration
 */
export function validateParsedAgents(
  config: ParsedAgentsConfig,
  mode: ValidationMode = 'strict'
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // Check for at least one agent
  if (config.agents.length === 0) {
    issues.push({
      severity: 'error',
      path: 'agents',
      message: 'No agent definitions found',
      suggestion: 'Add agent definitions using "### role-name" headers',
    });
    return issues;
  }

  // Validate each agent
  for (const agent of config.agents) {
    // Check role validity
    if (!agent.isValidRole) {
      const closest = getClosestMatch(agent.role, AGENT_ROLES);
      issues.push({
        severity: mode === 'lenient' ? 'warning' : 'error',
        path: `agents.${agent.role}`,
        message: `Unknown agent role '${agent.role}' at line ${agent.lineNumber}`,
        value: agent.role,
        suggestion: closest
          ? `Did you mean '${closest}'?`
          : `Valid roles: ${AGENT_ROLES.join(', ')}`,
      });
    }

    // Check for missing purpose
    if (!agent.purpose) {
      issues.push({
        severity: 'warning',
        path: `agents.${agent.role}.purpose`,
        message: `Agent '${agent.role}' is missing a purpose description`,
        suggestion: 'Add "- **Purpose**: description" to the agent definition',
      });
    }

    // Check for missing tools (informational)
    if (!agent.tools || agent.tools.length === 0) {
      issues.push({
        severity: 'info',
        path: `agents.${agent.role}.tools`,
        message: `Agent '${agent.role}' has no tools defined`,
        suggestion:
          'Consider adding "- **Tools**: tool1, tool2" to define available tools',
      });
    }

    // Validate provider if specified
    if (agent.provider && !agent.isValidProvider) {
      issues.push(
        createProviderValidationIssue(
          agent.role,
          'provider',
          agent.provider,
          mode
        )
      );
    }

    // Validate fallback provider if specified
    if (agent.fallbackProvider && !agent.isValidFallbackProvider) {
      issues.push(
        createProviderValidationIssue(
          agent.role,
          'fallback-provider',
          agent.fallbackProvider,
          mode
        )
      );
    }

    // Validate model if specified
    if (agent.model && !agent.isValidModel) {
      issues.push(
        createModelValidationIssue(
          agent.role,
          agent.model,
          mode,
          agent.lineNumber
        )
      );
    }

    // Add cost warning for expensive models
    if (agent.model && agent.isValidModel) {
      const costInfo = getModelCostInfo(agent.model);
      if (costInfo) {
        const costWarning = createCostWarningIssue(
          agent.role,
          agent.model,
          costInfo,
          agent.lineNumber
        );
        if (costWarning) {
          issues.push(costWarning);
        }
      }
    }

    // Validate model-provider compatibility
    if (
      agent.provider &&
      agent.isValidProvider &&
      agent.model &&
      agent.isValidModel
    ) {
      const compatibilityIssue = createModelProviderCompatibilityIssue(
        agent.role,
        agent.provider,
        agent.model,
        mode,
        agent.lineNumber
      );
      if (compatibilityIssue) {
        issues.push(compatibilityIssue);
      }
    }

    // Validate subAgents if specified
    if (agent.providerConfig?.subAgents) {
      const invalidAgents = agent.providerConfig.subAgents.filter(
        (sa: string) => !SUB_AGENT_TYPES.includes(sa as SubAgentType)
      );

      if (invalidAgents.length > 0) {
        issues.push({
          severity: mode === 'lenient' ? 'warning' : 'error',
          path: `agents.${agent.role}.providerConfig.subAgents`,
          message: `Invalid sub-agent type(s): ${invalidAgents.join(', ')}`,
          value: agent.providerConfig.subAgents.join(', '),
          suggestion: `Valid sub-agent types: ${SUB_AGENT_TYPES.join(', ')}`,
        });
      }
    }

    // Warn if providerConfig settings are used with non-claude-code providers
    if (
      agent.provider &&
      agent.provider !== 'claude-code' &&
      agent.providerConfig
    ) {
      if (agent.providerConfig.subAgents) {
        issues.push({
          severity: 'warning',
          path: `agents.${agent.role}.providerConfig.subAgents`,
          message: `subAgents configuration has no effect for provider '${agent.provider}' (only affects claude-code)`,
        });
      }
      if (agent.providerConfig.disableCompoundEngineering !== undefined) {
        issues.push({
          severity: 'warning',
          path: `agents.${agent.role}.providerConfig.disableCompoundEngineering`,
          message: `disableCompoundEngineering configuration has no effect for provider '${agent.provider}' (only affects claude-code)`,
        });
      }
      if (agent.providerConfig.delegation !== undefined) {
        issues.push({
          severity: 'warning',
          path: `agents.${agent.role}.providerConfig.delegation`,
          message: `delegation configuration has no effect for provider '${agent.provider}' (only affects claude-code)`,
        });
      }
    }
  }

  // Check for duplicate roles
  const roleCounts = new Map<string, number>();
  for (const agent of config.agents) {
    const count = roleCounts.get(agent.role) || 0;
    roleCounts.set(agent.role, count + 1);
  }

  for (const [role, count] of roleCounts) {
    if (count > 1) {
      issues.push({
        severity: 'warning',
        path: `agents.${role}`,
        message: `Agent role '${role}' is defined ${count} times`,
        suggestion: 'Remove duplicate definitions to avoid confusion',
      });
    }
  }

  return issues;
}

/**
 * Get all valid agent roles
 */
export function getValidAgentRoles(): readonly string[] {
  return AGENT_ROLES;
}

/**
 * Check if a role is valid
 */
export function isValidAgentRole(role: string): role is AgentRole {
  return AGENT_ROLES.includes(role as AgentRole);
}

/**
 * Convert parsed agents to AgentConfig array for runtime use
 */
export function toAgentConfigs(parsed: ParsedAgentsConfig): Array<{
  role: AgentRole;
  name: string;
  description: string;
  tools: string[];
  output?: string;
  provider?: BackendType;
  providerRationale?: string;
  fallbackProvider?: BackendType;
  model?: string;
  modelRationale?: string;
  systemPrompt?: string;
  providerConfig?: ProviderConfig;
}> {
  return parsed.agents
    .filter((agent) => agent.isValidRole)
    .map((agent) => ({
      role: agent.role as AgentRole,
      name: agent.role,
      description: agent.purpose || '',
      tools: agent.tools || [],
      output: agent.output,
      provider: agent.isValidProvider
        ? (agent.provider as BackendType)
        : undefined,
      providerRationale: agent.providerRationale,
      fallbackProvider: agent.isValidFallbackProvider
        ? (agent.fallbackProvider as BackendType)
        : undefined,
      // Only include model if it's valid
      model: agent.isValidModel ? agent.model : undefined,
      modelRationale: agent.modelRationale,
      systemPrompt: agent.systemPrompt,
      providerConfig: agent.providerConfig,
    }));
}

/**
 * Generate a minimal valid AGENTS.md template
 */
export function generateAgentsMdTemplate(): string {
  return `# Agents Configuration

## Agent Roles

### orchestrator
- **Purpose**: Coordinate the pipeline, make decisions on workflow mode
- **Responsibilities**: Input parsing, mode selection, pipeline management
- **Tools**: GitHub CLI
- **Provider**: claude-code
- **Model**: sonnet
- **Model-Rationale**: Good balance of speed and reasoning for orchestration
- **Provider-Rationale**: Strong reasoning and orchestration capabilities
- **Fallback-Provider**: codex

### developer
- **Purpose**: Strategic design and code implementation
- **Responsibilities**: Architecture, design decisions, feature implementation, bug fixes, code changes
- **Tools**: Codebase read, codebase edit, test runner, docs search
- **Provider**: claude-code
- **Model**: sonnet
- **Model-Rationale**: Balanced reasoning for both strategic planning and implementation
- **Provider-Rationale**: Strong reasoning and code generation capabilities
- **Fallback-Provider**: codex

### code-reviewer
- **Purpose**: Comprehensive code review with fidelity-based multi-pass execution
- **Responsibilities**: Line-by-line review, touch point analysis, multi-pass review
- **Tools**: Codebase read, static analysis
- **Provider**: codex
- **Model**: gpt-5.6-terra
- **Model-Rationale**: ChatGPT subscription compatible; strong reasoning for reviews
- **Provider-Rationale**: Independent perspective prevents self-deception
- **Fallback-Provider**: claude-code

### code-judge
- **Purpose**: Final quality evaluation, verdict determination, GitHub issue management
- **Responsibilities**: Quality assessment, ENUM verdict, iteration decisions
- **Tools**: All pipeline outputs
- **Provider**: claude-code
- **Model**: opus
- **Model-Rationale**: Complex reasoning required for final quality decisions
- **Provider-Rationale**: Complex decision making and reasoning
- **Fallback-Provider**: codex

## Pipeline Flow

\`\`\`
orchestrator → developer (strategize) → test-creator → code-reviewer → developer (implement) → static-analyzer → code-judge → [ITERATE: back to implement | PROCEED: to docs/PR]
\`\`\`

## Conventions

- **Branch naming**: \`feature/\`, \`fix/\`, \`refactor/\`
- **Commit style**: Imperative mood with scope prefix
- **Coverage target**: ≥80%
`;
}

/**
 * Get all valid sub-agent types for compound engineering
 */
export function getValidSubAgentTypes(): readonly string[] {
  return SUB_AGENT_TYPES;
}

/**
 * Check if a sub-agent type is valid
 */
export function isValidSubAgentType(type: string): type is SubAgentType {
  return SUB_AGENT_TYPES.includes(type as SubAgentType);
}

/**
 * Get all valid model identifiers (aliases and full IDs)
 */
export function getValidModels(): readonly string[] {
  return VALID_MODELS;
}

/**
 * Common OpenAI model names derived dynamically from OPENAI_PRICING
 * Filters out legacy models to show only current primary models
 */
const COMMON_OPENAI_MODELS = Object.keys(OPENAI_PRICING).filter(
  (model) => !(LEGACY_OPENAI_MODELS as readonly string[]).includes(model)
);

/**
 * Get common model aliases for display (user-friendly subset)
 * Uses explicitly defined primary aliases for Anthropic models
 * and common OpenAI models from OPENAI_PRICING
 */
export function getCommonModelAliases(): readonly string[] {
  // Use explicitly defined primary Anthropic aliases (future-proof)
  // Combined with common OpenAI models
  return [...PRIMARY_ANTHROPIC_ALIASES, ...COMMON_OPENAI_MODELS];
}

// --- Legacy-compatible agent loading (migrated from agents-loader.ts) ---

/**
 * Agent definition in Map-based format for backward compatibility
 */
export interface ParsedAgentDef {
  role: AgentRole;
  purpose: string;
  responsibilities: string[];
  tools: string[];
  output: string;
  usedIn?: string;
  systemPrompt?: string;
  note?: string;
  provider?: BackendType;
  fallbackProvider?: BackendType;
  model?: string;
  modelRationale?: string;
  providerConfig?: ProviderConfig;
}

/**
 * Result of parsing AGENTS.md with Map-based agent lookup
 */
export interface AgentsParseResult {
  agents: Map<AgentRole, ParsedAgentDef>;
  missingRoles: AgentRole[];
  validationIssues: ValidationIssue[];
}

/**
 * Convert a ParsedAgentDefinition to ParsedAgentDef format
 */
function toAgentDef(def: ParsedAgentDefinition): ParsedAgentDef | null {
  if (!def.isValidRole) return null;

  return {
    role: def.role as AgentRole,
    purpose: def.purpose || '',
    responsibilities: def.responsibilities || [],
    tools: def.tools || [],
    output: def.output || '',
    usedIn: def.usedIn,
    systemPrompt: def.systemPrompt,
    note: def.note,
    provider: def.isValidProvider ? (def.provider as BackendType) : undefined,
    fallbackProvider: def.isValidFallbackProvider
      ? (def.fallbackProvider as BackendType)
      : undefined,
    model: def.isValidModel ? def.model : undefined,
    modelRationale: def.modelRationale,
    providerConfig: def.providerConfig,
  };
}

/**
 * Load and parse an AGENTS.md file from disk, returning Map-based format
 */
export function loadAgentsDefs(filePath: string): AgentsParseResult | null {
  if (!existsSync(filePath)) {
    logger.warn(`AGENTS.md not found at: ${filePath}`);
    return null;
  }

  logger.debug(`[AGENTS.md] Loading from: ${filePath}`);

  try {
    const content = readFileSync(filePath, 'utf-8');
    const parsed = parseAgentsMd(content);
    const validationIssues = validateParsedAgents(parsed);
    const agents = new Map<AgentRole, ParsedAgentDef>();

    for (const def of parsed.agents) {
      const agentDef = toAgentDef(def);
      if (agentDef) {
        agents.set(agentDef.role, agentDef);
      }
    }

    const missingRoles = AGENT_ROLES.filter((role) => !agents.has(role));
    if (missingRoles.length > 0) {
      logger.warn(
        `AGENTS.md at ${filePath} is missing definitions for: ${missingRoles.join(', ')}. These agents will use built-in default configurations.`
      );
    }

    logger.debug(`[AGENTS.md] Loaded ${agents.size} agents`);
    return { agents, missingRoles, validationIssues };
  } catch (error) {
    logger.error(
      `Failed to read AGENTS.md: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}
