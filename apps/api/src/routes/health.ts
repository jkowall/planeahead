/**
 * `GET /health`.
 *
 * Answers four questions with no I/O at all: is the Worker up, which environment is it, which
 * database schema was it built against, and which Durable Object schema version does this build
 * expect. The deploy smoke step curls it, so it has to stay cheap enough to run on every deploy.
 *
 * `migrationHash` is a build-time constant generated from `packages/db/migrations/meta/`
 * `_journal.json` by `scripts/gen-migration-hash.mjs`. It is not read from the database: that
 * would put a Postgres round trip on the liveness path, and `@planeahead/db/migrate` (which owns
 * the same hash function) reads the migrations folder with `node:fs` and cannot run in a Worker.
 *
 * `doSchemaVersions` reports each class's compiled-in `static SCHEMA_VERSION`, which is what this
 * build expects. It deliberately does NOT read the applied version from a live object: that would
 * mean creating six Durable Objects on every health check, including on every deploy smoke test.
 * The applied version is available per object through `ping()`.
 */

import { Hono } from 'hono';
import { MIGRATION_COUNT, MIGRATION_HASH } from '../generated/migration-hash';
import { type AppBindings, environmentName } from '../env';
import { AirportState } from '../do/airport-state';
import { DesignatorResolver } from '../do/designator-resolver';
import { FlightTracker } from '../do/flight-tracker';
import { ProviderBudget } from '../do/provider-budget';
import { PushAuth } from '../do/push-auth';
import { UserInbox } from '../do/user-inbox';

export const DO_SCHEMA_VERSIONS = Object.freeze({
  FlightTracker: FlightTracker.SCHEMA_VERSION,
  DesignatorResolver: DesignatorResolver.SCHEMA_VERSION,
  AirportState: AirportState.SCHEMA_VERSION,
  UserInbox: UserInbox.SCHEMA_VERSION,
  ProviderBudget: ProviderBudget.SCHEMA_VERSION,
  PushAuth: PushAuth.SCHEMA_VERSION,
});

export const health = new Hono<AppBindings>().get('/health', (c) =>
  c.json({
    ok: true,
    environment: environmentName(c.env),
    migrationHash: MIGRATION_HASH,
    migrationCount: MIGRATION_COUNT,
    doSchemaVersions: DO_SCHEMA_VERSIONS,
  }),
);
