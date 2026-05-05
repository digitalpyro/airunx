/**
 * Parser registry and factory
 */

export { GitHubParser } from './github-parser.js';
export { PRDParser } from './prd-parser.js';
export { PromptParser } from './prompt-parser.js';
export { detectInputType } from './input-parser.js';
export type { InputParser, ParsedInput } from './input-parser.js';

import { GitHubParser } from './github-parser.js';
import { PRDParser } from './prd-parser.js';
import { PromptParser } from './prompt-parser.js';
import type { InputParser, ParsedInput } from './input-parser.js';

/**
 * Parse input automatically using the appropriate parser
 */
export async function parseInput(input: string): Promise<ParsedInput> {
  const parsers: InputParser[] = [
    new GitHubParser(),
    new PRDParser(),
    new PromptParser(), // Fallback - always last
  ];

  for (const parser of parsers) {
    if (parser.canParse(input)) {
      return await parser.parse(input);
    }
  }

  // Should never reach here since PromptParser accepts everything
  throw new Error('No parser available for input');
}
