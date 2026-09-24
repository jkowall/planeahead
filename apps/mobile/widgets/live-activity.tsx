/**
 * The flight Live Activity layout (increment 11, ADR 0008): the Lock Screen banner, the small
 * banner a paired Apple Watch and CarPlay show, and the Dynamic Island regions. A layout only:
 * the app never starts an activity in Phase 0 (Phase 1 starts them by push, with the
 * push-to-start token src/lib/live-activity/tokens.ts registers).
 *
 * Created with `createLiveActivity` and deliberately NOT a `widgets[]` entry in app.config.ts:
 * an entry without `supportedFamilies` generates an invalid widget target (facts section 5).
 * expo-widgets always compiles its `WidgetLiveActivity` into the extension; this module registers
 * the layout it renders under `FLIGHT_ACTIVITY_NAME` with the App Group when it is imported.
 *
 * The props are the shared `LiveActivityContentStateV1` itself (widgets/content-state.ts). Same
 * rules as the placeholder: the `'widget'` directive, `@expo/ui/swift-ui` only, nothing from
 * outside the function body (plain JavaScript built-ins such as `Date` are the extension's too).
 * Comments stay out of the body: the directive turns it into a string stored in the App Group,
 * comments included. Without a marketing designator the flight key names the flight
 * (`AAL-100-2026-09-19-KJFK` reads `AAL 100`, and its origin `KJFK`).
 *
 * `gate` and `terminal` are the origin's (the departure pair, ruling Z7), printed on the gate row
 * and next to the departure side. The destination gate, when a producer has one, is printed right
 * after the arrival time, and nowhere when it is absent, so no row ever shows a departure gate
 * beside an arrival time. `destinationTerminal` is carried for Phase 1 and not printed yet.
 */

import { HStack, Image, ProgressView, Spacer, Text, VStack } from '@expo/ui/swift-ui';
import { font, monospacedDigit, padding } from '@expo/ui/swift-ui/modifiers';
import type { LiveActivityContentStateV1 } from '@planeahead/shared';
import { createLiveActivity, type LiveActivityEnvironment } from 'expo-widgets';
import { FLIGHT_ACTIVITY_NAME } from './content-state';

function FlightActivityLayout(
  props: LiveActivityContentStateV1,
  environment: LiveActivityEnvironment,
) {
  'widget';
  const keyParts = props.flightKey.split('-');
  const designator = props.designator ?? `${keyParts[0] ?? ''} ${keyParts[1] ?? ''}`;
  const route = `${props.originIata ?? keyParts[5] ?? ''} to ${props.destinationIata ?? ''}`;
  const status = props.status.replace('_', ' ');
  const departs = new Date(props.actualOut ?? props.estimatedOut ?? props.scheduledOut);
  const arrives = new Date(props.estimatedIn ?? props.scheduledIn);
  const gate = props.gate === undefined ? 'Gate -' : `Gate ${props.gate}`;
  const arrivalGate = props.destinationGate === undefined ? '' : `Gate ${props.destinationGate}`;
  const terminal = props.terminal === undefined ? '' : `Terminal ${props.terminal}`;
  const baggage = props.baggageClaim === undefined ? '' : `Bags ${props.baggageClaim}`;
  const progress = props.progressPercent === undefined ? null : props.progressPercent / 100;
  const caption = environment.isStale === true ? 'Not updated recently' : status;

  return {
    banner: (
      <VStack modifiers={[padding({ all: 12 })]}>
        <HStack>
          <Text modifiers={[font({ textStyle: 'headline' })]}>{designator}</Text>
          <Spacer />
          <Text modifiers={[font({ textStyle: 'subheadline' })]}>{caption}</Text>
        </HStack>
        <HStack>
          <Text modifiers={[font({ textStyle: 'subheadline' })]}>{route}</Text>
          <Spacer />
          <Text date={departs} dateStyle="time" modifiers={[monospacedDigit()]} />
          <Text> - </Text>
          <Text date={arrives} dateStyle="time" modifiers={[monospacedDigit()]} />
          <Text modifiers={[font({ textStyle: 'caption' })]}>{arrivalGate}</Text>
        </HStack>
        <ProgressView value={progress} />
        <HStack>
          <Text modifiers={[font({ textStyle: 'caption' })]}>{gate}</Text>
          <Text modifiers={[font({ textStyle: 'caption' })]}>{terminal}</Text>
          <Spacer />
          <Text modifiers={[font({ textStyle: 'caption' })]}>{baggage}</Text>
        </HStack>
      </VStack>
    ),
    bannerSmall: (
      <HStack modifiers={[padding({ all: 8 })]}>
        <Text modifiers={[font({ textStyle: 'headline' })]}>{designator}</Text>
        <Spacer />
        <Text date={arrives} dateStyle="time" modifiers={[monospacedDigit()]} />
      </HStack>
    ),
    compactLeading: <Image systemName="airplane" />,
    compactTrailing: <Text date={arrives} dateStyle="time" modifiers={[monospacedDigit()]} />,
    minimal: <Image systemName="airplane" />,
    expandedLeading: <Text modifiers={[font({ textStyle: 'headline' })]}>{designator}</Text>,
    expandedTrailing: <Text modifiers={[font({ textStyle: 'caption' })]}>{caption}</Text>,
    expandedCenter: <Text modifiers={[font({ textStyle: 'subheadline' })]}>{route}</Text>,
    expandedBottom: (
      <VStack>
        <ProgressView value={progress} />
        <HStack>
          <Text date={departs} dateStyle="time" modifiers={[monospacedDigit()]} />
          <Text modifiers={[font({ textStyle: 'caption' })]}>{gate}</Text>
          <Spacer />
          <Text date={arrives} dateStyle="time" modifiers={[monospacedDigit()]} />
          <Text modifiers={[font({ textStyle: 'caption' })]}>{arrivalGate}</Text>
        </HStack>
      </VStack>
    ),
  };
}

export const FlightActivity = createLiveActivity<LiveActivityContentStateV1>(
  FLIGHT_ACTIVITY_NAME,
  FlightActivityLayout,
);
