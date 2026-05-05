/**
 * Shared redaction module for scrubbing secrets from debug output
 * String-only v1 — operates on serialized text, not structured objects
 */

// Single-pass alternation regex — most specific patterns first to avoid partial matches
const SECRET_PATTERN = new RegExp(
  [
    'sk-ant-[a-zA-Z0-9_-]+', // Anthropic keys (before generic sk-)
    'sk-[a-zA-Z0-9_-]{20,}', // OpenAI keys
    'AKIA[0-9A-Z]{16}', // AWS access key IDs
    'ghp_[a-zA-Z0-9]{36}', // GitHub PATs
    'gho_[a-zA-Z0-9]{36}', // GitHub OAuth tokens
    'xox[bp]-[a-zA-Z0-9-]+', // Slack tokens
    'npm_[A-Za-z0-9]{36}', // npm tokens
    'eyJ[A-Za-z0-9_-]+\\.eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+', // JWT tokens
  ].join('|'),
  'g'
);

/**
 * Keys whose values should be redacted when found in key-value contexts.
 * Intentionally excludes bare 'key' — too broad (matches "primaryKey", etc.)
 */
const SENSITIVE_KEYS = new Set([
  'token',
  'secret',
  'password',
  'authorization',
  'api_key',
  'apikey',
  'access_token',
  'accesstoken',
]);

/**
 * Redact secret patterns from a string.
 * Preserves the first 4 characters for identification, replaces the rest with '****'.
 */
export function redactSecrets(str: string): string {
  return str.replace(SECRET_PATTERN, (match) =>
    match.length > 4 ? match.slice(0, 4) + '****' : '****'
  );
}

/**
 * Check if a key name indicates a sensitive value that should be redacted.
 * Comparison is case-insensitive.
 */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase());
}
