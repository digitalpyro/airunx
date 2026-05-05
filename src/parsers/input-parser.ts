/**
 * Input parser interface and types
 */

import type { InputType } from '../core/types.js';

export interface ParsedInput {
  type: InputType;
  title: string;
  description: string;
  context: Record<string, unknown>;
  metadata: {
    source: string;
    author?: string;
    labels?: string[];
    url?: string;
    createdAt?: string;
    [key: string]: unknown;
  };
}

export interface InputParser {
  /**
   * Check if this parser can handle the input
   */
  canParse(input: string): boolean;

  /**
   * Parse the input into structured format
   */
  parse(input: string): Promise<ParsedInput>;
}

/**
 * Auto-detect input type
 */
export function detectInputType(input: string): InputType {
  // GitHub URL
  if (input.match(/github\.com.*\/(issues|pull)/)) {
    return 'github';
  }

  // File path ending in .md
  if (input.endsWith('.md') || input.includes('.md')) {
    return 'prd';
  }

  // Default to prompt
  return 'prompt';
}
