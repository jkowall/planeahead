import { describe, expect, it, vi } from 'vitest';
import {
  MissingCryptoError,
  UUID_V7_RE,
  createUuidv7Generator,
  isUuidv7,
  uuidv7,
  uuidv7Timestamp,
} from '../src/ids';

describe('uuidv7', () => {
  it('matches the RFC 9562 version 7 layout', () => {
    const id = uuidv7();
    expect(id).toMatch(UUID_V7_RE);
    expect(isUuidv7(id)).toBe(true);
    expect(isUuidv7('00000000-0000-4000-8000-000000000000')).toBe(false);
  });

  it('sets the version nibble to 7 and the variant bits to 10', () => {
    for (let i = 0; i < 50; i += 1) {
      const id = uuidv7();
      expect(id.charAt(14)).toBe('7');
      expect(['8', '9', 'a', 'b']).toContain(id.charAt(19));
    }
  });

  it('embeds the injected clock in the first 48 bits', () => {
    const at = Date.UTC(2026, 8, 19, 12, 0, 0);
    const generate = createUuidv7Generator(() => at);
    expect(uuidv7Timestamp(generate())).toBe(at);
  });

  it('is strictly monotonic inside one millisecond, across counter overflow', () => {
    const generate = createUuidv7Generator(() => 5_000);
    const ids = Array.from({ length: 5_000 }, () => generate());
    for (let i = 1; i < ids.length; i += 1) {
      expect(ids[i]! > ids[i - 1]!).toBe(true);
    }
    // 5000 ids at a 12-bit counter must have bumped the timestamp at least once.
    expect(uuidv7Timestamp(ids[0]!)).toBe(5_000);
    expect(uuidv7Timestamp(ids[ids.length - 1]!)).toBeGreaterThanOrEqual(5_001);
    expect(uuidv7Timestamp(ids[ids.length - 1]!)).toBeLessThanOrEqual(5_003);
  });

  it('seeds the counter with the top bit clear so 2048 ids fit in one millisecond', () => {
    for (let round = 0; round < 20; round += 1) {
      const generate = createUuidv7Generator(() => 7_000 + round);
      const first = generate();
      const counter = Number.parseInt(first.slice(15, 18), 16);
      expect(counter).toBeLessThan(0x800);
    }
  });

  it('is time-ordered across milliseconds', () => {
    let now = 1_000;
    const generate = createUuidv7Generator(() => now);
    const first = generate();
    now = 2_000;
    const second = generate();
    expect(first < second).toBe(true);
    expect(uuidv7Timestamp(second) - uuidv7Timestamp(first)).toBe(1_000);
  });

  it('never regresses when the clock runs backwards', () => {
    let now = 2_000;
    const generate = createUuidv7Generator(() => now);
    const first = generate();
    now = 1_000;
    const second = generate();
    expect(second > first).toBe(true);
    expect(uuidv7Timestamp(second)).toBe(2_000);
  });

  it('reseeds the counter when the millisecond changes', () => {
    let now = 10_000;
    const generate = createUuidv7Generator(() => now);
    const counters = new Set<string>();
    for (let i = 0; i < 64; i += 1) {
      now += 1;
      counters.add(generate().slice(15, 18));
    }
    expect(counters.size).toBeGreaterThan(8);
  });

  it('fills rand_b with fresh randomness for every id', () => {
    const generate = createUuidv7Generator(() => 3_000);
    const a = generate();
    const b = generate();
    expect(a.slice(20)).not.toBe(b.slice(20));
  });

  it('rejects clock values outside 0..2^48-1', () => {
    expect(() => createUuidv7Generator(() => -1)()).toThrow(RangeError);
    expect(() => createUuidv7Generator(() => 2 ** 48)()).toThrow(RangeError);
    expect(() => createUuidv7Generator(() => Number.NaN)()).toThrow(RangeError);
  });

  it('uuidv7Timestamp rejects anything that is not a v7 id', () => {
    expect(() => uuidv7Timestamp('not-an-id')).toThrow(TypeError);
  });

  it('throws MissingCryptoError when crypto.getRandomValues is unavailable', () => {
    vi.stubGlobal('crypto', undefined);
    try {
      expect(() => uuidv7()).toThrow(MissingCryptoError);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(uuidv7()).toMatch(UUID_V7_RE);
  });

  it('the shared default generator honours an injected clock that is ahead', () => {
    const future = Date.UTC(2100, 0, 1);
    expect(uuidv7Timestamp(uuidv7(() => future))).toBe(future);
  });
});
