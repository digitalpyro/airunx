/**
 * Simple prompt parser
 * For direct text prompts
 */

import type { InputParser, ParsedInput } from './input-parser.js';

export class PromptParser implements InputParser {
  canParse(_input: string): boolean {
    // This is the fallback parser, accepts anything
    return true;
  }

  /**
   * Extract a meaningful title from input content.
   * Handles YAML frontmatter (skip `---` blocks), markdown headings
   * (strip `#` prefixes), and plain text (use first non-empty line).
   */
  private extractTitle(input: string): string {
    let content = input;

    // Skip YAML frontmatter if present (starts with ---)
    if (content.startsWith('---')) {
      const endIndex = content.indexOf('---', 3);
      if (endIndex !== -1) {
        content = content.slice(endIndex + 3);
      }
    }

    // Find the first non-empty line
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Strip markdown heading prefixes (# ## ### etc.)
      const stripped = trimmed.replace(/^#{1,6}\s+/, '');
      if (!stripped) continue;

      return stripped.length > 100
        ? stripped.substring(0, 100) + '...'
        : stripped;
    }

    return '';
  }

  async parse(input: string): Promise<ParsedInput> {
    const title = this.extractTitle(input);

    return {
      type: 'prompt',
      title: title || 'Custom Prompt',
      description: input,
      context: {
        length: input.length,
        lines: input.split('\n').length,
      },
      metadata: {
        source: 'prompt',
        inputLength: input.length,
      },
    };
  }
}
