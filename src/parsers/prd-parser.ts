/**
 * PRD (Product Requirements Document) markdown parser
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import type { InputParser, ParsedInput } from './input-parser.js';

export class PRDParser implements InputParser {
  canParse(input: string): boolean {
    // Check if it's a file path ending in .md and not a URL
    return input.endsWith('.md') && !input.startsWith('http');
  }

  async parse(input: string): Promise<ParsedInput> {
    const filePath = existsSync(input) ? input : resolve(input);

    if (!existsSync(filePath)) {
      throw new Error(`File not found: ${input}`);
    }

    const content = readFileSync(filePath, 'utf-8');

    // Extract title (first # heading)
    const titleMatch = content.match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : 'Untitled PRD';

    // Extract sections
    const sections = this.extractSections(content);

    // Build context
    const context: Record<string, unknown> = {
      filePath,
      sections: sections.map((s) => s.title),
      wordCount: content.split(/\s+/).length,
    };

    // Try to extract key information
    const features = this.extractFeatures(content);
    if (features.length > 0) {
      context.features = features;
    }

    const requirements = this.extractRequirements(content);
    if (requirements.length > 0) {
      context.requirements = requirements;
    }

    return {
      type: 'prd',
      title,
      description: content,
      context,
      metadata: {
        source: 'prd',
        filePath,
        sections: sections.length,
        hasFeatures: features.length > 0,
        hasRequirements: requirements.length > 0,
      },
    };
  }

  /**
   * Extract markdown sections
   */
  private extractSections(content: string): Array<{
    level: number;
    title: string;
    content: string;
  }> {
    const sections: Array<{ level: number; title: string; content: string }> =
      [];
    const lines = content.split('\n');

    let currentSection: {
      level: number;
      title: string;
      content: string;
    } | null = null;

    for (const line of lines) {
      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);

      if (headingMatch) {
        // Save previous section
        if (currentSection) {
          sections.push(currentSection);
        }

        // Start new section
        currentSection = {
          level: headingMatch[1].length,
          title: headingMatch[2].trim(),
          content: '',
        };
      } else if (currentSection) {
        currentSection.content += line + '\n';
      }
    }

    // Save last section
    if (currentSection) {
      sections.push(currentSection);
    }

    return sections;
  }

  /**
   * Extract features from PRD
   */
  private extractFeatures(content: string): string[] {
    const features: string[] = [];

    // Look for common feature patterns
    const patterns = [
      /[-*]\s+Feature:\s*(.+)/gi,
      /[-*]\s+\*\*Feature\*\*:\s*(.+)/gi,
      /[-*]\s+F\d+:\s*(.+)/gi,
    ];

    for (const pattern of patterns) {
      const matches = content.matchAll(pattern);
      for (const match of matches) {
        features.push(match[1].trim());
      }
    }

    return features;
  }

  /**
   * Extract requirements from PRD
   */
  private extractRequirements(content: string): string[] {
    const requirements: string[] = [];

    // Look for common requirement patterns
    const patterns = [
      /[-*]\s+Requirement:\s*(.+)/gi,
      /[-*]\s+\*\*Requirement\*\*:\s*(.+)/gi,
      /[-*]\s+R\d+:\s*(.+)/gi,
      /[-*]\s+MUST:\s*(.+)/gi,
      /[-*]\s+SHOULD:\s*(.+)/gi,
    ];

    for (const pattern of patterns) {
      const matches = content.matchAll(pattern);
      for (const match of matches) {
        requirements.push(match[1].trim());
      }
    }

    return requirements;
  }
}
