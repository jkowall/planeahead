/**
 * The outbox send protocol every Durable Object shares (increment 7, ruling J3).
 *
 * Rows are written to the object's `outbox` table inside the transaction that produced them and
 * sent to the `persist` queue only after it commits. Sending is byte chunked: Queues caps a
 * `sendBatch` at 100 messages AND 256 KB, and one message at 128 KB (facts sheet section 4), so
 * a batch here holds at most 100 messages and 240 KB of JSON, and a single row over 120 KB is
 * never sent: it is handed back as `oversize` for the caller to turn into an error event and
 * drop. Chunks preserve `seq` order and are sent one after another; the first failed send stops
 * the flush, and only the rows of the chunks that were accepted are reported sent, so the caller
 * marks exactly those `sent_at` and re-sends the rest on its next flush.
 *
 * `bytes` is the UTF-8 length of the JSON, which is at or above `JSON.stringify(...).length`
 * (a multi-byte character is one UTF-16 unit but two to four bytes), so a chunk that fits by this
 * measure fits the platform's.
 *
 * The bookkeeping after a send is shared too: Durable Object SQLite binds at most 100 parameters
 * per statement, so marking the accepted rows sent (`markOutboxSent`) and deleting confirmed rows
 * run their `IN (...)` lists in `SQL_BIND_CHUNK` pieces. The resolver once bound every sent seq in
 * one statement: with 100 or more unsent rows every flush sent the whole backlog and then threw
 * `too many SQL variables` before marking any of it sent, for ever.
 */

import { createLogger, errorFields, type Logger } from '../observability/log';

/** Queues: one message may be at most 128 KB. */
export const QUEUE_MESSAGE_LIMIT_BYTES = 128 * 1024;
/** A single outbox message above this is never sent (ruling J3). */
export const OUTBOX_SINGLE_MESSAGE_LIMIT_BYTES = 120 * 1024;
/** One `sendBatch` carries at most this much JSON (the platform caps at 256 KB). */
export const OUTBOX_BATCH_LIMIT_BYTES = 240 * 1024;
/** One `sendBatch` carries at most this many messages (the platform cap). */
export const OUTBOX_BATCH_LIMIT_MESSAGES = 100;

const encoder = new TextEncoder();

/** The UTF-8 byte length of a message body's JSON. */
export function messageBytes(body: unknown): number {
  return encoder.encode(JSON.stringify(body)).length;
}

export interface OutboxRowLike {
  readonly seq: number;
}

export interface OutboxChunk {
  readonly seqs: number[];
  readonly bodies: unknown[];
  readonly bytes: number;
}

export interface ChunkedOutbox<R extends OutboxRowLike> {
  readonly chunks: OutboxChunk[];
  /** Rows whose single message exceeds `OUTBOX_SINGLE_MESSAGE_LIMIT_BYTES`; never sent. */
  readonly oversize: R[];
}

/**
 * Packs rows (in `seq` order) into chunks under both limits. `build` turns a row into the queue
 * message body; it is called once per row.
 */
export function chunkOutbox<R extends OutboxRowLike>(
  rows: readonly R[],
  build: (row: R) => unknown,
  limits: { readonly bytes?: number; readonly messages?: number } = {},
): ChunkedOutbox<R> {
  const maxBytes = limits.bytes ?? OUTBOX_BATCH_LIMIT_BYTES;
  const maxMessages = limits.messages ?? OUTBOX_BATCH_LIMIT_MESSAGES;
  const chunks: OutboxChunk[] = [];
  const oversize: R[] = [];
  let current: { seqs: number[]; bodies: unknown[]; bytes: number } | null = null;
  for (const row of rows) {
    const body = build(row);
    const bytes = messageBytes(body);
    if (bytes > OUTBOX_SINGLE_MESSAGE_LIMIT_BYTES) {
      oversize.push(row);
      continue;
    }
    if (
      current === null ||
      current.bodies.length >= maxMessages ||
      current.bytes + bytes > maxBytes
    ) {
      current = { seqs: [], bodies: [], bytes: 0 };
      chunks.push(current);
    }
    current.seqs.push(row.seq);
    current.bodies.push(body);
    current.bytes += bytes;
  }
  return { chunks, oversize };
}

/** Durable Object SQLite binds at most 100 parameters per statement; `IN (...)` lists chunk here. */
export const SQL_BIND_CHUNK = 90;

/** Calls `run` once per chunk of at most `SQL_BIND_CHUNK` values, with the matching `?` list. */
export function forEachBindChunk<T extends string | number>(
  values: readonly T[],
  run: (placeholders: string, chunk: T[]) => void,
): void {
  for (let i = 0; i < values.length; i += SQL_BIND_CHUNK) {
    const chunk = values.slice(i, i + SQL_BIND_CHUNK);
    run(chunk.map(() => '?').join(', '), chunk);
  }
}

/** A statement runner: the object's `sql.exec`, or the tracker's metered wrapper around it. */
export type SqlRunner = (query: string, ...bindings: (string | number | null)[]) => unknown;

/**
 * Marks the rows the queue accepted as sent, in bind-safe chunks. The caller wraps the call in
 * ONE `transactionSync`, so a list longer than a chunk is marked all or nothing.
 */
export function markOutboxSent(exec: SqlRunner, seqs: readonly number[], sentAtMs: number): void {
  forEachBindChunk(seqs, (placeholders, chunk) => {
    exec(`UPDATE outbox SET sent_at_ms = ? WHERE seq IN (${placeholders})`, sentAtMs, ...chunk);
  });
}

export interface SendOutcome {
  /** Seqs of every row in a chunk the queue accepted, in order. */
  readonly sentSeqs: number[];
  /** Batches accepted, for the flush statistics. */
  readonly batches: { readonly messages: number; readonly bytes: number }[];
  /** The error of the first failed send, or null when every chunk went. */
  readonly error: unknown;
}

/**
 * Sends the chunks in order, one `sendBatch` each, stopping at the first failure. Never throws:
 * the caller decides what a partial flush means (it marks the accepted rows sent and leaves the
 * rest for the next flush).
 */
export async function sendOutboxChunks(
  sink: Pick<Queue, 'sendBatch'>,
  chunks: readonly OutboxChunk[],
  log: Logger = createLogger(),
): Promise<SendOutcome> {
  const sentSeqs: number[] = [];
  const batches: { messages: number; bytes: number }[] = [];
  for (const chunk of chunks) {
    try {
      await sink.sendBatch(chunk.bodies.map((body) => ({ body })));
    } catch (error) {
      log.error('outbox_send_failed', {
        messages: chunk.bodies.length,
        bytes: chunk.bytes,
        ...errorFields(error),
      });
      return { sentSeqs, batches, error };
    }
    sentSeqs.push(...chunk.seqs);
    batches.push({ messages: chunk.bodies.length, bytes: chunk.bytes });
  }
  return { sentSeqs, batches, error: null };
}
