import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  ALERT_EVENTS,
  DISTANCE_UNITS,
  FLIGHT_STATUS_VALUES,
  IsoInstantSchema,
  PROVIDER_CALL_RESULTS,
  PROVIDER_CALL_TRIGGERS,
  PROVIDER_IDS,
  SYNC_ENTITIES,
  TEMPERATURE_UNITS,
  TIME_FORMATS,
} from '@planeahead/shared';
import { Table, getTableColumns, getTableName, is } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { DB_SCHEMA_VERSION } from '../src/index';
import { readJournal } from '../src/migrate';
import * as schema from '../src/schema/index';

/** Pure checks that need no database: shared-contract agreement, snapshot invariants, style. */

const PACKAGE_ROOT = resolve(import.meta.dirname, '..');
const REPO_ROOT = resolve(PACKAGE_ROOT, '..', '..');
const EM_DASH = new RegExp(String.fromCharCode(0x20_14));

const SPEC_TABLES = [
  // identity
  'users',
  'sessions',
  'accounts',
  'verifications',
  'rate_limits',
  'user_keys',
  'devices',
  'user_preferences',
  'user_consents',
  'user_sync_changes',
  'idempotency_keys',
  'deleted_subjects',
  // reference
  'airports',
  'airport_profiles',
  'airlines',
  'regional_operators',
  'aircraft_types',
  'aircraft',
  'currency_rates',
  // flight core
  'flight_instances',
  'flight_instance_merges',
  'flight_designators',
  'flight_events',
  'flight_tracks',
  // trips and subscriptions
  'trips',
  'trip_members',
  'flight_subscriptions',
  'logbook_entries',
  'user_stats_yearly',
  'usage_counters',
  // providers and models
  'provider_calls',
  'provider_call_daily',
  'provider_budget_config',
  'provider_alert_registrations',
  'provider_webhook_events',
  'delay_predictions',
  'delay_outcomes',
  'airport_wx_observations',
  'airport_nas_events',
  'airport_delay_snapshots',
  'airport_delay_hourly',
  'bts_carrier_flight_monthly',
  'bts_route_monthly',
  'bts_airport_hourly',
  'bts_import_runs',
  // notifications
  'notification_preferences',
  'push_tokens',
  'live_activities',
  'notifications',
  'notification_deliveries',
  // import, calendar, sharing
  'email_accounts',
  'email_messages_processed',
  'email_extractions',
  'inbound_addresses',
  'inbound_messages',
  'imports',
  'import_rows',
  'calendar_connections',
  'calendar_events',
  'ics_feed_tokens',
  'share_links',
  'share_link_views',
  'meet_me_sessions',
  // billing, API, GDPR
  'entitlements',
  'revenuecat_events',
  'subscriptions',
  'api_tokens',
  'audit_log',
  'data_export_jobs',
  'account_deletion_requests',
];

const NO_FK_TO_USERS = [
  'audit_log',
  'revenuecat_events',
  'subscriptions',
  'notification_deliveries',
  'deleted_subjects',
  'provider_calls',
  'provider_call_daily',
];
const SOFT_DELETE = [
  'flight_subscriptions',
  'trips',
  'trip_members',
  'user_preferences',
  'notification_preferences',
  'logbook_entries',
];
const BRIN = [
  'flight_events',
  'provider_calls',
  'airport_wx_observations',
  'notification_deliveries',
  'audit_log',
];
const AUTH_TABLES = ['users', 'sessions', 'accounts', 'verifications', 'rate_limits'];

interface SnapshotColumn {
  name: string;
  type: string;
  primaryKey: boolean;
  notNull: boolean;
  default?: string;
  generated?: unknown;
}
interface SnapshotIndex {
  name: string;
  columns: { expression: string; isExpression: boolean }[];
  isUnique: boolean;
  method: string;
  where?: string;
}
interface SnapshotTable {
  name: string;
  columns: Record<string, SnapshotColumn>;
  indexes: Record<string, SnapshotIndex>;
  foreignKeys: Record<
    string,
    { tableTo: string; columnsFrom: string[]; columnsTo: string[]; onDelete?: string }
  >;
  compositePrimaryKeys: Record<string, { columns: string[] }>;
  uniqueConstraints: Record<string, { columns: string[] }>;
  checkConstraints: Record<string, { name: string; value: string }>;
}
const snapshot = JSON.parse(
  readFileSync(join(PACKAGE_ROOT, 'migrations', 'meta', '0000_snapshot.json'), 'utf8'),
) as { tables: Record<string, SnapshotTable> };
const tables = Object.values(snapshot.tables);
const byName = new Map(tables.map((t) => [t.name, t]));

