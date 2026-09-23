/**
 * `GET /health` through the real Worker.
 *
 * The request goes through `exports.default.fetch()` from `cloudflare:workers`, not through
 * `SELF` from `cloudflare:test`: `SELF` and `cloudflare:test`'s `env` are both deprecated in
 * @cloudflare/vitest-plugin 1.1.13. `exports.default` is the loopback binding to this Worker's
 * default export, so the whole middleware chain runs exactly as it does in production.
 */

import { listDurableObjectIds } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { MIGRATION_COUNT, MIGRATION_HASH } from '../../src/generated/migration-hash';
import { REQUEST_ID_HEADER } from '../../src/middleware/request-id';

interface HealthBody {
  ok: boolean;
  environment: string;
  migrationHash: string;
  migrationCount: number;
  doSchemaVersions: Record<string, number>;
}

async function getHealth(init?: RequestInit): Promise<{ response: Response; body: HealthBody }> {
  const response = await exports.default.fetch('https://api.planeahead.test/health', init);
  const body = await response.json<HealthBody>();
  return { response, body };
}

describe('GET /health', () => {
  it('answers 200 with the documented shape', async () => {
    const { response, body } = await getHealth();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.environment).toBe('test');
    expect(body.migrationHash).toBe(MIGRATION_HASH);
    expect(body.migrationCount).toBe(MIGRATION_COUNT);
  });

  it('reports the compiled-in schema version of all five Durable Object classes', async () => {
    const { body } = await getHealth();

    // Named individually rather than compared against a snapshot: a class dropped from the
    // wrangler `exports` map must fail this test, and a snapshot would simply be updated.
    expect(body.doSchemaVersions).toEqual({
      FlightTracker: 1,
      DesignatorResolver: 2,
      AirportState: 0,
      UserInbox: 0,
      // Increment 6: the ledger, bucket, kill switch and outbox tables.
      ProviderBudget: 1,
    });
  });

  it('does no I/O: the Durable Object namespaces are untouched by a health check', async () => {
    // `listDurableObjectIds` is imported statically at the top, like every other
    // `cloudflare:test` helper in this suite. Dynamic `import()` happens to work in a test body,
    // but it does NOT work inside a Durable Object handler or `export default` handler under this
    // pool (facts sheet), and a pattern that works here and fails there is worth not copying.
    await getHealth();

    expect(await listDurableObjectIds(env.FLIGHT_TRACKER)).toHaveLength(0);
    expect(await listDurableObjectIds(env.USER_INBOX)).toHaveLength(0);
  });

  it('echoes a safe caller supplied request id', async () => {
    const { response } = await getHealth({
      headers: { [REQUEST_ID_HEADER]: 'abc12345-from-client' },
    });

    expect(response.headers.get(REQUEST_ID_HEADER)).toBe('abc12345-from-client');
  });

  it('replaces an unsafe caller supplied request id with a generated one', async () => {
    const { response } = await getHealth({ headers: { [REQUEST_ID_HEADER]: 'no' } });

    const id = response.headers.get(REQUEST_ID_HEADER);
    expect(id).not.toBe('no');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('answers a not-implemented stub for a route a later increment owns', async () => {
    const response = await exports.default.fetch('https://api.planeahead.test/v1/flights');
    const body = await response.json<{ error: string; increment: string }>();

    expect(response.status).toBe(501);
    expect(body.error).toBe('not_implemented');
    expect(body.increment).toContain('08');
  });

  it('answers 404 with a request id for an unknown path', async () => {
    const response = await exports.default.fetch('https://api.planeahead.test/nope');
    const body = await response.json<{ error: string; requestId: string }>();

    expect(response.status).toBe(404);
    expect(body.error).toBe('not_found');
    expect(body.requestId).not.toBe('unknown');
  });
});
