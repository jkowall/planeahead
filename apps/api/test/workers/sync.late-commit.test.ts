/**
 * The late-commit hazard (ruling K5), for real, on two Postgres connections.
 *
 * An xid is assigned at a transaction's first write, not at its start or its commit, so a
 * transaction can hold an OLDER position in the change log than one that commits before it. A
 * cursor that trusts "the highest position I have seen" (a max(seq) or an updated_at cursor)
 * reads the newer row, moves past the older one, and never sees it once it commits. The feed's
 * watermark (`xid < pg_snapshot_xmin(pg_current_snapshot())`) holds the newer row back for as
 * long as the older transaction is open, and serves both, in order, once it commits.
 *
 *   1. connection A: begin, insert a change row (the transaction takes its xid), stay open;
 *   2. connection B: insert and commit a newer change row;
 *   3. pull: nothing, the newer row is above the watermark and the older one is not visible;
 *   4. commit A;
 *   5. pull from the cursor step 3 answered: both rows, older first, nothing skipped.
 *
 * The second test is the retention horizon (ruling O9) on the same inversion: the older
 * transaction's row holds the LOWER xid and the HIGHER seq, so a purge in seq order (or a horizon
 * read off the lowest-seq row) removes a row a legitimate cursor has not seen and says nothing. A
 * purge below one H recorded with it is exact: a cursor below H answers 410, one at H loses
 * nothing. The purge is simulated for the test's own user and H reaches the route through the
 * `readHorizon` seam, because the one `sync_horizon` row is what every parallel file pulls against.
 */

import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { sql } from 'drizzle-orm';
import { createNodeDb } from '@planeahead/db';
import {
  SyncEnvelopeV1,
  decodeSyncCursor,
  encodeSyncCursor,
  type SyncEnvelopeV1 as SyncEnvelope,
} from '@planeahead/shared';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { createV1Routes } from '../../src/routes/v1';
import { jsonRequest, signInAnonymously, type AnonymousSession } from './helpers/auth';
import { authed, db, eventually, type ErrorBody } from './helpers/routes';

async function pull(session: AnonymousSession, cursor?: string): Promise<SyncEnvelope> {
  const response = await authed(
    session,
    cursor === undefined ? '/v1/sync' : `/v1/sync?cursor=${encodeURIComponent(cursor)}`,
  );
  if (response.status !== 200) {
    throw new Error(`sync failed: ${String(response.status)} ${await response.text()}`);
  }
  return SyncEnvelopeV1.parse(await response.json());
}

