/**
 * A route's own deadline on a Durable Object call (increment 8, ruling K6).
 *
 * There is no platform timeout on a Durable Object RPC while the caller stays connected, so a
 * route that awaits one bare can hang for as long as the object takes (a provider fetch carries a
 * 30 s timeout, three billed attempts for a search). Every DO call a route makes goes through
 * `withDeadline`: a race between the call and a timer, the timer cleared whichever wins.
 *
 * `setTimeout` is fine HERE, in a Worker request handler, and is forbidden inside a Durable Object
 * module (a pending timer keeps an object from hibernating; increment 7 has none). When the timer
 * wins, the call is NOT cancelled: the object keeps working and its result lands in its own
 * storage and KV snapshot. The losing promise is handed to `waitUntil` when one is supplied, so
 * the invocation stays alive until the object answers, and its rejection is always observed so a
 * late failure never surfaces as an unhandled rejection.
 */

export type DeadlineResult<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'timeout'; readonly afterMs: number };

export interface DeadlineOptions {
  /** `c.executionCtx.waitUntil`, so a call that outlives the deadline still completes. */
  readonly waitUntil?: ((promise: Promise<unknown>) => void) | undefined;
}

export class DeadlineExceededError extends Error {
  override readonly name = 'DeadlineExceededError';

  constructor(
    readonly label: string,
    readonly afterMs: number,
  ) {
    super(`${label} did not answer within ${String(afterMs)} ms`);
  }
}

/** Races `promise` against `ms`; a rejection before the deadline is rethrown. */
export async function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  options: DeadlineOptions = {},
): Promise<DeadlineResult<T>> {
  // Observe a late rejection whatever happens below; the race keeps its own subscription.
  const settled = promise.then(
    () => undefined,
    () => undefined,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<DeadlineResult<T>>((resolve) => {
    timer = setTimeout(() => {
      resolve({ kind: 'timeout', afterMs: ms });
    }, ms);
  });
  try {
    const result = await Promise.race([
      promise.then((value): DeadlineResult<T> => ({ kind: 'ok', value })),
      timeout,
    ]);
    if (result.kind === 'timeout') {
      options.waitUntil?.(settled);
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

/** `withDeadline` for calls whose timeout is simply an error (answered 504 by the route). */
export async function callWithDeadline<T>(
  label: string,
  promise: Promise<T>,
  ms: number,
  options: DeadlineOptions = {},
): Promise<T> {
  const result = await withDeadline(promise, ms, options);
  if (result.kind === 'timeout') {
    throw new DeadlineExceededError(label, result.afterMs);
  }
  return result.value;
}
