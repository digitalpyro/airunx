/**
 * Tests for PRD Parser
 * Validates parsing of Product Requirements Document markdown files
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PRDParser } from '../../src/parsers/prd-parser.js';
import * as fs from 'fs';
import * as path from 'path';

// Mock fs module
vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
}));

vi.mock('path', async () => {
  const actual = await vi.importActual('path');
  return {
    ...actual,
    resolve: vi.fn((p: string) => `/resolved/${p}`),
  };
});

describe('PRD Parser', () => {
  let parser: PRDParser;

  beforeEach(() => {
    parser = new PRDParser();
    vi.clearAllMocks();
  });

  describe('canParse', () => {
    it('should recognize .md files', () => {
      expect(parser.canParse('document.md')).toBe(true);
      expect(parser.canParse('/path/to/file.md')).toBe(true);
      expect(parser.canParse('README.md')).toBe(true);
    });

    it('should reject URLs even with .md extension', () => {
      expect(parser.canParse('http://example.com/doc.md')).toBe(false);
      expect(parser.canParse('https://example.com/doc.md')).toBe(false);
    });

    it('should reject non-.md files', () => {
      expect(parser.canParse('document.txt')).toBe(false);
      expect(parser.canParse('file.pdf')).toBe(false);
      expect(parser.canParse('README')).toBe(false);
    });
  });

  describe('parse - Basic Parsing', () => {
    it('should parse PRD with title and sections', async () => {
      const content = `# Product Requirements

## Overview
This is the overview section.

## Features
- Feature 1
- Feature 2

## Requirements
- Requirement 1
- Requirement 2
`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(content);

      const result = await parser.parse('test.md');

      expect(result.type).toBe('prd');
      expect(result.title).toBe('Product Requirements');
      expect(result.description).toBe(content);
      expect(result.context).toHaveProperty('filePath');
      expect(result.context).toHaveProperty('sections');
      expect(result.metadata?.source).toBe('prd');
    });

    it('should use default title when no heading found', async () => {
      const content = `This is a PRD without a title heading.

Just some content.`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(content);

      const result = await parser.parse('test.md');

      expect(result.title).toBe('Untitled PRD');
    });

    it('should throw error when file does not exist', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      await expect(parser.parse('nonexistent.md')).rejects.toThrow(
        'File not found: nonexistent.md'
      );
    });

    it('should resolve file path when not absolute', async () => {
      const content = `# Test PRD`;

      vi.mocked(fs.existsSync).mockImplementation((path: any) => {
        return path === '/resolved/relative.md';
      });
      vi.mocked(fs.readFileSync).mockReturnValue(content);

      await parser.parse('relative.md');

      expect(path.resolve).toHaveBeenCalledWith('relative.md');
    });
  });

  describe('parse - Section Extraction', () => {
    it('should extract multiple sections', async () => {
      const content = `# Main Title

## Section 1
Content of section 1

## Section 2
Content of section 2

### Subsection 2.1
Nested content

## Section 3
Content of section 3
`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(content);

      const result = await parser.parse('test.md');

      expect(result.context?.sections).toEqual([
        'Main Title',
        'Section 1',
        'Section 2',
        'Subsection 2.1',
        'Section 3',
      ]);
      expect(result.metadata?.sections).toBe(5);
    });

    it('should handle PRD with no sections', async () => {
      const content = `Just plain text without any headings.`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(content);

      const result = await parser.parse('test.md');

      expect(result.context?.sections).toEqual([]);
    });
  });

  describe('parse - Feature Extraction', () => {
    it('should extract features with "Feature:" pattern', async () => {
      const content = `# PRD

## Features
- Feature: User authentication
- Feature: Password reset
- Feature: Two-factor auth
`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(content);

      const result = await parser.parse('test.md');

      expect(result.context?.features).toEqual([
        'User authentication',
        'Password reset',
        'Two-factor auth',
      ]);
      expect(result.metadata?.hasFeatures).toBe(true);
    });

    it('should extract features with bold "**Feature**:" pattern', async () => {
      const content = `# PRD

- **Feature**: Admin dashboard
- **Feature**: Report generation
`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(content);

      const result = await parser.parse('test.md');

      expect(result.context?.features).toEqual([
        'Admin dashboard',
        'Report generation',
      ]);
    });

    it('should extract features with "F1:", "F2:" pattern', async () => {
      const content = `# PRD

- F1: First feature
- F2: Second feature
- F3: Third feature
`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(content);

      const result = await parser.parse('test.md');

      expect(result.context?.features).toEqual([
        'First feature',
        'Second feature',
        'Third feature',
      ]);
    });

    it('should not include features key when no features found', async () => {
      const content = `# PRD

Just some content without features.
`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(content);

      const result = await parser.parse('test.md');

      expect(result.context).not.toHaveProperty('features');
      expect(result.metadata?.hasFeatures).toBe(false);
    });
  });

  describe('parse - Requirement Extraction', () => {
    it('should extract requirements with "Requirement:" pattern', async () => {
      const content = `# PRD

## Requirements
- Requirement: System must support 1000 concurrent users
- Requirement: Response time under 200ms
`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(content);

      const result = await parser.parse('test.md');

      expect(result.context?.requirements).toEqual([
        'System must support 1000 concurrent users',
        'Response time under 200ms',
      ]);
      expect(result.metadata?.hasRequirements).toBe(true);
    });

    it('should extract requirements with bold "**Requirement**:" pattern', async () => {
      const content = `# PRD

- **Requirement**: Must be accessible
- **Requirement**: Must support mobile devices
`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(content);

      const result = await parser.parse('test.md');

      expect(result.context?.requirements).toEqual([
        'Must be accessible',
        'Must support mobile devices',
      ]);
    });

    it('should extract requirements with "R1:", "R2:" pattern', async () => {
      const content = `# PRD

- R1: First requirement
- R2: Second requirement
`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(content);

      const result = await parser.parse('test.md');

      expect(result.context?.requirements).toEqual([
        'First requirement',
        'Second requirement',
      ]);
    });

    it('should extract requirements with "MUST:" pattern', async () => {
      const content = `# PRD

- MUST: Support HTTPS
- MUST: Implement rate limiting
`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(content);

      const result = await parser.parse('test.md');

      expect(result.context?.requirements).toEqual([
        'Support HTTPS',
        'Implement rate limiting',
      ]);
    });

    it('should extract requirements with "SHOULD:" pattern', async () => {
      const content = `# PRD

- SHOULD: Cache API responses
- SHOULD: Provide audit logs
`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(content);

      const result = await parser.parse('test.md');

      expect(result.context?.requirements).toEqual([
        'Cache API responses',
        'Provide audit logs',
      ]);
    });

    it('should not include requirements key when no requirements found', async () => {
      const content = `# PRD

Just some content without requirements.
`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(content);

      const result = await parser.parse('test.md');

      expect(result.context).not.toHaveProperty('requirements');
      expect(result.metadata?.hasRequirements).toBe(false);
    });
  });

  describe('parse - Context Building', () => {
    it('should include word count in context', async () => {
      const content = `# PRD

This is a test document with exactly ten words here.
`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(content);

      const result = await parser.parse('test.md');

      expect(result.context?.wordCount).toBe(13); // Counting all words including heading
    });

    it('should include file path in metadata', async () => {
      const content = `# Test PRD`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(content);

      const result = await parser.parse('/full/path/to/test.md');

      expect(result.metadata?.filePath).toBe('/full/path/to/test.md');
    });
  });

  describe('parse - Complex PRD', () => {
    it('should parse complex PRD with all elements', async () => {
      const content = `# Comprehensive Product Requirements

## Overview
This is a comprehensive PRD with multiple elements.

## Features
- Feature: User management system
- F1: Role-based access control
- **Feature**: Audit logging

## Requirements
- Requirement: Support 10k concurrent users
- R1: 99.9% uptime SLA
- MUST: Encrypt sensitive data
- SHOULD: Provide backup functionality

## Technical Specifications
Additional technical details here.

### Database
- PostgreSQL 14+

### API Design
- RESTful API
- GraphQL support
`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(content);

      const result = await parser.parse('complex.md');

      expect(result.title).toBe('Comprehensive Product Requirements');
      expect(result.context?.features).toHaveLength(3);
      expect(result.context?.requirements).toHaveLength(4);
      expect(result.context?.sections).toHaveLength(7); // Title + 6 headings
      expect(result.metadata?.hasFeatures).toBe(true);
      expect(result.metadata?.hasRequirements).toBe(true);
    });
  });
});