describe('the late-commit hazard', () => {
  it('holds a newer committed row back while an older transaction is open, then serves both in order', async () => {
    const session = await signInAnonymously();
    const handle = db();
    const [before] = await handle.execute<{ xid: string }>(sql`
      insert into user_sync_changes (user_id, entity, entity_id, op, row)
      values (${session.userId}::uuid, 'trips', uuidv7(), 'upsert', '{"n":"before"}'::jsonb)
      returning xid::text as xid
    `);
    // A starting cursor past that row (another file's open transaction may hold the watermark
    // below it for a moment).
    const start = await eventually(
      () => pull(session),
      (page) => BigInt(decodeSyncCursor(page.cursor).xid) > BigInt(before?.xid ?? '0'),
    );

    // A second client with ONE connection: its transaction is the long-running writer.
    const older = createNodeDb(env.DB.connectionString, { max: 1 });
    let written = false;
    let commit: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      commit = resolve;
    });
    try {
      // 1. The older transaction takes its xid with its first write and stays open.
      const olderTransaction = older.sql.begin(async (tx) => {
        await tx`
          insert into user_sync_changes (user_id, entity, entity_id, op, row)
          values (${session.userId}::uuid, 'trips', uuidv7(), 'upsert', '{"n":"older"}'::jsonb)
        `;
        written = true;
        await held;
      });
      await eventually(
        () => Promise.resolve(written),
        (value) => value,
      );

      // 2. A newer transaction on another connection writes and commits.
      await handle.execute(sql`
        insert into user_sync_changes (user_id, entity, entity_id, op, row)
        values (${session.userId}::uuid, 'trips', uuidv7(), 'upsert', '{"n":"newer"}'::jsonb)
      `);
      const committed = await handle.execute<{ n: string }>(sql`
        select row->>'n' as n from user_sync_changes
        where user_id = ${session.userId}::uuid and row->>'n' = 'newer'
      `);
      expect(committed).toHaveLength(1);

      // 3. The watermark holds: the newer row is committed and visible, and still not served.
      const during = await pull(session, start.cursor);
      expect(during.changes).toEqual([]);
      expect(during.hasMore).toBe(false);

      // 4. The older transaction commits.
      commit();
      await olderTransaction;

      // 5. Both rows, older first, from the cursor the empty page answered.
      const delivered: string[] = [];
      let cursor = during.cursor;
      await eventually(
        async () => {
          const page = await pull(session, cursor);
          delivered.push(...page.changes.map((change) => String(change.row?.['n'])));
          cursor = page.cursor;
          return delivered.length;
        },
        (count) => count >= 2,
      );
      expect(delivered).toEqual(['older', 'newer']);

      // Why a max(seq) cursor would have lost the older row: it holds the LOWER sequence number
      // and committed LAST.
      const order = await handle.execute<{ n: string; xid: string; seq: string }>(sql`
        select row->>'n' as n, xid::text as xid, seq::text as seq from user_sync_changes
        where user_id = ${session.userId}::uuid and row->>'n' in ('older', 'newer')
        order by seq
      `);
      expect(order.map((row) => row.n)).toEqual(['older', 'newer']);
      expect(BigInt(order[0]?.xid ?? '0')).toBeLessThan(BigInt(order[1]?.xid ?? '0'));

      const after = await pull(session, cursor);
      expect(after.changes).toEqual([]);
    } finally {
      // Not closed: ending a postgres.js socket inside workerd rejects its read loop after the
      // fact (an unhandled rejection); the isolate reclaims it, as it does every request client.
      commit();
    }
  });

  it('keeps the 410 horizon exact when the seq order and the xid order disagree (ruling O9)', async () => {
    const session = await signInAnonymously();
    const handle = db();
    await handle.execute(sql`
      insert into user_sync_changes (user_id, entity, entity_id, op, row)
      values (${session.userId}::uuid, 'trips', uuidv7(), 'upsert', '{"n":"before"}'::jsonb)
    `);
    const start = await eventually(
      () => pull(session),
      (page) => page.changes.length === 0,
    );

    // The inversion: T1 takes its xid first and inserts its change row last.
    const older = createNodeDb(env.DB.connectionString, { max: 1 });
    let hasXid = false;
    let insertOlder: () => void = () => undefined;
    const go = new Promise<void>((resolve) => {
      insertOlder = resolve;
    });
    try {
      const t1 = older.sql.begin(async (tx) => {
        await tx`select pg_current_xact_id()`;
        hasXid = true;
        await go;
        await tx`
          insert into user_sync_changes (user_id, entity, entity_id, op, row)
          values (${session.userId}::uuid, 'trips', uuidv7(), 'upsert', '{"n":"older"}'::jsonb)
        `;
      });
      await eventually(
        () => Promise.resolve(hasXid),
        (value) => value,
      );
      await handle.execute(sql`
        insert into user_sync_changes (user_id, entity, entity_id, op, row)
        values (${session.userId}::uuid, 'trips', uuidv7(), 'upsert', '{"n":"newer"}'::jsonb)
      `);
      insertOlder();
      await t1;
    } finally {
      insertOlder();
    }
    const rows = await handle.execute<{ n: string; xid: string; seq: string }>(sql`
      select row->>'n' as n, xid::text as xid, seq::text as seq from user_sync_changes
      where user_id = ${session.userId}::uuid and row->>'n' in ('older', 'newer')
    `);
    const olderRow = rows.find((row) => row.n === 'older');
    const newerRow = rows.find((row) => row.n === 'newer');
    if (olderRow === undefined || newerRow === undefined) {
      throw new Error('both change rows expected');
    }
    expect(BigInt(olderRow.xid)).toBeLessThan(BigInt(newerRow.xid));
    expect(BigInt(olderRow.seq)).toBeGreaterThan(BigInt(newerRow.seq));

    // The purge: one H below the watermark, `xid < H` deleted, H recorded with it.
    const horizon = newerRow.xid;
    await handle.execute(sql`
      delete from user_sync_changes
      where user_id = ${session.userId}::uuid and xid < ${horizon}::xid8
    `);
    const app = createApp();
    app.route('/v1', createV1Routes({ sync: { readHorizon: () => Promise.resolve(horizon) } }));
    const pullAt = async (cursor: string) => {
      const ctx = createExecutionContext();
      const response = await app.fetch(
        jsonRequest(`/v1/sync?cursor=${encodeURIComponent(cursor)}`, 'GET', undefined, {
          ip: session.ip,
          cookie: session.cookie,
        }),
        env,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return response;
    };

    // Below H: the older row is gone and the cursor had not seen it.
    const below = await pullAt(start.cursor);
    expect(below.status).toBe(410);
    expect((await below.json<ErrorBody>()).error).toBe('resync_required');
    // At H: everything from H on is still there, and served.
    const atHorizon = encodeSyncCursor({
      ...decodeSyncCursor(start.cursor),
      xid: horizon,
      seq: '0',
    });
    const served = await eventually(
      async () => {
        const response = await pullAt(atHorizon);
        expect(response.status).toBe(200);
        return SyncEnvelopeV1.parse(await response.json());
      },
      (page) => page.changes.length > 0,
    );
    expect(served.changes.map((change) => change.row?.['n'])).toEqual(['newer']);
  });
});
