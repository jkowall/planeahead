/**
 * Runs before every test file.
 *
 * `@sentry/react-native` starts an interval timer when its module is first evaluated
 * (`AsyncExpiringMap` in its time-to-display tracing), which keeps Jest's worker alive after the
 * suite. No test needs the real SDK: sentry-privacy.test.ts inspects the options handed to
 * `init`, which this mock records.
 */

jest.mock('@sentry/react-native', () => ({
  init: jest.fn(),
  wrap: <T>(component: T): T => component,
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
