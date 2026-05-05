/**
 * JSON utility functions for extracting and parsing JSON from text
 * Used for parsing structured data from LLM responses
 */

import { parse } from 'jsonc-parser';

/**
 * Parse JSON or JSONC content (supports trailing commas and comments).
 * Returns unknown - callers should validate with Zod schemas.
 */
export function parseJsonc(content: string): unknown {
  return parse(content, [], { allowTrailingComma: true });
}

/**
 * Extract JSON objects from text using bracket-counting
 * Properly handles nested structures and brackets inside string literals
 * This is more robust than greedy regex like /\{[\s\S]*\}/
 */
export function extractJsonObjects(text: string): string[] {
  return extractJsonStructures(text, '{', '}');
}

/**
 * Extract the first valid JSON object from text
 * Returns null if no valid JSON object is found
 */
export function extractFirstJsonObject<T = unknown>(text: string): T | null {
  const objects = extractJsonObjects(text);
  for (const jsonStr of objects) {
    try {
      return JSON.parse(jsonStr) as T;
    } catch {
      // Continue to next candidate
    }
  }
  return null;
}

/**
 * Extract JSON structures (objects or arrays) using bracket-counting
 * Properly handles nested structures and brackets inside string literals
 */
function extractJsonStructures(
  text: string,
  openChar: '{' | '[',
  closeChar: '}' | ']'
): string[] {
  const structures: string[] = [];
  let i = 0;

  while (i < text.length) {
    // Find the start of a potential JSON structure
    const startIndex = text.indexOf(openChar, i);
    if (startIndex === -1) break;

    // Count brackets to find the matching closing bracket
    let bracketCount = 0;
    let inString = false;
    let escapeNext = false;
    let endIndex = -1;

    for (let j = startIndex; j < text.length; j++) {
      const char = text[j];

      if (escapeNext) {
        escapeNext = false;
        continue;
      }

      if (char === '\\' && inString) {
        escapeNext = true;
        continue;
      }

      if (char === '"' && !escapeNext) {
        inString = !inString;
        continue;
      }

      if (!inString) {
        if (char === openChar) {
          bracketCount++;
        } else if (char === closeChar) {
          bracketCount--;
          if (bracketCount === 0) {
            endIndex = j;
            break;
          }
        }
      }
    }

    if (endIndex !== -1) {
      const jsonCandidate = text.substring(startIndex, endIndex + 1);
      // Validate it's actually parseable JSON
      try {
        JSON.parse(jsonCandidate);
        structures.push(jsonCandidate);
      } catch {
        // Not valid JSON, skip
      }
      i = endIndex + 1;
    } else {
      // No matching closing bracket found, move past this opening bracket
      i = startIndex + 1;
    }
  }

  return structures;
}
