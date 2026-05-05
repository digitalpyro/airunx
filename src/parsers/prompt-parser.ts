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

  async parse(input: string): Promise<ParsedInput> {
    // Try to extract a title from the first line or sentence
    const firstLine = input.split('\n')[0].trim();
    const title =
      firstLine.length > 100 ? firstLine.substring(0, 100) + '...' : firstLine;

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
