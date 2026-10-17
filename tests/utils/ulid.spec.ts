/**
 * ULID generator tests
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Reference 10-digit Crockford encoding of a millisecond timestamp */
function encodeTime(time: number): string {
  let out = '';
  for (let i = 0, t = time; i < 10; i++, t = Math.floor(t / 32)) {
    out = ENCODING[t % 32] + out;
  }
  return out;
}

/** Fresh module instance so monotonic state does not leak between tests */
async function loadUlid(): Promise<(now?: number) => string> {
  vi.resetModules();
  return (await import('../../src/utils/ulid.js')).ulid;
}

afterEach(() => {
  vi.doUnmock('crypto');
  vi.resetModules();
});

describe('ulid', () => {
  it('is 26 Crockford base32 characters with the timestamp prefix', async () => {
    const ulid = await loadUlid();
    const id = ulid(0x0123456789);
    expect(id).toMatch(CROCKFORD);
    // 0x0123456789 = 4886718345 ms, encoded in 10 base32 digits
    expect(id.slice(0, 10)).toBe('0004HMASW9');
  });

  it('is strictly increasing and unique for a fixed time', async () => {
    const ulid = await loadUlid();
    const ids = Array.from({ length: 1000 }, () => ulid(1_700_000_000_000));
    expect(new Set(ids).size).toBe(ids.length);
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i] > ids[i - 1]).toBe(true);
    }
  });

  it('still sorts after the previous ID when the clock goes backwards', async () => {
    const ulid = await loadUlid();
    const first = ulid(1_700_000_000_000);
    const second = ulid(1_699_999_999_000);
    expect(second > first).toBe(true);
    // Keeps the last timestamp rather than the earlier clock reading
    expect(second.slice(0, 10)).toBe(first.slice(0, 10));
  });

  it('advances the timestamp by 1ms when the random part overflows', async () => {
    vi.doMock('crypto', async (importOriginal) => {
      const actual = await importOriginal<typeof import('crypto')>();
      // 31 = 'Z' in every digit: the next increment overflows
      const randomBytes = (n: number): Buffer => Buffer.alloc(n, 31);
      return { ...actual, default: { ...actual, randomBytes }, randomBytes };
    });
    const ulid = await loadUlid();
    const t = 1_700_000_000_000;
    const first = ulid(t);
    expect(first.slice(10)).toBe('Z'.repeat(16));
    const second = ulid(t);
    expect(second > first).toBe(true);
    // Timestamp moved forward by exactly one millisecond
    expect(first.slice(0, 10)).toBe(encodeTime(t));
    expect(second.slice(0, 10)).toBe(encodeTime(t + 1));
  });
});
