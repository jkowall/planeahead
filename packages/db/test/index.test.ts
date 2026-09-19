import { describe, expect, it } from 'vitest';
import { DB_SCHEMA_VERSION } from '../src/index';

describe('@planeahead/db', () => {
  it('starts at schema version 0, before any migration exists', () => {
    expect(DB_SCHEMA_VERSION).toBe(0);
  });
});
