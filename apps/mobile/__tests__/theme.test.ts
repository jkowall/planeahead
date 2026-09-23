/**
 * The theme tokens (ruling T6): a light and a dark set covering every shared flight status, both
 * legible (WCAG AA 4.5:1 for text), and the scheme the settings store's appearance override picks.
 */

import { FLIGHT_STATUS_VALUES } from '@planeahead/shared';
import { contrastRatio, DARK, LIGHT, PILL_TONES, tokensFor } from '../src/theme/tokens';
import { resolveScheme } from '../src/theme/useTheme';

const AA_TEXT = 4.5;

describe.each([
  ['light', LIGHT],
  ['dark', DARK],
] as const)('the %s tokens', (scheme, tokens) => {
  it('name their scheme', () => {
    expect(tokens.scheme).toBe(scheme);
    expect(tokensFor(scheme)).toBe(tokens);
  });

  it('have a pill for every shared status value and for a pending add', () => {
    for (const status of FLIGHT_STATUS_VALUES) {
      expect(tokens.status[status]).toBeDefined();
    }
    expect(Object.keys(tokens.status).sort()).toEqual([...PILL_TONES].sort());
  });

  it.each(PILL_TONES)('keep the %s pill legible', (tone) => {
    const { background, text } = tokens.status[tone];
    expect(contrastRatio(text, background)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it('keep every text colour legible on the background and on a surface', () => {
    const { color } = tokens;
    for (const foreground of [
      color.text,
      color.textMuted,
      color.accent,
      color.danger,
      color.warning,
      color.success,
    ]) {
      expect(contrastRatio(foreground, color.background)).toBeGreaterThanOrEqual(AA_TEXT);
      expect(contrastRatio(foreground, color.surface)).toBeGreaterThanOrEqual(AA_TEXT);
    }
    expect(contrastRatio(color.accentText, color.accent)).toBeGreaterThanOrEqual(AA_TEXT);
  });
});

describe('resolveScheme', () => {
  it('follows the system unless the settings store overrides it', () => {
    expect(resolveScheme('system', 'dark')).toBe('dark');
    expect(resolveScheme('system', 'light')).toBe('light');
    expect(resolveScheme('system', null)).toBe('light');
    expect(resolveScheme('dark', 'light')).toBe('dark');
    expect(resolveScheme('light', 'dark')).toBe('light');
  });
});

describe('contrastRatio', () => {
  it('matches the WCAG reference values', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
    expect(() => contrastRatio('red', '#FFFFFF')).toThrow(/#RRGGBB/);
  });
});
