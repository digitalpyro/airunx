/**
 * MCP (Model Context Protocol) integration helpers
 * Utilities for working with URL parsing and context formatting
 */

export interface MCPAvailability {
  github: boolean;
}

/**
 * Check which MCPs are available
 */
export async function checkMCPAvailability(): Promise<MCPAvailability> {
  return {
    github: true, // gh CLI is checked separately
  };
}

/**
 * Extract URLs from text (for detecting embedded links)
 */
export function extractUrls(text: string): {
  github: string[];
  other: string[];
} {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const urls = text.match(urlRegex) || [];

  return {
    github: urls.filter((url) => url.includes('github.com')),
    other: urls.filter((url) => !url.includes('github.com')),
  };
}

/**
 * Format issue/PR context for agent consumption
 */
export function formatContext(data: {
  title: string;
  body: string;
  labels?: string[];
  author?: string;
  url?: string;
}): string {
  return `
# Context

**Title:** ${data.title}
${data.author ? `**Author:** ${data.author}` : ''}
${data.labels && data.labels.length > 0 ? `**Labels:** ${data.labels.join(', ')}` : ''}
${data.url ? `**URL:** ${data.url}` : ''}

## Description

${data.body}
`.trim();
}
