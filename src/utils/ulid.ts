/**
 * Minimal monotonic ULID generator (https://github.com/ulid/spec)
 * 48-bit millisecond timestamp + 80 bits of randomness, Crockford base32.
 * Within the same millisecond the random part is incremented so IDs stay
 * strictly increasing (lexicographically sortable) inside one process.
 */

import { randomBytes } from 'crypto';

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LEN = 10;
const RANDOM_LEN = 16;

let lastTime = -1;
let lastRandom: number[] = [];

function encodeTime(time: number): string {
  let out = '';
  let remaining = time;
  for (let i = 0; i < TIME_LEN; i++) {
    out = ENCODING[remaining % 32] + out;
    remaining = Math.floor(remaining / 32);
  }
  return out;
}

function freshRandom(): number[] {
  const bytes = randomBytes(RANDOM_LEN);
  return Array.from(bytes, (b) => b % 32);
}

/** Increment a base32 digit array in place; returns false on overflow */
function incrementRandom(digits: number[]): boolean {
  for (let i = digits.length - 1; i >= 0; i--) {
    if (digits[i] < 31) {
      digits[i]++;
      return true;
    }
    digits[i] = 0;
  }
  return false;
}

/**
 * Generate a ULID. Monotonic within a process: IDs generated in the same
 * millisecond (or with a clock that moved backwards) sort after earlier ones.
 */
export function ulid(now: number = Date.now()): string {
  let time = now;
  if (time <= lastTime) {
    time = lastTime;
    if (!incrementRandom(lastRandom)) {
      // Random part exhausted for this millisecond — borrow the next one
      time = lastTime + 1;
      lastRandom = freshRandom();
    }
  } else {
    lastRandom = freshRandom();
  }
  lastTime = time;
  return encodeTime(time) + lastRandom.map((d) => ENCODING[d]).join('');
}
