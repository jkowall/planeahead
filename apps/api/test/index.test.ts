import { PLANEAHEAD } from '@planeahead/shared';
import { describe, expect, it } from 'vitest';
import { health } from '../src/index';

describe('@planeahead/api', () => {
  it('reports health', () => {
    expect(health()).toEqual({ ok: true, name: 'planeahead' });
  });

  it('resolves the workspace link to @planeahead/shared', () => {
    expect(health().name).toBe(PLANEAHEAD);
  });
});
