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
 */

import { env } from 'cloudflare:workers';
import { sql } from 'drizzle-orm';
import { createNodeDb } from '@planeahead/db';
import {
  SyncEnvelopeV1,
  decodeSyncCursor,
  type SyncEnvelopeV1 as SyncEnvelope,
} from '@planeahead/shared';
import { describe, expect, it } from 'vitest';
import { signInAnonymously, type AnonymousSession } from './helpers/auth';
import { authed, db, eventually } from './helpers/routes';

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
});
