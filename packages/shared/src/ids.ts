/**
 * UUIDv7 per RFC 9562 section 5.7, layout (128 bits, big-endian):
 *
 *   unix_ts_ms (48) | ver = 0b0111 (4) | rand_a (12) | var = 0b10 (2) | rand_b (62)
 *
 * `rand_a` carries a 12-bit monotonic counter (RFC 9562 section 6.2, method 1): it is reseeded
 * from the CSPRNG every time the millisecond changes and incremented for every id generated
 * inside the same millisecond, so ids sort in generation order even within one tick. The seed
 * keeps the top counter bit clear, which guarantees at least 2048 increments before overflow;
 * on overflow the timestamp is bumped by one millisecond instead of blocking. A clock that runs
 * backwards is treated as "same millisecond" so ordering never regresses.
 *
 * Entropy comes from `globalThis.crypto.getRandomValues`. Node 24, Workers and modern browsers
 * have it. React Native needs a polyfill (`expo-crypto` or `react-native-get-random-values`)
 * imported before this module is used; without one `uuidv7()` throws `MissingCryptoError`
 * rather than silently degrading to `Math.random`.
 */

export const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const MAX_TIMESTAMP_MS = 2 ** 48;
const COUNTER_MASK = 0x0fff;
const SEED_MASK = 0x07ff;

export class MissingCryptoError extends Error {
  override readonly name = 'MissingCryptoError';

  constructor() {
    super(
      'globalThis.crypto.getRandomValues is not available. Node 24 and Workers provide it; ' +
        'React Native needs expo-crypto or react-native-get-random-values imported first.',
    );
  }
}

interface GeneratorState {
  lastMs: number;
  counter: number;
}

export type Uuidv7Generator = (now?: () => number) => string;

/**
 * `Uint8Array<ArrayBuffer>`, not the default `ArrayBufferLike`: the DOM lib's `getRandomValues`
 * (the mobile app's view, checked by apps/api/test/consumer) refuses a view that could sit on a
 * SharedArrayBuffer.
 */
function getRandomValues(bytes: Uint8Array<ArrayBuffer>): void {
  const cryptoApi = globalThis.crypto as typeof globalThis.crypto | undefined;
  if (cryptoApi === undefined || typeof cryptoApi.getRandomValues !== 'function') {
    throw new MissingCryptoError();
  }
  cryptoApi.getRandomValues(bytes);
}

function generate(state: GeneratorState, requested: number): string {
  if (!Number.isFinite(requested) || requested < 0 || requested >= MAX_TIMESTAMP_MS) {
    throw new RangeError(`uuidv7: clock value ${String(requested)} is outside 0..2^48-1 ms`);
  }
  let ms = Math.floor(requested);

  const bytes = new Uint8Array(16);
  getRandomValues(bytes);
  const view = new DataView(bytes.buffer);
  const seed = view.getUint16(6) & SEED_MASK;

  if (ms > state.lastMs) {
    state.lastMs = ms;
    state.counter = seed;
  } else {
    // Same millisecond, or the clock went backwards: keep the last timestamp and count up.
    ms = state.lastMs;
    state.counter += 1;
    if (state.counter > COUNTER_MASK) {
      ms = state.lastMs + 1;
      state.lastMs = ms;
      state.counter = seed;
    }
  }

  view.setUint32(0, Math.floor(ms / 0x10000));
  view.setUint16(4, ms % 0x10000);
  view.setUint16(6, 0x7000 | (state.counter & COUNTER_MASK));
  view.setUint8(8, (view.getUint8(8) & 0x3f) | 0x80);

  let hex = '';
  for (let i = 0; i < 16; i += 1) {
    hex += view.getUint8(i).toString(16).padStart(2, '0');
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Builds an independent generator with its own monotonic state. Tests and long-lived isolates
 * that want ordering guarantees per clock use this; everything else uses `uuidv7()`.
 */
export function createUuidv7Generator(defaultNow: () => number = Date.now): Uuidv7Generator {
  const state: GeneratorState = { lastMs: -1, counter: 0 };
  return (now = defaultNow) => generate(state, now());
}

const defaultGenerator = createUuidv7Generator();

/**
 * Returns a new UUIDv7. `now` is the only place in `@planeahead/shared` that defaults to
 * `Date.now`; pass a clock to make ids reproducible. Monotonic state is shared across calls to
 * this function, so an injected clock that runs behind the last real timestamp is treated as
 * the same millisecond (see the module comment).
 */
export function uuidv7(now?: () => number): string {
  return defaultGenerator(now);
}

export function isUuidv7(value: string): boolean {
  return UUID_V7_RE.test(value);
}

/** Extracts the 48-bit unix millisecond timestamp embedded in a UUIDv7. */
export function uuidv7Timestamp(id: string): number {
  if (!isUuidv7(id)) {
    throw new TypeError(`uuidv7Timestamp: "${id}" is not a UUIDv7`);
  }
  return Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}
