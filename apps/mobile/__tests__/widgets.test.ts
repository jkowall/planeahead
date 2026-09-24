/**
 * The expo-widgets configuration and the two layouts (increment 11, ruling V2, ADR 0008).
 *
 * Config: ONE `widgets[]` entry, the placeholder, with families; the Live Activity is created
 * with `createLiveActivity` and absent from `widgets[]`; the App Group is the variant's; Android
 * widgets only behind the flag.
 *
 * Layouts: the widget extension does not run the app's bundle. It evaluates the STRING that
 * babel-preset-expo makes of each function carrying the `'widget'` directive, in a
 * JavaScriptCore context whose only globals are `@expo/ui/swift-ui`, its modifiers and a JSX
 * runtime (expo-widgets 57.0.20 bundle/index.ts). Jest compiles the widget files with the same
 * preset, so this test captures the strings `createWidget` and `createLiveActivity` receive and
 * evaluates them in a fresh `vm` context holding exactly those names: a helper or constant from
 * outside the function body, a hook, or a component from anywhere else fails with a
 * ReferenceError here instead of a red box on a Lock Screen.
 */

import type { ExpoConfig } from 'expo/config';
import appConfig, { PLACEHOLDER_WIDGET } from '../app.config';
import {
  FLIGHT_ACTIVITY_NAME,
  FlightActivity,
  PLACEHOLDER_WIDGET_NAME,
  PlaceholderWidget,
} from '../widgets';
import {
  FULL_CONTENT_STATE,
  MINIMAL_CONTENT_STATE,
  WORST_CASE_CONTENT_STATE,
} from './support/live-activity-fixtures';

jest.mock('expo-widgets', () => ({
  createWidget: (name: string, layout: unknown) => ({ name, layout }),
  createLiveActivity: (name: string, layout: unknown) => ({ name, layout }),
  addPushToStartTokenListener: () => ({ remove: () => undefined }),
}));

// Jest's CommonJS wrapper provides it; the app's tsconfig carries no Node types.
declare const __dirname: string;

const vm = jest.requireActual<{
  createContext(sandbox: Record<string, unknown>): object;
  runInContext(code: string, context: object): unknown;
}>('vm');
const fs = jest.requireActual<{ readFileSync(path: string, encoding: 'utf8'): string }>('fs');
const path = jest.requireActual<{ resolve(...parts: string[]): string }>('path');

const env = (process as unknown as { env: Record<string, string | undefined> }).env;

interface Captured {
  readonly name: string;
  readonly layout: unknown;
}

function configFor(variant: string, extra: Record<string, string> = {}): ExpoConfig {
  const names = ['APP_VARIANT', ...Object.keys(extra)];
  const previous = new Map(names.map((name) => [name, env[name]]));
  env['APP_VARIANT'] = variant;
  Object.assign(env, extra);
  try {
    return appConfig({ config: {} } as Parameters<typeof appConfig>[0]);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete env[name];
      } else {
        env[name] = value;
      }
    }
  }
}

interface WidgetsProps {
  bundleIdentifier: string;
  groupIdentifier: string;
  enablePushNotifications: boolean;
  enableAndroid: boolean;
  widgets: { name: string; supportedFamilies: string[] }[];
}

function widgetsPluginProps(config: ExpoConfig): WidgetsProps {
  const entry = (config.plugins ?? []).find(
    (plugin) => Array.isArray(plugin) && plugin[0] === 'expo-widgets',
  ) as [string, WidgetsProps] | undefined;
  if (entry === undefined) {
    throw new Error('expo-widgets is not in the plugin list');
  }
  return entry[1];
}

/** A widget-runtime element: what the JSX runtime stub of expo-widgets' bundle returns. */
interface Element {
  readonly type: string;
  readonly props: Record<string, unknown>;
}

