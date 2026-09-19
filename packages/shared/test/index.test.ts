import { describe, expect, it } from 'vitest';
import { PLANEAHEAD, flightKeyPlaceholder } from '../src/index';

describe('@planeahead/shared', () => {
  it('exports the project name constant', () => {
    expect(PLANEAHEAD).toBe('planeahead');
  });

  it('builds a placeholder flight key', () => {
    expect(flightKeyPlaceholder('aal', 100, '2026-09-19')).toBe('AAL-100-2026-09-19');
  });
});
