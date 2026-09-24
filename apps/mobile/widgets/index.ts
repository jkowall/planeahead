/**
 * Every expo-widgets layout the app registers (ADR 0008). Importing this module evaluates
 * `createWidget` and `createLiveActivity`, which store each layout string in the App Group where
 * the widget extension reads it; src/lib/live-activity/tokens.ts imports it on launch. A layout
 * nobody registered renders as expo-widgets' red "No layout found" box.
 */

export { PlaceholderWidget, PLACEHOLDER_WIDGET_NAME } from './placeholder';
export { FlightActivity } from './live-activity';
export { FLIGHT_ACTIVITY_NAME } from './content-state';