/** The globals the widget extension's JavaScript context has, as stubs, plus nothing else. */
function widgetRuntime(): object {
  const components = jest.requireActual<Record<string, unknown>>('@expo/ui/swift-ui');
  const modifiers = jest.requireActual<Record<string, unknown>>('@expo/ui/swift-ui/modifiers');
  const sandbox: Record<string, unknown> = {};
  for (const name of Object.keys(components)) {
    sandbox[name] = name;
  }
  for (const name of Object.keys(modifiers)) {
    sandbox[name] = (...args: unknown[]) => ({ $modifier: name, args });
  }
  const jsx = (type: unknown, props: Record<string, unknown>): Element => ({
    type: String(type),
    props,
  });
  for (const name of ['jsx', 'jsxs', 'jsxDEV', '_jsx', '_jsxs', '_jsxDEV']) {
    sandbox[name] = jsx;
  }
  sandbox['Fragment'] = 'react.fragment';
  sandbox['_Fragment'] = 'react.fragment';
  return vm.createContext(sandbox);
}

function evaluate(captured: Captured): (props: object, environment: object) => unknown {
  expect(typeof captured.layout).toBe('string');
  return vm.runInContext(`(${String(captured.layout)})`, widgetRuntime()) as (
    props: object,
    environment: object,
  ) => unknown;
}

/** Every string in a rendered tree, for asserting what a region prints. */
function texts(node: unknown): string[] {
  if (typeof node === 'string' || typeof node === 'number') {
    return [String(node)];
  }
  if (Array.isArray(node)) {
    return node.flatMap(texts);
  }
  if (node !== null && typeof node === 'object' && 'props' in node) {
    const children = (node as Element).props['children'];
    return children === undefined ? [] : texts(children);
  }
  return [];
}

const placeholder = PlaceholderWidget as unknown as Captured;
const flightActivity = FlightActivity as unknown as Captured;

describe('expo-widgets configuration', () => {
  it.each(['production', 'preview', 'development'])(
    'gives the %s variant one widgets[] entry, the placeholder, and no Live Activity entry',
    (variant) => {
      const config = configFor(variant);
      const props = widgetsPluginProps(config);
      const bundleId = config.ios?.bundleIdentifier ?? '';
      expect(props.widgets).toHaveLength(1);
      expect(props.widgets[0]?.name).toBe(PLACEHOLDER_WIDGET_NAME);
      expect(props.widgets[0]?.supportedFamilies.length).toBeGreaterThan(0);
      expect(props.widgets.map((widget) => widget.name)).not.toContain(FLIGHT_ACTIVITY_NAME);
      expect(props.groupIdentifier).toBe(`group.${bundleId}`);
      expect(config.ios?.entitlements?.['com.apple.security.application-groups']).toEqual([
        props.groupIdentifier,
      ]);
      expect(props.bundleIdentifier).toBe(`${bundleId}.widgets`);
      expect(props.enablePushNotifications).toBe(true);
    },
  );

  it('names the placeholder the same in app.config.ts and in createWidget', () => {
    expect(PLACEHOLDER_WIDGET.name).toBe(PLACEHOLDER_WIDGET_NAME);
    expect(placeholder.name).toBe(PLACEHOLDER_WIDGET_NAME);
    expect(flightActivity.name).toBe(FLIGHT_ACTIVITY_NAME);
  });

  it('keeps Android widgets off unless PLANEAHEAD_ANDROID_WIDGETS=1', () => {
    expect(widgetsPluginProps(configFor('development')).enableAndroid).toBe(false);
    expect(
      widgetsPluginProps(configFor('development', { PLANEAHEAD_ANDROID_WIDGETS: '1' }))
        .enableAndroid,
    ).toBe(true);
  });

  it('unlinks expo-widgets on Android by the same flag that turns its widgets on (ruling Z3)', () => {
    for (const flag of [undefined, '1']) {
      const config = configFor(
        'production',
        flag === undefined ? {} : { PLANEAHEAD_ANDROID_WIDGETS: flag },
      );
      const build = (config.plugins ?? []).find(
        (plugin) => Array.isArray(plugin) && plugin[0] === './plugins/withExpoWidgetsBuild.ts',
      ) as [string, { enableAndroid: boolean }] | undefined;
      expect(build?.[1]).toEqual({ enableAndroid: widgetsPluginProps(config).enableAndroid });
    }
  });
});

