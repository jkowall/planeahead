/**
 * The board cache's storage format (increment 18, ruling B3), shared by `AirportState`, which
 * writes it, and the Worker, which reads the KV copy first.
 *
 *   - A bucket's normalised rows are ONE gzip stream (`CompressionStream`) of their JSON array.
 *   - In the object's SQLite the stream is split into chunks of at most `BOARD_CHUNK_BYTES`, so
 *     no board can meet the 2 MB row limit (R3 F37; a hub's real size is unmeasured, R3 U4).
 *   - In KV (`board:v2:{ICAO}:{bucketStartLocal}` in `CACHE`) the whole stream is the value (KV
 *     takes 25 MiB) and `BoardKvMetaV1` is the metadata, so a reader learns `fetchedAt`,
 *     `freshUntil` and `staleUntil` without decompressing anything.
 */

import {
  BOARD_KV_CACHE_TTL_SECONDS,
  BoardKvMetaV1,
  BoardRowSchema,
  boardKvKey,
  type BoardRow,
} from '@planeahead/shared';
import { z } from 'zod';

/** The largest chunk one SQLite row holds: half the 2 MB row limit, whatever the key. */
export const BOARD_CHUNK_BYTES = 1_000_000;

async function through(
  bytes: Uint8Array,
  transform: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The gzip of a value's JSON. */
export async function gzipJson(value: unknown): Promise<Uint8Array> {
  return through(new TextEncoder().encode(JSON.stringify(value)), new CompressionStream('gzip'));
}

/** The value a gzip of JSON holds. Throws on a corrupt stream or invalid JSON. */
export async function gunzipJson(bytes: Uint8Array): Promise<unknown> {
  const plain = await through(bytes, new DecompressionStream('gzip'));
  return JSON.parse(new TextDecoder().decode(plain)) as unknown;
}

/** `bytes` cut into pieces of at most `size` bytes (none for an empty input). */
export function splitChunks(bytes: Uint8Array, size: number = BOARD_CHUNK_BYTES): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += size) {
    chunks.push(bytes.slice(offset, offset + size));
  }
  return chunks;
}

/** The pieces joined back, in order. */
export function joinChunks(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}

const RowsSchema = z.array(BoardRowSchema);

/** The rows a bucket's gzip stream holds, validated. Throws on anything else. */
export async function decodeBoardRows(bytes: Uint8Array): Promise<BoardRow[]> {
  return RowsSchema.parse(await gunzipJson(bytes));
}

export interface BoardKvCopy {
  readonly meta: BoardKvMetaV1;
  readonly rows: BoardRow[];
}

/**
 * The Worker's first read (ruling B3): the bucket's KV copy with a 30 s edge cache, or null on
 * a miss, a malformed entry or a KV error (the caller then asks the object). The caller decides
 * freshness from `meta.freshUntil`.
 */
export async function readBoardKv(
  kv: Pick<KVNamespace, 'getWithMetadata'>,
  airportIcao: string,
  bucketStartLocal: string,
): Promise<BoardKvCopy | null> {
  try {
    const entry = await kv.getWithMetadata<unknown>(boardKvKey(airportIcao, bucketStartLocal), {
      type: 'arrayBuffer',
      cacheTtl: BOARD_KV_CACHE_TTL_SECONDS,
    });
    const meta = BoardKvMetaV1.safeParse(entry.metadata);
    if (entry.value === null || !meta.success) {
      return null;
    }
    return { meta: meta.data, rows: await decodeBoardRows(new Uint8Array(entry.value)) };
  } catch {
    return null;
  }
}