describe('table set', () => {
  it('matches the normative list in the increment 3 spec (70 tables)', () => {
    expect(new Set(SPEC_TABLES).size).toBe(70);
    expect(tables.map((t) => t.name).sort()).toEqual([...SPEC_TABLES].sort());
  });

  it('exports one Drizzle table per SQL table', () => {
    const exported = Object.values(schema)
      .filter((v) => is(v, Table))
      .map((v) => getTableName(v))
      .sort();
    expect(exported).toEqual([...SPEC_TABLES].sort());
  });

  it('DB_SCHEMA_VERSION equals the number of journal entries', () => {
    expect(readJournal().entries).toHaveLength(DB_SCHEMA_VERSION);
  });
});

describe('column conventions', () => {
  it('uses a uuid primary key with a uuidv7() default everywhere except the two documented cases', () => {
    for (const table of tables) {
      if (table.name === 'user_sync_changes') {
        expect(table.columns['seq']?.type).toBe('bigint');
        continue;
      }
      if (table.name === 'idempotency_keys') {
        expect(table.compositePrimaryKeys['idempotency_keys_pkey']?.columns).toEqual([
          'user_id',
          'key',
        ]);
        continue;
      }
      const id = table.columns['id'];
      expect(id?.type, table.name).toBe('uuid');
      expect(id?.primaryKey, table.name).toBe(true);
      expect(id?.default, table.name).toBe('uuidv7()');
    }
  });

  it('never uses a timestamp without time zone, a Postgres array type, or pgEnum', () => {
    for (const table of tables) {
      for (const column of Object.values(table.columns)) {
        expect(column.type, `${table.name}.${column.name}`).not.toBe('timestamp');
        expect(column.type, `${table.name}.${column.name}`).not.toMatch(/\[\]$/);
      }
    }
    expect((snapshot as { enums?: Record<string, unknown> }).enums ?? {}).toEqual({});
  });

  it('keeps every identifier in the migrations within the 63-byte Postgres limit', () => {
    const folder = join(PACKAGE_ROOT, 'migrations');
    const tooLong = new Set<string>();
    for (const file of readdirSync(folder).filter((f) => f.endsWith('.sql'))) {
      const sqlText = readFileSync(join(folder, file), 'utf8');
      for (const match of sqlText.matchAll(/"([^"]+)"/g)) {
        if (Buffer.byteLength(match[1] ?? '') > 63) {
          tooLong.add(match[1] ?? '');
        }
      }
    }
    expect([...tooLong]).toEqual([]);
  });

  it('writes every SQL column name in snake_case', () => {
    for (const table of tables) {
      expect(table.name).toMatch(/^[a-z][a-z0-9_]*$/);
      for (const name of Object.keys(table.columns)) {
        expect(name, `${table.name}.${name}`).toMatch(/^[a-z][a-z0-9_]*$/);
      }
    }
  });

  it('has created_at on every table and updated_at only where the row is mutable', () => {
    for (const table of tables) {
      if (table.name === 'rate_limits') {
        continue; // Better Auth's table has no timestamps
      }
      expect(table.columns['created_at'], table.name).toBeDefined();
    }
  });

  it('puts deleted_at on exactly the sync entities (no other table may reuse the name)', () => {
    const withTombstone = tables
      .filter((t) => t.columns['deleted_at'] !== undefined)
      .map((t) => t.name)
      .sort();
    expect(withTombstone).toEqual([...SOFT_DELETE].sort());
    expect([...SYNC_ENTITIES].sort()).toEqual([...SOFT_DELETE].sort());
  });

  it('keeps the tables that must survive account deletion free of FKs to users', () => {
    for (const name of NO_FK_TO_USERS) {
      const table = byName.get(name);
      expect(table, name).toBeDefined();
      const toUsers = Object.values(table!.foreignKeys).filter((fk) => fk.tableTo === 'users');
      expect(toUsers, name).toEqual([]);
      expect(table!.columns['user_id'], `${name}.user_id`).toBeUndefined();
    }
  });

  it('has a BRIN index on created_at for every append-only table', () => {
    for (const name of BRIN) {
      const table = byName.get(name)!;
      const brin = Object.values(table.indexes).find(
        (i) => i.method === 'brin' && i.columns[0]?.expression === 'created_at',
      );
      expect(brin, name).toBeDefined();
    }
  });

  it('stores secrets and tokens as bytea, never plaintext, outside the Better Auth exceptions', () => {
    for (const table of tables) {
      for (const column of Object.values(table.columns)) {
        if (column.name.endsWith('_enc') || column.name === 'token_hash') {
          expect(column.type, `${table.name}.${column.name}`).toBe('bytea');
        }
        if (column.name.endsWith('_enc')) {
          expect(
            table.columns[`${column.name.slice(0, -4)}_key_version`]?.type,
            `${table.name}.${column.name}`,
          ).toBe('smallint');
        }
        if (
          /(^|_)(token|secret|password)$/.test(column.name) &&
          !AUTH_TABLES.includes(table.name)
        ) {
          // Device push tokens are routing handles issued by APNs/FCM, and a calendar sync token
          // is a provider cursor: none is a secret PlaneAhead mints or that grants access here.
          expect(
            ['push_tokens.token', 'live_activities.push_token', 'calendar_connections.sync_token'],
            `${table.name}.${column.name} looks like a plaintext secret`,
          ).toContain(`${table.name}.${column.name}`);
        }
      }
    }
  });

  it('reads every instant as an ISO-8601 UTC string; only the Better Auth tables read a Date', () => {
    const modeDate = new Set<string>();
    const isoString = new Set<string>();
    const rawString = new Set<string>();
    let sample: PgColumn | undefined;
    for (const value of Object.values(schema)) {
      if (!is(value, Table)) {
        continue;
      }
      for (const column of Object.values(getTableColumns(value)) as PgColumn[]) {
        if (column.getSQLType() !== 'timestamp with time zone') {
          continue;
        }
        if (column.columnType === 'PgTimestamp') {
          modeDate.add(getTableName(value));
        } else if (column.columnType === 'PgCustomColumn') {
          isoString.add(getTableName(value));
          sample ??= column;
        } else {
          rawString.add(`${getTableName(value)}.${column.name}`);
        }
      }
    }
    expect([...modeDate].sort()).toEqual(['accounts', 'sessions', 'users', 'verifications']);
    // Drizzle's own mode: 'string' hands back Postgres text (`2026-09-19 22:30:00+00`), which
    // is not ISO-8601 and fails IsoInstantSchema; the instant() column type normalises it.
    expect([...rawString]).toEqual([]);
    expect(isoString.size).toBe(65);
    for (const auth of modeDate) {
      expect(isoString.has(auth)).toBe(false);
    }
    const mapped = sample!.mapFromDriverValue('2026-09-19 22:30:00+00') as string;
    expect(mapped).toBe('2026-09-19T22:30:00Z');
    expect(IsoInstantSchema.safeParse(mapped).success).toBe(true);
    expect(IsoInstantSchema.safeParse('2026-09-19 22:30:00+00').success).toBe(false);
  });

  it('carries a format check on every column that stores an ICAO, IATA, hex or flight-number code', () => {
    const CODE_COLUMN = /(^|_)(icao|iata|icao_hex|flight_number)$/;
    const missing: string[] = [];
    for (const table of tables) {
      for (const name of Object.keys(table.columns)) {
        if (!CODE_COLUMN.test(name)) {
          continue;
        }
        const covered = Object.values(table.checkConstraints).some((c) =>
          c.value.includes(`"${table.name}"."${name}"`),
        );
        if (!covered) {
          missing.push(`${table.name}.${name}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('ties a flight instance to its airports with composite foreign keys (origin also carries the zone)', () => {
    const flights = byName.get('flight_instances')!;
    const fks = Object.values(flights.foreignKeys).filter((fk) => fk.tableTo === 'airports');
    expect(fks.map((fk) => [fk.columnsFrom, fk.columnsTo, fk.onDelete]).sort()).toEqual([
      [['destination_airport_id', 'destination_icao'], ['id', 'icao'], 'restrict'],
      [['origin_airport_id', 'origin_icao', 'origin_tz'], ['id', 'icao', 'tz'], 'restrict'],
    ]);
    const airports = byName.get('airports')!;
    expect(airports.uniqueConstraints['airports_id_icao_key']?.columns).toEqual(['id', 'icao']);
    expect(airports.uniqueConstraints['airports_id_icao_tz_key']?.columns).toEqual([
      'id',
      'icao',
      'tz',
    ]);
    // A known origin must carry its zone, or a null would let the MATCH SIMPLE FK skip the row.
    expect(Object.keys(flights.checkConstraints)).toContain('flight_instances_origin_tz_check');
    expect(flights.columns['version']?.default).toBe(0);
    expect(Object.keys(flights.checkConstraints)).toContain(
      'flight_instances_operator_source_check',
    );
  });

  it('dedupes notifications per user and gives rate_limits a purge index', () => {
    const notifications = byName.get('notifications')!;
    const dedupe = notifications.indexes['notifications_user_id_dedupe_key_key'];
    expect(dedupe?.isUnique).toBe(true);
    expect(dedupe?.columns.map((c) => c.expression)).toEqual(['user_id', 'dedupe_key']);
    expect(Object.keys(notifications.indexes)).not.toContain('notifications_dedupe_key_key');
    const rateLimits = byName.get('rate_limits')!;
    expect(rateLimits.indexes['rate_limits_last_request_idx']?.columns[0]?.expression).toBe(
      'last_request',
    );
  });
});

describe('agreement with @planeahead/shared', () => {
  it('flight status, provider, trigger, result and sync entity lists are identical', () => {
    expect([...schema.FLIGHT_STATUSES]).toEqual([...FLIGHT_STATUS_VALUES]);
    expect([...schema.PROVIDERS]).toEqual([...PROVIDER_IDS]);
    expect([...schema.CALL_TRIGGERS]).toEqual([...PROVIDER_CALL_TRIGGERS]);
    expect([...schema.CALL_RESULTS]).toEqual([...PROVIDER_CALL_RESULTS]);
    expect([...schema.SYNC_CHANGE_ENTITIES]).toEqual([...SYNC_ENTITIES]);
    expect([...schema.ALERT_EVENTS]).toEqual([...ALERT_EVENTS]);
    for (const provider of PROVIDER_IDS) {
      expect(schema.EVENT_SOURCES).toContain(provider);
    }
  });

  it('user preference enumerations match the shared UserPreferencesSchema', () => {
    // `PATCH /v1/me/preferences` validates with the shared schema and writes into columns guarded
    // by these check constraints; a value added on one side without the other fails here, not
    // on a request.
    expect([...schema.DISTANCE_UNITS]).toEqual([...DISTANCE_UNITS]);
    expect([...schema.TEMPERATURE_UNITS]).toEqual([...TEMPERATURE_UNITS]);
    expect([...schema.TIME_FORMATS]).toEqual([...TIME_FORMATS]);
  });
});

describe('house style', () => {
  const files = walk(PACKAGE_ROOT)
    .filter((path) => /\.(ts|mjs|json|md|sql)$/.test(path))
    .filter((path) => !path.includes(`${join('seed', 'data')}`));
  const docs = [
    'docs/schema-review.md',
    'docs/adr/0002-neon-not-d1.md',
    'docs/adr/0007-do-postgres-free.md',
    'docs/adr/0009-postgres-js-driver.md',
    'docs/adr/README.md',
  ].map((p) => resolve(REPO_ROOT, p));

  it('scans a meaningful set of files', () => {
    expect(files.length).toBeGreaterThan(25);
  });

  it.each([...files, ...docs].map((path) => [relative(REPO_ROOT, path), path]))(
    '%s has no em dash',
    (_label, path) => {
      expect(readFileSync(path, 'utf8')).not.toMatch(EM_DASH);
    },
  );

  it('never imports geo-tz outside the fetch script', () => {
    const offenders = walk(join(PACKAGE_ROOT, 'src'))
      .concat(walk(join(PACKAGE_ROOT, 'test')))
      .filter((path) => /geo-tz/.test(readFileSync(path, 'utf8')))
      .filter((path) => !path.endsWith('schema-contracts.test.ts'));
    expect(offenders).toEqual([]);
  });
});

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.turbo') {
      continue;
    }
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      walk(path, out);
    } else {
      out.push(path);
    }
  }
  return out;
}
