/**
 * Theme tokens for light and dark (increment 10). No third-party UI kit: every screen and
 * component takes its colours, spacing, radii and type sizes from here through `useTheme()`
 * (src/theme/useTheme.ts), never from a literal, so dark mode is one token set away.
 *
 * The status colours cover every `FLIGHT_STATUS_VALUES` member plus `pending` (a flight the
 * outbox has not added yet). Each pill's text on its background, and every text colour on the
 * screen background, clears WCAG AA contrast (4.5:1) in both schemes; the non-text colours that
 * carry meaning (an input's border, the timeline's rail and the marker of a step still ahead)
 * clear WCAG 1.4.11's 3:1 against every background they sit on (increment 10 review).
 * __tests__/theme.test.ts computes the ratios, so a token edit that breaks legibility fails a test.
 */

import { FLIGHT_STATUS_VALUES, type FlightStatusValue } from '@planeahead/shared';

export type ColorScheme = 'light' | 'dark';

/** A status pill's look: the flight statuses the shared contract knows, and the local pending. */
export type PillTone = FlightStatusValue | 'pending';

export const PILL_TONES: readonly PillTone[] = [...FLIGHT_STATUS_VALUES, 'pending'];

export interface ColorTokens {
  readonly background: string;
  readonly surface: string;
  readonly surfaceRaised: string;
  readonly text: string;
  readonly textMuted: string;
  /** Decorative separators (cards, rows): not a boundary anything depends on. */
  readonly border: string;
  /** A text field's boundary: 3:1 against the screen background and the field's own fill. */
  readonly inputBorder: string;
  readonly accent: string;
  readonly accentText: string;
  readonly danger: string;
  readonly warning: string;
  readonly success: string;
  /**
   * The timeline's rail and the marker of a step that has not happened yet: 3:1 against the
   * background and the section surface the timeline sits on.
   */
  readonly rail: string;
}

export interface PillColors {
  readonly background: string;
  readonly text: string;
}

export interface ThemeTokens {
  readonly scheme: ColorScheme;
  readonly color: ColorTokens;
  readonly status: Readonly<Record<PillTone, PillColors>>;
  readonly space: {
    readonly xs: 4;
    readonly sm: 8;
    readonly md: 12;
    readonly lg: 16;
    readonly xl: 24;
  };
  readonly radius: { readonly sm: 6; readonly md: 10; readonly lg: 14; readonly pill: 999 };
  readonly font: {
    readonly title: 28;
    readonly heading: 20;
    readonly body: 16;
    readonly small: 13;
    /** The hero time on the next-flight card. */
    readonly display: 34;
  };
}

const SPACE = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;
const RADIUS = { sm: 6, md: 10, lg: 14, pill: 999 } as const;
const FONT = { title: 28, heading: 20, body: 16, small: 13, display: 34 } as const;

export const LIGHT: ThemeTokens = {
  scheme: 'light',
  color: {
    background: '#FFFFFF',
    surface: '#F2F4F8',
    surfaceRaised: '#FFFFFF',
    text: '#101418',
    textMuted: '#525B67',
    border: '#D6DAE1',
    inputBorder: '#7D8591',
    accent: '#1C4FD6',
    accentText: '#FFFFFF',
    danger: '#B42318',
    warning: '#8A4B00',
    success: '#146C2E',
    rail: '#818894',
  },
  status: {
    scheduled: { background: '#E4E8EF', text: '#27303B' },
    boarding: { background: '#DCE6FF', text: '#1537A3' },
    departed: { background: '#DCE6FF', text: '#1537A3' },
    en_route: { background: '#DCE6FF', text: '#1537A3' },
    landed: { background: '#DDF3E4', text: '#0F5A26' },
    arrived: { background: '#DDF3E4', text: '#0F5A26' },
    cancelled: { background: '#FDE3E1', text: '#9A1C13' },
    diverted: { background: '#FFEBD1', text: '#7A4100' },
    unknown: { background: '#E4E8EF', text: '#3D4652' },
    pending: { background: '#F1E8FF', text: '#5B2AA8' },
  },
  space: SPACE,
  radius: RADIUS,
  font: FONT,
};

export const DARK: ThemeTokens = {
  scheme: 'dark',
  color: {
    background: '#0B0E13',
    surface: '#171B22',
    surfaceRaised: '#1F242D',
    text: '#F2F4F8',
    textMuted: '#A3ACB8',
    border: '#2A303A',
    inputBorder: '#707A8C',
    accent: '#7C9DFF',
    accentText: '#0B0E13',
    danger: '#FF8A80',
    warning: '#FFB866',
    success: '#6FD08C',
    rail: '#6B7485',
  },
  status: {
    scheduled: { background: '#2A303A', text: '#E4E8EF' },
    boarding: { background: '#1B2F66', text: '#C9D7FF' },
    departed: { background: '#1B2F66', text: '#C9D7FF' },
    en_route: { background: '#1B2F66', text: '#C9D7FF' },
    landed: { background: '#123D22', text: '#B8EFC9' },
    arrived: { background: '#123D22', text: '#B8EFC9' },
    cancelled: { background: '#4A1511', text: '#FFC9C4' },
    diverted: { background: '#4A2C07', text: '#FFD9A8' },
    unknown: { background: '#2A303A', text: '#C9D0DA' },
    pending: { background: '#33205A', text: '#E2D2FF' },
  },
  space: SPACE,
  radius: RADIUS,
  font: FONT,
};

export function tokensFor(scheme: ColorScheme): ThemeTokens {
  return scheme === 'dark' ? DARK : LIGHT;
}

// ---------------------------------------------------------------------------------------------
// Contrast (WCAG 2.x relative luminance), used by the theme test.
// ---------------------------------------------------------------------------------------------

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance of a `#RRGGBB` colour. */
export function luminance(hex: string): number {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (
    match === null ||
    match[1] === undefined ||
    match[2] === undefined ||
    match[3] === undefined
  ) {
    throw new Error(`not a #RRGGBB colour: ${hex}`);
  }
  const [r, g, b] = [match[1], match[2], match[3]].map((part) => channel(parseInt(part, 16)));
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

/** WCAG contrast ratio between two `#RRGGBB` colours, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}
