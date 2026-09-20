import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IsoInstantSchema } from '@planeahead/shared';
import { describe, expect, it } from 'vitest';
import { InstantFormatError, assertZonedInstant, toIsoInstant } from '../src/schema/columns';
import { externalDatabaseUrl, parseEnvFile } from './globalSetup';

/**
 * Pure tests for the instant normaliser behind every `instant()` column and for the harness
 * helpers. No database.
 */

describe('toIsoInstant', () => {
  it.each([
    ['2026-09-19 22:30:00+00', '2026-09-19T22:30:00Z'],
    ['2026-09-20 01:04:04.778953+00', '2026-09-20T01:04:04.778953Z'],
    ['2026-09-19 22:30:00+00:00', '2026-09-19T22:30:00Z'],
    ['2026-09-19 18:30:00-04', '2026-09-19T22:30:00Z'],
    ['2026-09-19 18:30:00.5-04:30', '2026-09-19T23:00:00.5Z'],
    ['2026-09-20 07:30:00+09', '2026-09-19T22:30:00Z'],
    ['2026-12-31 23:30:00-01', '2027-01-01T00:30:00Z'],
    ['1883-11-18 12:00:00+00:53:28', '1883-11-18T11:06:32Z'],
    ['2026-09-19T22:30:00.000Z', '2026-09-19T22:30:00.000Z'],
    ['2026-09-19T22:30Z', '2026-09-19T22:30:00Z'],
  ])('normalises %s to %s', (input, expected) => {
    expect(toIsoInstant(input)).toBe(expected);
    expect(IsoInstantSchema.safeParse(toIsoInstant(input)).success).toBe(true);
    // JavaScript's Date cannot parse a second-precision offset, so the cross-check skips it.
    if (!Number.isNaN(new Date(input).getTime())) {
      expect(new Date(toIsoInstant(input)).getTime()).toBe(new Date(input).getTime());
    }
  });

  it('is idempotent on its own output', () => {
    const once = toIsoInstant('2026-09-19 18:30:00.123456-04');
    expect(toIsoInstant(once)).toBe(once);
  });

  it.each([
    '2026-09-19 22:30:00',
    '2026-09-19',
    'infinity',
    '',
    'not a date',
    '2026-09-19T22:30:00 UTC',
  ])('rejects %j (no zone designator or not a timestamp)', (input) => {
    expect(() => toIsoInstant(input)).toThrow(InstantFormatError);
  });
});

describe('assertZonedInstant (write guard)', () => {
  it.each([
    '2026-09-19T22:30:00.000Z',
    '2026-09-19T22:30:00Z',
    '2026-09-19 22:30:00+00',
    '2026-09-19T18:30:00-04:00',
  ])('accepts %s', (input) => {
    expect(assertZonedInstant(input)).toBe(input);
  });

  it.each(['2026-09-19 22:30:00', '2026-09-19T22:30:00', '2026-09-19', 'now()'])(
    'rejects %s so a session time zone can never shift a write',
    (input) => {
      expect(() => assertZonedInstant(input)).toThrow(InstantFormatError);
    },
  );
});

describe('.env.test loading', () => {
  it('parses KEY=VALUE lines with comments and quotes', () => {
    expect(
      parseEnvFile(
        [
          '# comment',
          '',
          'TEST_DATABASE_URL="postgres://u:p@h/db"',
          "OTHER='x'",
          'export Y=1',
          'BAD',
        ].join('\n'),
      ),
    ).toEqual({ TEST_DATABASE_URL: 'postgres://u:p@h/db', OTHER: 'x', Y: '1' });
  });

  it('prefers the shell, then .env.test, then nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'planeahead-env-'));
    const file = join(dir, '.env.test');
    await writeFile(file, 'TEST_DATABASE_URL=postgres://from-file/db\n');
    expect(externalDatabaseUrl({ TEST_DATABASE_URL: 'postgres://from-shell/db' }, file)).toEqual({
      url: 'postgres://from-shell/db',
      source: 'shell',
    });
    expect(externalDatabaseUrl({}, file)).toEqual({
      url: 'postgres://from-file/db',
      source: '.env.test',
    });
    expect(externalDatabaseUrl({ TEST_DATABASE_URL: '' }, file)?.source).toBe('.env.test');
    expect(externalDatabaseUrl({}, join(dir, 'missing'))).toBeNull();
  });
});
