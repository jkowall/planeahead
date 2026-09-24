/**
 * The placeholder home-screen widget (increment 11, ADR 0008): the one `widgets[]` entry in
 * app.config.ts, so the expo-widgets extension exists, compiles and ships in every build. It
 * shows a static shell until Phase 1 feeds it the next flight.
 *
 * The layout function carries the `'widget'` directive: babel-preset-expo turns it into a string
 * at build time, and the widget extension evaluates that string in its own JavaScriptCore
 * context, where the only globals are `@expo/ui/swift-ui`, its modifiers and a JSX runtime. So
 * the body may use nothing declared outside it (no module constants, no helpers, no hooks); the
 * imports below exist for the types and are never read by the extension.
 * __tests__/widgets.test.ts evaluates the compiled string against exactly those globals.
 *
 * Importing this module registers the layout with the App Group (`createWidget` stores it), which
 * is why src/lib/live-activity/tokens.ts imports `widgets/` on launch.
 */

import { Text, VStack } from '@expo/ui/swift-ui';
import { font, padding } from '@expo/ui/swift-ui/modifiers';
import { createWidget, type WidgetEnvironment } from 'expo-widgets';

/** `createWidget`'s name; equal to the `widgets[]` entry's `name` in app.config.ts. */
export const PLACEHOLDER_WIDGET_NAME = 'PlaneAheadPlaceholder';

/** No props in Phase 0. */
export type PlaceholderWidgetProps = Record<string, never>;

function PlaceholderWidgetLayout(_props: PlaceholderWidgetProps, environment: WidgetEnvironment) {
  'widget';
  const small = environment.widgetFamily === 'systemSmall';
  return (
    <VStack modifiers={[padding({ all: 4 })]}>
      <Text modifiers={[font({ textStyle: 'headline' })]}>PlaneAhead</Text>
      <Text modifiers={[font({ textStyle: 'caption' })]}>
        {small ? 'No flight yet' : 'Your next flight will show here'}
      </Text>
    </VStack>
  );
}

export const PlaceholderWidget = createWidget<PlaceholderWidgetProps>(
  PLACEHOLDER_WIDGET_NAME,
  PlaceholderWidgetLayout,
);
