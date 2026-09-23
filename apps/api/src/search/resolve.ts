/**
 * The Worker-side half of a flight search (increment 7): KV in front of the DesignatorResolver,
 * and the one jittered retry on the account-level "generating too much load" error before an
 * `overloaded` answer, which the search route turns into a 503 with `Retry-After` (increment 8).
 *
 * This lives in the Worker, not in a Durable Object module (ruling L18): the retry waits with
 * `scheduler.wait`, which is fine in a request handler and would be a pending timer in an
 * object. The Durable Object modules contain no timer of any kind.
 *
 * KV first because the first `get()` on a never-used object name pays a global uniqueness check
 * of up to a few hundred milliseconds, and a search mints a new name per designator per day.
 */

import {
  RPC_SCHEMA_VERSION,
  ResolveResponseV1 as ResolveResponseSchema,
  type Exact,
  type ResolveRequestV1 as ResolveRequest,
  type ResolveResponseV1,
} from '@planeahead/shared';
import type { DesignatorResolver } from '../do/designator-resolver';
import { normalizeDesignator, searchKvKey } from '../do/designator-resolver';
import type { Env } from '../env';
import { createLogger, errorFields, type Logger } from '../observability/log';

/** `Retry-After` the search route sends when the namespace is overloaded. */
export const OVERLOADED_RETRY_AFTER_SECONDS = 2;
/** The jittered wait before the one retry: 50 to 250 ms. */
export const OVERLOAD_RETRY_MIN_MS = 50;
export const OVERLOAD_RETRY_JITTER_MS = 200;

type ResolveResponse = Exact<ResolveResponseV1>;

export interface DesignatorSearchInput {
  readonly designator: string;
  readonly dateLocal: string;
  readonly originIcao?: string | undefined;
  readonly requestId?: string | undefined;
}

export type DesignatorSearchResult =
  ResolveResponse | { readonly outcome: 'overloaded'; readonly retryAfterSeconds: number };

export interface DesignatorSearchDeps {
  /** Resolves an object name to its stub; the default is `DESIGNATOR_RESOLVER.getByName`. */
  readonly stubFor?: ((name: string) => Pick<DesignatorResolver, 'resolve'>) | undefined;
  /** The jittered wait before the one retry; a test replaces it with a no-op. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly log?: Logger | undefined;
}

/** The undocumented account-level error a namespace under load answers with. */
export function isTooMuchLoadError(error: unknown): boolean {
  return error instanceof Error && /too much load/i.test(error.message);
}

/** A request-scoped wait; never `setTimeout`, and never inside a Durable Object. */
function defaultSleep(ms: number): Promise<void> {
  return scheduler.wait(ms);
}

/**
 * The search: KV first, then the object, with one jittered retry on "generating too much
 * load" and an `overloaded` answer after that (the route sends 503 with `Retry-After`).
 */
export async function resolveDesignator(
  env: Pick<Env, 'DESIGNATOR_RESOLVER' | 'CACHE'>,
  input: DesignatorSearchInput,
  deps: DesignatorSearchDeps = {},
): Promise<DesignatorSearchResult> {
  const log = deps.log ?? createLogger();
  const designator = normalizeDesignator(input.designator);
  const name = `${designator}-${input.dateLocal}`;
  try {
    const cached: unknown = await env.CACHE.get(searchKvKey(designator, input.dateLocal), 'json');
    const parsed = ResolveResponseSchema.safeParse(cached);
    if (parsed.success) {
      return { ...parsed.data, cached: true };
    }
  } catch (error) {
    log.warn('designator_search_kv_read_failed', errorFields(error));
  }
  const stubFor =
    deps.stubFor ?? ((objectName: string) => env.DESIGNATOR_RESOLVER.getByName(objectName));
  const request: ResolveRequest = {
    rpcVersion: RPC_SCHEMA_VERSION,
    designator,
    dateLocal: input.dateLocal,
    ...(input.originIcao === undefined ? {} : { originIcao: input.originIcao }),
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
  };
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await stubFor(name).resolve(request);
    } catch (error) {
      if (!isTooMuchLoadError(error) || attempt >= 1) {
        if (isTooMuchLoadError(error)) {
          log.error('designator_search_overloaded', { name, ...errorFields(error) });
          return { outcome: 'overloaded', retryAfterSeconds: OVERLOADED_RETRY_AFTER_SECONDS };
        }
        throw error;
      }
      log.warn('designator_search_retry', { name, ...errorFields(error) });
      await (deps.sleep ?? defaultSleep)(
        OVERLOAD_RETRY_MIN_MS + Math.floor(Math.random() * OVERLOAD_RETRY_JITTER_MS),
      );
    }
  }
}
