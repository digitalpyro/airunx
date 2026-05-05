/**
 * Redaction module tests
 * Validates secret scrubbing patterns and sensitive key detection
 */

import { describe, it, expect } from 'vitest';
import { redactSecrets, isSensitiveKey } from '../../src/utils/redaction.js';

describe('redactSecrets', () => {
  describe('Anthropic keys', () => {
    it('redacts sk-ant- prefixed keys', () => {
      const input = 'key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456';
      const result = redactSecrets(input);
      expect(result).toBe('key: sk-a****');
      expect(result).not.toContain('abcdefghijklmnopqrstuvwxyz');
    });
  });

  describe('OpenAI keys', () => {
    it('redacts sk- prefixed keys (20+ chars)', () => {
      const input = 'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrst';
      const result = redactSecrets(input);
      expect(result).toContain('sk-p****');
      expect(result).not.toContain('abcdefghijklmnopqrst');
    });

    it('does not redact short sk- strings', () => {
      const input = 'sk-short';
      expect(redactSecrets(input)).toBe('sk-short');
    });
  });

  describe('AWS keys', () => {
    it('redacts AWS access key IDs', () => {
      const input = 'aws_access_key_id = AKIAIOSFODNN7EXAMPLE';
      const result = redactSecrets(input);
      expect(result).toContain('AKIA****');
      expect(result).not.toContain('IOSFODNN7EXAMPLE');
    });
  });

  describe('GitHub tokens', () => {
    it('redacts GitHub PATs (ghp_)', () => {
      const input = 'token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij';
      const result = redactSecrets(input);
      expect(result).toContain('ghp_****');
      expect(result).not.toContain('ABCDEFGHIJKLMNOP');
    });

    it('redacts GitHub OAuth tokens (gho_)', () => {
      const input = 'gho_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij';
      const result = redactSecrets(input);
      expect(result).toContain('gho_****');
    });
  });

  describe('Slack tokens', () => {
    it('redacts xoxb- bot tokens', () => {
      const input = 'SLACK_TOKEN=xoxb-123456789-abcdefghijk';
      const result = redactSecrets(input);
      expect(result).toContain('xoxb****');
      expect(result).not.toContain('123456789');
    });

    it('redacts xoxp- user tokens', () => {
      const input = 'xoxp-user-token-value';
      const result = redactSecrets(input);
      expect(result).toContain('xoxp****');
    });
  });

  describe('npm tokens', () => {
    it('redacts npm tokens', () => {
      const input = 'npm_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij';
      const result = redactSecrets(input);
      expect(result).toContain('npm_****');
    });
  });

  describe('JWT tokens', () => {
    it('redacts JWT tokens', () => {
      const header = Buffer.from('{"alg":"HS256"}').toString('base64url');
      const payload = Buffer.from('{"sub":"1234"}').toString('base64url');
      const sig = 'signature-value-here';
      const jwt = `${header}.${payload}.${sig}`;
      const input = `Authorization: Bearer ${jwt}`;
      const result = redactSecrets(input);
      expect(result).toContain('eyJh****');
      expect(result).not.toContain(payload);
    });
  });

  describe('multiple secrets in one string', () => {
    it('redacts all secrets in a single pass', () => {
      const input =
        'API_KEY=sk-ant-api03-abc123def456 GITHUB=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij';
      const result = redactSecrets(input);
      expect(result).toContain('sk-a****');
      expect(result).toContain('ghp_****');
      expect(result).not.toContain('abc123def456');
    });
  });

  describe('no secrets', () => {
    it('returns input unchanged when no secrets present', () => {
      const input = 'Just a normal log message with no secrets';
      expect(redactSecrets(input)).toBe(input);
    });

    it('handles empty string', () => {
      expect(redactSecrets('')).toBe('');
    });
  });
});

describe('isSensitiveKey', () => {
  it('identifies sensitive keys', () => {
    expect(isSensitiveKey('token')).toBe(true);
    expect(isSensitiveKey('secret')).toBe(true);
    expect(isSensitiveKey('password')).toBe(true);
    expect(isSensitiveKey('authorization')).toBe(true);
    expect(isSensitiveKey('api_key')).toBe(true);
    expect(isSensitiveKey('apiKey')).toBe(true);
    expect(isSensitiveKey('access_token')).toBe(true);
    expect(isSensitiveKey('accessToken')).toBe(true);
  });

  it('is case insensitive', () => {
    expect(isSensitiveKey('TOKEN')).toBe(true);
    expect(isSensitiveKey('Password')).toBe(true);
    expect(isSensitiveKey('API_KEY')).toBe(true);
  });

  it('rejects non-sensitive keys', () => {
    expect(isSensitiveKey('key')).toBe(false); // too broad
    expect(isSensitiveKey('primaryKey')).toBe(false);
    expect(isSensitiveKey('name')).toBe(false);
    expect(isSensitiveKey('value')).toBe(false);
    expect(isSensitiveKey('model')).toBe(false);
  });
});