describe('widget layouts in the extension runtime', () => {
  it('imports nothing but @expo/ui/swift-ui, expo-widgets and types into the widget files', () => {
    for (const file of ['placeholder.tsx', 'live-activity.tsx']) {
      const source = fs.readFileSync(path.resolve(__dirname, '..', 'widgets', file), 'utf8');
      const valueImports = [...source.matchAll(/^import (?!type )[^;]*? from '([^']+)';$/gms)].map(
        (match) => match[1],
      );
      for (const specifier of valueImports) {
        expect([
          '@expo/ui/swift-ui',
          '@expo/ui/swift-ui/modifiers',
          'expo-widgets',
          './content-state',
        ]).toContain(specifier);
      }
    }
  });

  it.each(['systemSmall', 'systemMedium'])('renders the placeholder for %s', (family) => {
    const tree = evaluate(placeholder)({}, { widgetFamily: family, date: new Date() }) as Element;
    expect(tree.type).toBe('VStack');
    expect(texts(tree)).toContain('PlaneAhead');
  });

  it.each([
    ['a worst-case flight', WORST_CASE_CONTENT_STATE, false],
    ['a full flight', FULL_CONTENT_STATE, false],
    ['a minimal flight', MINIMAL_CONTENT_STATE, false],
    ['a stale activity', MINIMAL_CONTENT_STATE, true],
  ])('renders every Live Activity region for %s', (_label, state, isStale) => {
    const layout = evaluate(flightActivity)(state, { colorScheme: 'dark', isStale }) as Record<
      string,
      unknown
    >;
    expect(Object.keys(layout).sort()).toEqual([
      'banner',
      'bannerSmall',
      'compactLeading',
      'compactTrailing',
      'expandedBottom',
      'expandedCenter',
      'expandedLeading',
      'expandedTrailing',
      'minimal',
    ]);
    const banner = texts(layout['banner']).join(' ');
    expect(banner).toContain(state.designator ?? 'AAL 100');
    expect(banner).toContain(isStale ? 'Not updated recently' : state.status.replace('_', ' '));
  });

  it('prints the route and gate of a full state', () => {
    const layout = evaluate(flightActivity)(FULL_CONTENT_STATE, {
      colorScheme: 'light',
    }) as Record<string, unknown>;
    const banner = texts(layout['banner']).join(' ');
    expect(banner).toContain('JFK to SIN');
    expect(banner).toContain('Gate B22A');
    expect(banner).toContain('Terminal 8');
  });

  /** The children of the expanded bottom region's time row. */
  function timeRow(state: object): Element[] {
    const layout = evaluate(flightActivity)(state, { colorScheme: 'light' }) as Record<
      string,
      Element
    >;
    const rows = layout['expandedBottom']?.props['children'] as Element[];
    const row = rows.find((child) => child.type === 'HStack');
    return (row?.props['children'] ?? []) as Element[];
  }

  /** What is printed right after the time `which` (0: departure, 1: arrival). */
  function besideTime(row: Element[], which: 0 | 1): unknown {
    const times = row
      .map((child, index) => ('date' in child.props ? index : -1))
      .filter((index) => index >= 0);
    const index = times[which];
    expect(index).toBeDefined();
    return row[(index ?? 0) + 1]?.props['children'];
  }

  it('prints the origin gate beside the departure and the destination gate beside the arrival', () => {
    const row = timeRow(FULL_CONTENT_STATE);
    expect(besideTime(row, 0)).toBe('Gate B22A');
    expect(besideTime(row, 1)).toBe('Gate C3');
  });

  it('prints no gate beside the arrival time when the destination gate is unknown (ruling Z7)', () => {
    const originOnly = { ...FULL_CONTENT_STATE, destinationGate: undefined };
    const row = timeRow(originOnly);
    expect(besideTime(row, 0)).toBe('Gate B22A');
    expect(besideTime(row, 1)).toBe('');
    expect(texts(row).filter((text) => text !== '')).toEqual(['Gate B22A']);
  });
});
